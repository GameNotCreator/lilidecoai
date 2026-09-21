import "server-only";

import { v2 as cloudinary, type UploadApiResponse } from "cloudinary";
import { Binary, type Db } from "mongodb";
import sharp from "sharp";

import { selectOutputSize } from "@lili/geometry";

import { isExpired } from "./asset-access";
import { cloudinaryStorageConfigured, serverConfig } from "./config";
import { collections } from "./mongodb";
import { sniffImageMime } from "./image-security";
import { transparencyRatio } from "./simple-composite";
import type { AssetDocument } from "./types";

const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const formatForMime: Record<string, string> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
};
const cloudinaryDeliveryType = "private" as const;

let cloudinaryReady = false;

/**
 * How an asset may be read. `published` is a catalogue image a merchant chose
 * to show publicly; `{ ownerSessionId }` is one visitor session's upload;
 * `organization` is private to the merchant organization.
 */
/**
 * Version of the heuristic cutout: the background sampling, the flood fill,
 * the alpha thresholds and the shadow removal. It is what the corpus's
 * segmentation metric actually measures, and a cutout is built once per
 * product and reused, so a case must record the version its cutout was made
 * with rather than the version running today (PRO-007, phase 0).
 */
export const CUTOUT_VERSION = "cutout-v2";

export type AssetVisibility =
  "published" | "organization" | { ownerSessionId: string };

function visibilityFields(
  visibility: AssetVisibility,
): Pick<AssetDocument, "visibility" | "ownerSessionId"> {
  if (visibility === "published") return { visibility: "published" };
  if (visibility === "organization") return { visibility: "private" };
  return {
    visibility: "private",
    ownerSessionId: visibility.ownerSessionId,
  };
}

/**
 * The visibility an upload made by this request should get: scoped to the
 * visitor session when there is one, to the organization otherwise. Callers
 * pass `tenant.publicSessionId`; nothing here ever returns `published`, which
 * stays a deliberate catalogue decision.
 */
export function privateVisibility(
  publicSessionId: string | undefined,
): AssetVisibility {
  return publicSessionId ? { ownerSessionId: publicSessionId } : "organization";
}

export interface ImageAssetInput {
  organizationId: string;
  kind: AssetDocument["kind"];
  /**
   * Required, never inferred from `kind`: a visitor's own object photo and a
   * merchant's catalogue photo are both `product`, and only one of them may be
   * served to anyone holding the URL. See `asset-access.ts`.
   */
  visibility: AssetVisibility;
  buffer: Buffer;
  contentType: string;
  expiresAt?: Date;
}

export async function validateImage(
  buffer: Buffer,
  contentType: string,
): Promise<{ width: number; height: number }> {
  if (!allowedTypes.has(contentType)) {
    throw new ApiInputError("Format accepté: JPEG, PNG ou WebP");
  }
  if (buffer.length === 0 || buffer.length > serverConfig.maxUploadBytes) {
    throw new ApiInputError(
      `Image trop volumineuse: maximum ${Math.floor(serverConfig.maxUploadBytes / 1_000_000)} Mo`,
    );
  }
  if (sniffImageMime(buffer) !== contentType) {
    throw new ApiInputError(
      "Le contenu réel de l’image ne correspond pas au format annoncé",
    );
  }
  const metadata = await sharp(buffer, {
    failOn: "error",
    limitInputPixels: 40_000_000,
  }).metadata();
  if (!metadata.format || metadata.format !== formatForMime[contentType]) {
    throw new ApiInputError(
      "Le contenu réel de l’image ne correspond pas au format annoncé",
    );
  }
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width < 320 || height < 320) {
    throw new ApiInputError("L’image doit mesurer au moins 320 × 320 px");
  }
  return { width, height };
}

export async function normalizeImage(
  buffer: Buffer,
  maxDimension = 2048,
): Promise<Buffer> {
  return sharp(buffer, { failOn: "error" })
    .rotate()
    .resize({
      width: maxDimension,
      height: maxDimension,
      fit: "inside",
      withoutEnlargement: true,
    })
    .toColourspace("srgb")
    .webp({ quality: 92, smartSubsample: true, effort: 5 })
    .toBuffer();
}

/**
 * Model-based isolation fallback for photos where the local heuristic cannot
 * separate the product from a busy background: gpt-image-2 re-renders the
 * product alone on a transparent background. Returns null when unavailable or
 * when the result is not meaningfully transparent — callers keep the
 * heuristic cutout in that case.
 */
export async function isolateProductWithModel(
  buffer: Buffer,
  idempotencyKey: string,
): Promise<Buffer | null> {
  if (serverConfig.aiMockMode || !serverConfig.openaiApiKey) return null;
  try {
    const { data: source, info } = await sharp(buffer)
      .rotate()
      .png()
      .toBuffer({ resolveWithObject: true });
    const size = selectOutputSize(info.width, info.height);
    const body = new FormData();
    body.append("model", serverConfig.openaiModel);
    body.append(
      "image[]",
      new Blob([new Uint8Array(source)], { type: "image/png" }),
      "product-photo.png",
    );
    body.append(
      "prompt",
      [
        "Extract the single main product from this photo onto a fully transparent background.",
        "Reproduce the product pixel-faithfully: same shape, proportions, colors, materials, texture and details, same camera angle. Do not restyle it and do not crop any part of it.",
        "Remove absolutely everything else: background, supporting surface, shadows, reflections, hands, packaging and props. Only the product remains, surrounded by transparency.",
      ].join(" "),
    );
    body.append("quality", "medium");
    body.append("size", size);
    body.append("background", "transparent");
    body.append("output_format", "png");
    const response = await fetch(`${serverConfig.openaiBaseUrl}/images/edits`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serverConfig.openaiApiKey}`,
        "Idempotency-Key": idempotencyKey,
      },
      body,
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      data?: Array<{ b64_json?: string }>;
    };
    const encoded = payload.data?.[0]?.b64_json;
    if (!encoded) return null;
    const isolated = Buffer.from(encoded, "base64");
    if ((await transparencyRatio(isolated)) < 0.08) return null;
    return isolated;
  } catch (reason) {
    console.error("Model-based product isolation failed", reason);
    return null;
  }
}

/** Per-cutout diagnostics; every flag but `ragged` asks for model isolation. */
export interface CutoutQualityFlags {
  /** Nothing was removed: the cutout is still a full opaque rectangle. */
  opaque: boolean;
  /** Too much of the silhouette sits in the soft alpha band. */
  ragged: boolean;
  /** The silhouette is eaten through: closing it back gains a lot of area. */
  hollowed: boolean;
  /** A background-coloured pocket survives inside the silhouette. */
  enclosedBackground: boolean;
  /** A contact shadow was detected but was too ambiguous to erase. */
  shadowBand: boolean;
  /** The corner background is too varied for a flood fill to be safe. */
  busyBackground: boolean;
  /**
   * Nothing solid survived: the product was erased outright, or is left so
   * uniformly translucent that it would render as a ghost. Either way the
   * customer would pay for a render of their empty room.
   */
  vanished: boolean;
}

export interface CutoutResult {
  /** Trimmed lossless RGBA webp; product texture is not recompressed. */
  buffer: Buffer;
  widthPx: number;
  heightPx: number;
  /** (0,1]: row of the trimmed cutout where the object meets its support. */
  baseRowFraction: number;
  shadowRemoved: boolean;
  quality: CutoutQualityFlags;
  /** French, user-facing. */
  warnings: string[];
  needsModelIsolation: boolean;
}

/**
 * Raised from 1400: the stored asset is 2048 px, and compositing used to
 * upscale the cutout back up, which softened every product edge.
 */
const CUTOUT_MAX_DIMENSION = 2048;
/** Above this share of non-opaque pixels the input already carries a matte. */
const MATTE_RATIO = 0.01;
const BACKGROUND_VARIATION_LIMIT = 34;
const BACKGROUND_MAX_DISTANCE = 78;
const BACKGROUND_SOFT_FLOOR = 18;
const BACKGROUND_SOFT_SPAN = 52;
const COMPONENT_ALPHA_THRESHOLD = 40;
const COMPONENT_AREA_RATIO = 0.002;
const COMPONENT_BBOX_PAD_RATIO = 0.02;
const DECONTAMINATION_RADIUS = 3;
const RING_MIN_ALPHA = 128;
const OPAQUE_ALPHA = 250;
const SHADOW_OPAQUE_ALPHA = 200;
const SHADOW_STRONG_RATIO = 0.85;
const SHADOW_AMBIGUOUS_RATIO = 0.6;
const SHADOW_MIN_ROWS = 3;
const SHADOW_MIN_HEIGHT_RATIO = 0.04;
const SHADOW_MAX_CHROMA = 16;
const SHADOW_MIN_LIGHTNESS = 100;
const SHADOW_BACKGROUND_MARGIN = 12;
const SHADOW_BODY_MARGIN = 20;
const SHADOW_MAX_GRADIENT = 20;
/** A contact shadow may not span more than this fraction of the object. */
const SHADOW_MAX_HEIGHT_RATIO = 0.2;
/**
 * Below this share of solidly opaque pixels the cutout has no body left. A
 * legitimate cutout measures around 0.99, a heavy vignette around 0.23; a
 * product whose colour matched its background measures 0.
 */
const MIN_SOLID_RATIO = 0.05;
/**
 * A row counts as the contact row once its widest opaque run reaches this
 * fraction of the object's widest run. Deliberately small: a chair stands on
 * thin legs and a vase can taper to a point, and anything larger would place
 * the contact well above the real base and sink the object into the surface.
 * Stray specks are already gone by here, removed by the component pruning.
 */
const BASE_ROW_RUN_RATIO = 0.05;
const RAGGED_RATIO = 0.08;
const HOLLOW_GAIN = 0.12;
const ENCLOSED_AREA_RATIO = 0.005;
const ENCLOSED_MAX_DISTANCE = 18;
const ENCLOSED_MEAN_TOLERANCE = 12;
const ENCLOSED_MAX_DEVIATION = 8;
const TRIM_ALPHA = 2;

const WARNING_RAGGED =
  "Détourage imparfait : reprenez la photo sur un fond uni et bien éclairé.";
const WARNING_BUSY =
  "Fond chargé : un détourage précis est nécessaire avant la mise en scène.";
const WARNING_SHADOW = "Ombre de contact détectée sous l’objet.";
const WARNING_OPAQUE =
  "Le fond n’a pas pu être séparé de l’objet. Utilisez une photo sur fond uni.";
const WARNING_VANISHED =
  "L’objet se confond avec le fond de sa photo : reprenez-la sur un fond bien contrasté.";
const WARNING_ENCLOSED =
  "Fond visible à l’intérieur du produit : le détourage doit être affiné.";

interface BackgroundColor {
  red: number;
  green: number;
  blue: number;
  variation: number;
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Deterministic local cutout: flood fill, component cleanup, alpha
 * decontamination, contact-shadow separation and quality scoring. Everything
 * happens in one RAW RGBA pass in JavaScript — sharp reorders its own
 * operations internally (`.blur().threshold()` thresholds first) and forbids
 * mixing `removeAlpha()` with `joinChannel()`, so morphology and channel maths
 * must never be expressed as a sharp pipeline. sharp is re-entered only to
 * decode and to encode.
 */
export async function prepareCutout(buffer: Buffer): Promise<CutoutResult> {
  const normalized = await sharp(buffer, { failOn: "error" })
    .rotate()
    .resize({
      width: CUTOUT_MAX_DIMENSION,
      height: CUTOUT_MAX_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels: Uint8Array = normalized.data;
  const width = normalized.info.width;
  const height = normalized.info.height;
  const pixelCount = width * height;

  let transparentPixels = 0;
  for (let offset = 3; offset < pixels.length; offset += 4) {
    if ((pixels[offset] ?? 255) < 245) transparentPixels += 1;
  }
  // Rounded photo exports have alpha in the corners but still contain the
  // entire photographic background. Four opaque straight sides distinguish
  // that frame from an actual silhouette; alpha percentage alone cannot.
  const alreadyMatte =
    transparentPixels >= pixelCount * MATTE_RATIO &&
    !hasOpaquePhotoFrame(pixels, width, height);

  const background = estimateCornerBackground(pixels, width, height);
  let busyBackground = false;
  let removalApplied = false;
  if (!alreadyMatte) {
    if (background.variation > BACKGROUND_VARIATION_LIMIT) {
      // A flood fill on a textured background eats the product itself.
      busyBackground = true;
    } else {
      removeConnectedBackground(pixels, width, height, background);
      removalApplied = true;
    }
  }

  pruneComponents(pixels, width, height);
  if (removalApplied) {
    decontaminateEdges(pixels, width, height, background);
  }

  const objectBounds = alphaBounds(
    pixels,
    width,
    height,
    COMPONENT_ALPHA_THRESHOLD,
  );
  // An existing matte carries no measured backdrop. RGB under transparent
  // pixels is arbitrary; using it to classify a grey product base as a shadow
  // can amputate the product and change both its aspect and contact point.
  const shadow = removalApplied
    ? removeContactShadow(pixels, width, height, background, objectBounds)
    : { removed: false, ambiguous: false };
  // Only meaningful when a real, border-connected background was measured and
  // removed: on an already-matted upload the corner colour is the transparent
  // void, and every dark region of the product would match it.
  const enclosedBackground =
    removalApplied && hasEnclosedBackground(pixels, width, height, background);
  fillTransparentColors(pixels, width, height);

  const trimmed = alphaBounds(pixels, width, height, TRIM_ALPHA) ?? {
    minX: 0,
    minY: 0,
    maxX: width - 1,
    maxY: height - 1,
  };
  const trimmedWidth = trimmed.maxX - trimmed.minX + 1;
  const trimmedHeight = trimmed.maxY - trimmed.minY + 1;
  const cropped = Buffer.allocUnsafe(trimmedWidth * trimmedHeight * 4);
  for (let y = 0; y < trimmedHeight; y += 1) {
    const from = ((trimmed.minY + y) * width + trimmed.minX) * 4;
    cropped.set(
      pixels.subarray(from, from + trimmedWidth * 4),
      y * trimmedWidth * 4,
    );
  }

  const encoded = await sharp(cropped, {
    raw: { width: trimmedWidth, height: trimmedHeight, channels: 4 },
  })
    .webp({ lossless: true, alphaQuality: 100 })
    .toBuffer();

  const alpha = new Uint8Array(trimmedWidth * trimmedHeight);
  for (let index = 0; index < alpha.length; index += 1) {
    alpha[index] = cropped[index * 4 + 3] ?? 0;
  }

  // Measured on the FULL frame, before the crop. After cropping to the alpha
  // bounds a perfectly cut rug, picture frame or wardrobe is a solid
  // rectangle, so measuring here would send every rectangular product to the
  // paid model and replace the merchant's real pixels with a redrawing.
  let framedTransparent = 0;
  for (let offset = 3; offset < pixels.length; offset += 4) {
    if ((pixels[offset] ?? 255) < 245) framedTransparent += 1;
  }
  const framedTransparency =
    pixelCount === 0 ? 0 : framedTransparent / pixelCount;

  // Measured after every pass that can erase pixels, including the contact
  // shadow: a product that matched its background is gone by now, and one
  // that barely differed from it is left uniformly semi-transparent. Neither
  // trips `ragged`, which is deliberately not a model-isolation trigger.
  let solidPixels = 0;
  for (let index = 0; index < alpha.length; index += 1) {
    if ((alpha[index] ?? 0) >= OPAQUE_ALPHA) solidPixels += 1;
  }
  const vanished =
    alphaBounds(
      cropped,
      trimmedWidth,
      trimmedHeight,
      COMPONENT_ALPHA_THRESHOLD,
    ) === null || solidPixels < alpha.length * MIN_SOLID_RATIO;

  const quality: CutoutQualityFlags = {
    opaque: framedTransparency < 0.05,
    ragged: raggedRatio(alpha) > RAGGED_RATIO,
    hollowed:
      closingGain(
        alpha,
        trimmedWidth,
        trimmedHeight,
        COMPONENT_ALPHA_THRESHOLD,
      ) > HOLLOW_GAIN,
    enclosedBackground,
    shadowBand: shadow.ambiguous,
    busyBackground,
    vanished,
  };

  const baseRow = findBaseRow(alpha, trimmedWidth, trimmedHeight);
  const baseRowFraction = Math.min(
    1,
    Math.max(0.05 + Number.EPSILON, (baseRow + 1) / trimmedHeight),
  );

  const warnings: string[] = [];
  if (quality.ragged || quality.hollowed) warnings.push(WARNING_RAGGED);
  if (quality.busyBackground) warnings.push(WARNING_BUSY);
  else if (quality.opaque) warnings.push(WARNING_OPAQUE);
  if (quality.enclosedBackground) warnings.push(WARNING_ENCLOSED);
  if (quality.shadowBand) warnings.push(WARNING_SHADOW);
  if (quality.vanished) warnings.push(WARNING_VANISHED);

  return {
    buffer: encoded,
    widthPx: trimmedWidth,
    heightPx: trimmedHeight,
    baseRowFraction,
    shadowRemoved: shadow.removed,
    quality,
    warnings,
    needsModelIsolation:
      quality.opaque ||
      quality.hollowed ||
      quality.enclosedBackground ||
      quality.shadowBand ||
      quality.busyBackground ||
      quality.vanished,
  };
}

export async function createCutout(buffer: Buffer): Promise<Buffer> {
  return (await prepareCutout(buffer)).buffer;
}

function removeConnectedBackground(
  pixels: Uint8Array,
  width: number,
  height: number,
  background: BackgroundColor,
): void {
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  const enqueue = (x: number, y: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const index = y * width + x;
    if (visited[index]) return;
    const offset = index * 4;
    const distance =
      (pixels[offset + 3] ?? 255) < 245
        ? 0
        : colorDistance(pixels, offset, background);
    if (distance > BACKGROUND_MAX_DISTANCE) return;
    visited[index] = 1;
    queue[tail] = index;
    tail += 1;
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x, 0);
    enqueue(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(0, y);
    enqueue(width - 1, y);
  }

  while (head < tail) {
    const index = queue[head] ?? 0;
    head += 1;
    const x = index % width;
    const y = Math.floor(index / width);
    const offset = index * 4;
    const distance = colorDistance(pixels, offset, background);
    const softAlpha = Math.round(
      clamp01((distance - BACKGROUND_SOFT_FLOOR) / BACKGROUND_SOFT_SPAN) * 255,
    );
    pixels[offset + 3] = Math.min(pixels[offset + 3] ?? 255, softAlpha);
    enqueue(x - 1, y);
    enqueue(x + 1, y);
    enqueue(x, y - 1);
    enqueue(x, y + 1);
  }
}

function hasOpaquePhotoFrame(
  pixels: Uint8Array,
  width: number,
  height: number,
): boolean {
  const sideCoverage = (horizontal: boolean, far: boolean): number => {
    const length = horizontal ? width : height;
    const start = Math.floor(length * 0.25);
    const end = Math.ceil(length * 0.75);
    let opaque = 0;
    for (let n = start; n < end; n += 1) {
      const x = horizontal ? n : far ? width - 1 : 0;
      const y = horizontal ? (far ? height - 1 : 0) : n;
      if ((pixels[(y * width + x) * 4 + 3] ?? 0) >= 245) opaque += 1;
    }
    return opaque / Math.max(1, end - start);
  };
  return [
    sideCoverage(true, false),
    sideCoverage(true, true),
    sideCoverage(false, false),
    sideCoverage(false, true),
  ].every((coverage) => coverage > 0.8);
}

function estimateCornerBackground(
  pixels: Uint8Array,
  width: number,
  height: number,
): BackgroundColor {
  const samples: Array<[number, number, number]> = [];
  // Ignore invisible RGB. Rounded corners may contain no visible pixels in
  // the first patch; expand once to reach the actual photographic backdrop.
  for (const fraction of [0.06, 0.2]) {
    const sampleWidth = Math.min(
      width,
      Math.max(4, Math.round(width * fraction)),
    );
    const sampleHeight = Math.min(
      height,
      Math.max(4, Math.round(height * fraction)),
    );
    for (let y = 0; y < sampleHeight; y += 1) {
      for (let x = 0; x < sampleWidth; x += 1) {
        const corners: Array<readonly [number, number]> = [
          [x, y],
          [width - 1 - x, y],
          [x, height - 1 - y],
          [width - 1 - x, height - 1 - y],
        ];
        for (const [sampleX, sampleY] of corners) {
          const offset = (sampleY * width + sampleX) * 4;
          if ((pixels[offset + 3] ?? 0) < 245) continue;
          samples.push([
            pixels[offset] ?? 0,
            pixels[offset + 1] ?? 0,
            pixels[offset + 2] ?? 0,
          ]);
        }
      }
    }
    if (samples.length >= 16) break;
  }
  if (samples.length === 0) {
    return { red: 0, green: 0, blue: 0, variation: Infinity };
  }
  const average = samples.reduce(
    (sum, sample) => [
      sum[0] + sample[0],
      sum[1] + sample[1],
      sum[2] + sample[2],
    ],
    [0, 0, 0],
  );
  const red = average[0] / samples.length;
  const green = average[1] / samples.length;
  const blue = average[2] / samples.length;
  const variation = Math.sqrt(
    samples.reduce(
      (sum, sample) =>
        sum +
        ((sample[0] - red) ** 2 +
          (sample[1] - green) ** 2 +
          (sample[2] - blue) ** 2) /
          3,
      0,
    ) / samples.length,
  );
  return { red, green, blue, variation };
}

function colorDistance(
  pixels: Uint8Array,
  offset: number,
  color: { red: number; green: number; blue: number },
): number {
  return Math.sqrt(
    ((pixels[offset] ?? 0) - color.red) ** 2 +
      ((pixels[offset + 1] ?? 0) - color.green) ** 2 +
      ((pixels[offset + 2] ?? 0) - color.blue) ** 2,
  );
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function distanceBetween(
  a: { red: number; green: number; blue: number },
  b: { red: number; green: number; blue: number },
): number {
  return Math.sqrt(
    (a.red - b.red) ** 2 + (a.green - b.green) ** 2 + (a.blue - b.blue) ** 2,
  );
}

function lightnessOf(red: number, green: number, blue: number): number {
  return 0.299 * red + 0.587 * green + 0.114 * blue;
}

function chromaOf(red: number, green: number, blue: number): number {
  return Math.max(red, green, blue) - Math.min(red, green, blue);
}

interface ComponentStats {
  area: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * 8- or 4-connected labelling of a binary mask. Explicit JS: sharp has no
 * morphology primitive whose ordering can be trusted inside a pipeline.
 */
function labelComponents(
  mask: Uint8Array,
  width: number,
  height: number,
  diagonal: boolean,
): { labels: Int32Array; stats: ComponentStats[] } {
  const labels = new Int32Array(width * height).fill(-1);
  const stats: ComponentStats[] = [];
  const queue = new Int32Array(width * height);
  for (let seed = 0; seed < mask.length; seed += 1) {
    if (!mask[seed] || labels[seed] !== -1) continue;
    const label = stats.length;
    const stat: ComponentStats = {
      area: 0,
      minX: width,
      minY: height,
      maxX: -1,
      maxY: -1,
    };
    let head = 0;
    let tail = 0;
    labels[seed] = label;
    queue[tail] = seed;
    tail += 1;
    while (head < tail) {
      const index = queue[head] ?? 0;
      head += 1;
      const x = index % width;
      const y = (index - x) / width;
      stat.area += 1;
      if (x < stat.minX) stat.minX = x;
      if (x > stat.maxX) stat.maxX = x;
      if (y < stat.minY) stat.minY = y;
      if (y > stat.maxY) stat.maxY = y;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          if (!diagonal && dx !== 0 && dy !== 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const neighbour = ny * width + nx;
          if (!mask[neighbour] || labels[neighbour] !== -1) continue;
          labels[neighbour] = label;
          queue[tail] = neighbour;
          tail += 1;
        }
      }
    }
    stats.push(stat);
  }
  return { labels, stats };
}

/**
 * Drops specks, price labels and corner residue: keep the largest component
 * plus anything either substantial or close enough to it to be a foot, a cable
 * or a lamp cord. Runs before trimming so the bounding box is the product's.
 */
function pruneComponents(
  pixels: Uint8Array,
  width: number,
  height: number,
): void {
  const mask = new Uint8Array(width * height);
  for (let index = 0; index < mask.length; index += 1) {
    mask[index] =
      (pixels[index * 4 + 3] ?? 0) > COMPONENT_ALPHA_THRESHOLD ? 1 : 0;
  }
  const { labels, stats } = labelComponents(mask, width, height, true);
  if (stats.length === 0) return;

  let largest = 0;
  for (let index = 1; index < stats.length; index += 1) {
    if ((stats[index]?.area ?? 0) > (stats[largest]?.area ?? 0))
      largest = index;
  }
  const main = stats[largest];
  if (!main) return;
  const pad = Math.round(COMPONENT_BBOX_PAD_RATIO * Math.min(width, height));
  const keep = new Uint8Array(stats.length);
  for (let index = 0; index < stats.length; index += 1) {
    const stat = stats[index];
    if (!stat) continue;
    const nearMain =
      stat.maxX >= main.minX - pad &&
      stat.minX <= main.maxX + pad &&
      stat.maxY >= main.minY - pad &&
      stat.minY <= main.maxY + pad;
    keep[index] =
      index === largest ||
      stat.area >= main.area * COMPONENT_AREA_RATIO ||
      nearMain
        ? 1
        : 0;
  }

  const kept = new Uint8Array(width * height);
  for (let index = 0; index < kept.length; index += 1) {
    const label = labels[index] ?? -1;
    if (label < 0) continue;
    if (keep[label]) kept[index] = 1;
    else pixels[index * 4 + 3] = 0;
  }

  // The faint halo of a dropped speck sits below the labelling threshold, so
  // sweep any sub-threshold pixel that no longer touches a kept component.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const alpha = pixels[index * 4 + 3] ?? 0;
      if (alpha === 0 || alpha > COMPONENT_ALPHA_THRESHOLD) continue;
      let attached = false;
      for (let dy = -1; dy <= 1 && !attached; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          if (kept[ny * width + nx]) {
            attached = true;
            break;
          }
        }
      }
      if (!attached) pixels[index * 4 + 3] = 0;
    }
  }
}

/**
 * Unmixes the background out of the soft alpha band so the halo carries the
 * product's own colour: `C = a*F + (1-a)*B` solved for F, with S the local
 * foreground estimate. Without this the cutout keeps a pale fringe that the
 * compositing resample smears into the room.
 */
function decontaminateEdges(
  pixels: Uint8Array,
  width: number,
  height: number,
  background: BackgroundColor,
): void {
  const source = new Uint8Array(pixels);
  const total = width * height;
  const targets = new Uint8Array(total);
  for (let index = 0; index < total; index += 1) {
    const alpha = source[index * 4 + 3] ?? 0;
    if (alpha > 0 && alpha < 255) targets[index] = 1;
  }
  // …plus the 1 px opaque ring that touches anything non-opaque, which is
  // where a hard-edged flood fill leaves its own contamination.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if ((source[index * 4 + 3] ?? 0) !== 255) continue;
      let border = false;
      for (let dy = -1; dy <= 1 && !border; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          if ((source[(ny * width + nx) * 4 + 3] ?? 0) < 255) {
            border = true;
            break;
          }
        }
      }
      if (border) targets[index] = 2;
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const kind = targets[index] ?? 0;
      if (!kind) continue;
      let sumRed = 0;
      let sumGreen = 0;
      let sumBlue = 0;
      let samples = 0;
      for (
        let dy = -DECONTAMINATION_RADIUS;
        dy <= DECONTAMINATION_RADIUS;
        dy += 1
      ) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (
          let dx = -DECONTAMINATION_RADIUS;
          dx <= DECONTAMINATION_RADIUS;
          dx += 1
        ) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const offset = (ny * width + nx) * 4;
          if ((source[offset + 3] ?? 0) < OPAQUE_ALPHA) continue;
          if (
            colorDistance(source, offset, background) <= BACKGROUND_MAX_DISTANCE
          )
            continue;
          sumRed += source[offset] ?? 0;
          sumGreen += source[offset + 1] ?? 0;
          sumBlue += source[offset + 2] ?? 0;
          samples += 1;
        }
      }
      if (samples === 0) continue;
      const foreground = {
        red: sumRed / samples,
        green: sumGreen / samples,
        blue: sumBlue / samples,
      };

      const offset = index * 4;
      const distance = colorDistance(source, offset, background);
      const span = Math.max(
        24,
        distanceBetween(foreground, background) - BACKGROUND_SOFT_FLOOR,
      );
      const opacity = clamp01((distance - BACKGROUND_SOFT_FLOOR) / span);
      const channels: Array<"red" | "green" | "blue"> = [
        "red",
        "green",
        "blue",
      ];
      for (let channel = 0; channel < 3; channel += 1) {
        const key = channels[channel] ?? "red";
        const mixed = source[offset + channel] ?? 0;
        let value =
          opacity <= 0.004
            ? foreground[key]
            : (mixed - (1 - opacity) * background[key]) / opacity;
        value = Math.max(0, Math.min(255, value));
        // A nearly transparent sample carries almost no foreground signal, so
        // lean it back towards the local product colour instead of amplifying
        // quantisation noise.
        if (opacity < 0.35) value = (value + foreground[key]) / 2;
        pixels[offset + channel] = Math.round(value);
      }
      const alpha = Math.round(opacity * 255);
      pixels[offset + 3] =
        kind === 2 ? Math.max(RING_MIN_ALPHA, alpha) : Math.min(255, alpha);
    }
  }
}

/**
 * Gives every fully transparent pixel the colour of its nearest opaque
 * neighbour so bilinear resampling at compose time cannot pull background
 * colour back into the halo.
 */
function fillTransparentColors(
  pixels: Uint8Array,
  width: number,
  height: number,
): void {
  const total = width * height;
  const queue = new Int32Array(total);
  const visited = new Uint8Array(total);
  let head = 0;
  let tail = 0;
  for (let index = 0; index < total; index += 1) {
    if ((pixels[index * 4 + 3] ?? 0) > 0) {
      visited[index] = 1;
      queue[tail] = index;
      tail += 1;
    }
  }
  if (tail === 0) return;
  while (head < tail) {
    const index = queue[head] ?? 0;
    head += 1;
    const x = index % width;
    const y = (index - x) / width;
    const offset = index * 4;
    for (let step = 0; step < 4; step += 1) {
      const nx = x + (step === 0 ? -1 : step === 1 ? 1 : 0);
      const ny = y + (step === 2 ? -1 : step === 3 ? 1 : 0);
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const neighbour = ny * width + nx;
      if (visited[neighbour]) continue;
      visited[neighbour] = 1;
      const target = neighbour * 4;
      pixels[target] = pixels[offset] ?? 0;
      pixels[target + 1] = pixels[offset + 1] ?? 0;
      pixels[target + 2] = pixels[offset + 2] ?? 0;
      queue[tail] = neighbour;
      tail += 1;
    }
  }
}

function alphaBounds(
  pixels: Uint8Array,
  width: number,
  height: number,
  threshold: number,
): Bounds | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((pixels[(y * width + x) * 4 + 3] ?? 0) < threshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

/**
 * Separates the contact shadow the product casts on its shooting surface.
 * Only attempted on a neutral, light background — anywhere else a dark band is
 * as likely to be part of the product. On top of the published criteria a row
 * must also be clearly darker than the product body, otherwise a light grey
 * product on white reads as its own shadow and gets its base amputated.
 */
function removeContactShadow(
  pixels: Uint8Array,
  width: number,
  height: number,
  background: BackgroundColor,
  box: Bounds | null,
): { removed: boolean; ambiguous: boolean } {
  if (!box) return { removed: false, ambiguous: false };
  const backgroundLightness = lightnessOf(
    background.red,
    background.green,
    background.blue,
  );
  if (
    chromaOf(background.red, background.green, background.blue) > 20 ||
    backgroundLightness < 170
  ) {
    return { removed: false, ambiguous: false };
  }
  const boxHeight = box.maxY - box.minY + 1;
  if (boxHeight < 12) return { removed: false, ambiguous: false };

  const lightnessAt = (x: number, y: number): number => {
    const offset = (y * width + x) * 4;
    return lightnessOf(
      pixels[offset] ?? 0,
      pixels[offset + 1] ?? 0,
      pixels[offset + 2] ?? 0,
    );
  };

  const histogram = new Uint32Array(256);
  let bodySamples = 0;
  const bodyBottom = box.minY + Math.floor((boxHeight * 2) / 3);
  for (let y = box.minY; y < bodyBottom; y += 1) {
    for (let x = box.minX; x <= box.maxX; x += 1) {
      const offset = (y * width + x) * 4;
      if ((pixels[offset + 3] ?? 0) < SHADOW_OPAQUE_ALPHA) continue;
      const bin = Math.min(255, Math.max(0, Math.round(lightnessAt(x, y))));
      histogram[bin] = (histogram[bin] ?? 0) + 1;
      bodySamples += 1;
    }
  }
  let bodyLightness = backgroundLightness;
  if (bodySamples > 0) {
    let seen = 0;
    for (let bin = 0; bin < 256; bin += 1) {
      seen += histogram[bin] ?? 0;
      if (seen * 2 >= bodySamples) {
        bodyLightness = bin;
        break;
      }
    }
  }
  // A contact shadow is darker than the background AND distinguishable from
  // the product's own body — in either direction. Capping at
  // `bodyLightness - margin` instead would only ever find a shadow darker
  // than the product, so a dark vase on white kept its light grey shadow,
  // which then widened the cutout and pushed the measured base row below the
  // object's real base.
  const lightnessCeiling = backgroundLightness - SHADOW_BACKGROUND_MARGIN;

  const start = box.minY + Math.floor((boxHeight * 2) / 3);
  // Two readings per row: the colour test alone, and the colour test plus the
  // flatness test. A band's own first and last row always sit on a lightness
  // step, so flatness may only seed a run, never bound it.
  const colorRatios = new Float64Array(height);
  const flatRows = new Uint8Array(height);
  for (let y = start; y <= box.maxY; y += 1) {
    let opaque = 0;
    let shadowLike = 0;
    let flat = 0;
    for (let x = box.minX; x <= box.maxX; x += 1) {
      const offset = (y * width + x) * 4;
      if ((pixels[offset + 3] ?? 0) < SHADOW_OPAQUE_ALPHA) continue;
      opaque += 1;
      const red = pixels[offset] ?? 0;
      const green = pixels[offset + 1] ?? 0;
      const blue = pixels[offset + 2] ?? 0;
      if (chromaOf(red, green, blue) > SHADOW_MAX_CHROMA) continue;
      const lightness = lightnessOf(red, green, blue);
      if (lightness < SHADOW_MIN_LIGHTNESS || lightness > lightnessCeiling)
        continue;
      // Same lightness as the product body: this is the product, not its
      // shadow. This is what keeps a flat light-grey product intact.
      if (Math.abs(lightness - bodyLightness) < SHADOW_BODY_MARGIN) continue;
      shadowLike += 1;
      const gradient =
        Math.abs(
          lightnessAt(Math.max(0, x - 1), y) -
            lightnessAt(Math.min(width - 1, x + 1), y),
        ) +
        Math.abs(
          lightnessAt(x, Math.max(0, y - 1)) -
            lightnessAt(x, Math.min(height - 1, y + 1)),
        );
      if (gradient <= SHADOW_MAX_GRADIENT) flat += 1;
    }
    if (opaque < 4) continue;
    colorRatios[y] = shadowLike / opaque;
    flatRows[y] = flat / opaque >= SHADOW_STRONG_RATIO ? 1 : 0;
  }

  const minRows = Math.max(
    SHADOW_MIN_ROWS,
    Math.ceil(boxHeight * SHADOW_MIN_HEIGHT_RATIO),
  );

  const runFrom = (floor: number): { top: number; bottom: number } | null => {
    // The run has to reach the bottom of the object: that is what "connected
    // to the already-transparent background" means for a band on the floor.
    let bottom = box.maxY;
    while (bottom > start && (colorRatios[bottom] ?? 0) < floor) bottom -= 1;
    if ((colorRatios[bottom] ?? 0) < floor || bottom < box.maxY - 2)
      return null;
    let top = bottom;
    while (top > start && (colorRatios[top - 1] ?? 0) >= floor) top -= 1;
    return bottom - top + 1 >= minRows ? { top, bottom } : null;
  };

  // A contact shadow is a thin band under the object. Anything taller is the
  // product's own base being read as its shadow: measured amputations removed
  // a quarter to a third of the silhouette, and in height_length mode
  // `w = h x aspect`, so losing 27 % of the rows renders the object 37 % too
  // wide. A cutout defect IS a scale defect.
  const maxBandRows = Math.max(
    SHADOW_MIN_ROWS,
    Math.floor(boxHeight * SHADOW_MAX_HEIGHT_RATIO),
  );
  const withinBandCap = (run: { top: number; bottom: number }): boolean =>
    run.bottom - run.top + 1 <= maxBandRows;

  const strong = runFrom(SHADOW_STRONG_RATIO);
  if (strong && !withinBandCap(strong)) {
    // Suspiciously tall: report it instead of silently cutting the product.
    return { removed: false, ambiguous: true };
  }
  if (strong) {
    let flat = 0;
    for (let y = strong.top; y <= strong.bottom; y += 1)
      flat += flatRows[y] ?? 0;
    if (flat >= SHADOW_MIN_ROWS) {
      for (let y = strong.top; y <= strong.bottom; y += 1) {
        // Only the object's own columns: clearing the full row width erased
        // unrelated photo content on a busy or wide frame.
        for (let x = box.minX; x <= box.maxX; x += 1) {
          pixels[(y * width + x) * 4 + 3] = 0;
        }
      }
      // ~2 px feather above the erased band so the object does not end on a
      // hard horizontal line.
      for (let step = 1; step <= 2; step += 1) {
        const y = strong.top - step;
        if (y < 0) continue;
        const factor = step / 3;
        for (let x = box.minX; x <= box.maxX; x += 1) {
          const offset = (y * width + x) * 4;
          pixels[offset + 3] = Math.round((pixels[offset + 3] ?? 0) * factor);
        }
      }
      return { removed: true, ambiguous: false };
    }
  }

  return {
    removed: false,
    ambiguous: runFrom(SHADOW_AMBIGUOUS_RATIO) !== null,
  };
}

/**
 * Last row still carrying a substantial opaque run: where the object meets its
 * support, which is the row the compositor anchors on the floor.
 */
function findBaseRow(alpha: Uint8Array, width: number, height: number): number {
  const runs = new Int32Array(height);
  let longest = 0;
  for (let y = 0; y < height; y += 1) {
    let current = 0;
    let best = 0;
    for (let x = 0; x < width; x += 1) {
      if ((alpha[y * width + x] ?? 0) >= OPAQUE_ALPHA) {
        current += 1;
        if (current > best) best = current;
      } else {
        current = 0;
      }
    }
    runs[y] = best;
    if (best > longest) longest = best;
  }
  if (longest === 0) return height - 1;
  const threshold = Math.max(2, longest * BASE_ROW_RUN_RATIO);
  for (let y = height - 1; y >= 0; y -= 1) {
    if ((runs[y] ?? 0) >= threshold) return y;
  }
  return height - 1;
}

function raggedRatio(alpha: Uint8Array): number {
  let soft = 0;
  let visible = 0;
  for (let index = 0; index < alpha.length; index += 1) {
    const value = alpha[index] ?? 0;
    if (value <= 10) continue;
    visible += 1;
    if (value < 245) soft += 1;
  }
  return visible === 0 ? 0 : soft / visible;
}

/**
 * Relative area a morphological closing puts back. A silhouette that gains a
 * lot has been chewed through by the flood fill. Separable square structuring
 * element via running window counts — sharp's blur/threshold pair reorders
 * itself and can never express this.
 */
function closingGain(
  alpha: Uint8Array,
  width: number,
  height: number,
  threshold: number,
): number {
  const radius = Math.max(
    6,
    Math.min(24, Math.round(0.02 * Math.min(width, height))),
  );
  if (width <= 2 || height <= 2) return 0;
  const mask = new Uint8Array(width * height);
  let area = 0;
  for (let index = 0; index < mask.length; index += 1) {
    if ((alpha[index] ?? 0) > threshold) {
      mask[index] = 1;
      area += 1;
    }
  }
  if (area === 0) return 0;
  const closed = erode(
    dilate(mask, width, height, radius),
    width,
    height,
    radius,
  );
  let closedArea = 0;
  for (let index = 0; index < closed.length; index += 1) {
    if (closed[index]) closedArea += 1;
  }
  return (closedArea - area) / area;
}

function windowPass(
  source: Uint8Array,
  width: number,
  height: number,
  radius: number,
  horizontal: boolean,
  full: boolean,
): Uint8Array {
  const target = new Uint8Array(width * height);
  const outer = horizontal ? height : width;
  const inner = horizontal ? width : height;
  const prefix = new Int32Array(inner + 1);
  for (let line = 0; line < outer; line += 1) {
    for (let position = 0; position < inner; position += 1) {
      const index = horizontal
        ? line * width + position
        : position * width + line;
      prefix[position + 1] = (prefix[position] ?? 0) + (source[index] ?? 0);
    }
    for (let position = 0; position < inner; position += 1) {
      const from = Math.max(0, position - radius);
      const to = Math.min(inner - 1, position + radius);
      const sum = (prefix[to + 1] ?? 0) - (prefix[from] ?? 0);
      const index = horizontal
        ? line * width + position
        : position * width + line;
      target[index] = full ? (sum === to - from + 1 ? 1 : 0) : sum > 0 ? 1 : 0;
    }
  }
  return target;
}

function dilate(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  return windowPass(
    windowPass(mask, width, height, radius, true, false),
    width,
    height,
    radius,
    false,
    false,
  );
}

function erode(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  return windowPass(
    windowPass(mask, width, height, radius, true, true),
    width,
    height,
    radius,
    false,
    true,
  );
}

/**
 * Detector only: a flat, background-coloured pocket enclosed by the silhouette
 * (the hole of a ring, the gap under a chair). Never punched locally — a
 * specular highlight looks exactly the same from close up, so the decision is
 * handed to the isolation model instead.
 */
function hasEnclosedBackground(
  pixels: Uint8Array,
  width: number,
  height: number,
  background: BackgroundColor,
): boolean {
  const total = width * height;
  const mask = new Uint8Array(total);
  for (let index = 0; index < total; index += 1) {
    const offset = index * 4;
    if ((pixels[offset + 3] ?? 0) <= COMPONENT_ALPHA_THRESHOLD) continue;
    if (colorDistance(pixels, offset, background) > ENCLOSED_MAX_DISTANCE)
      continue;
    mask[index] = 1;
  }
  const { labels, stats } = labelComponents(mask, width, height, false);
  if (stats.length === 0) return false;

  const minArea = total * ENCLOSED_AREA_RATIO;
  const candidates: number[] = [];
  for (let index = 0; index < stats.length; index += 1) {
    const stat = stats[index];
    if (!stat) continue;
    if (stat.area < minArea) continue;
    if (
      stat.minX === 0 ||
      stat.minY === 0 ||
      stat.maxX === width - 1 ||
      stat.maxY === height - 1
    ) {
      continue;
    }
    candidates.push(index);
  }
  if (candidates.length === 0) return false;

  const sums = new Float64Array(stats.length * 3);
  const counts = new Float64Array(stats.length);
  for (let index = 0; index < total; index += 1) {
    const label = labels[index] ?? -1;
    if (label < 0) continue;
    const offset = index * 4;
    sums[label * 3] = (sums[label * 3] ?? 0) + (pixels[offset] ?? 0);
    sums[label * 3 + 1] =
      (sums[label * 3 + 1] ?? 0) + (pixels[offset + 1] ?? 0);
    sums[label * 3 + 2] =
      (sums[label * 3 + 2] ?? 0) + (pixels[offset + 2] ?? 0);
    counts[label] = (counts[label] ?? 0) + 1;
  }
  const deviations = new Float64Array(stats.length);
  for (let index = 0; index < total; index += 1) {
    const label = labels[index] ?? -1;
    if (label < 0) continue;
    const count = counts[label] ?? 1;
    const offset = index * 4;
    const meanRed = (sums[label * 3] ?? 0) / count;
    const meanGreen = (sums[label * 3 + 1] ?? 0) / count;
    const meanBlue = (sums[label * 3 + 2] ?? 0) / count;
    deviations[label] =
      (deviations[label] ?? 0) +
      (((pixels[offset] ?? 0) - meanRed) ** 2 +
        ((pixels[offset + 1] ?? 0) - meanGreen) ** 2 +
        ((pixels[offset + 2] ?? 0) - meanBlue) ** 2) /
        3;
  }

  for (const label of candidates) {
    const count = counts[label] ?? 1;
    const mean = {
      red: (sums[label * 3] ?? 0) / count,
      green: (sums[label * 3 + 1] ?? 0) / count,
      blue: (sums[label * 3 + 2] ?? 0) / count,
    };
    if (distanceBetween(mean, background) > ENCLOSED_MEAN_TOLERANCE) continue;
    const deviation = Math.sqrt((deviations[label] ?? 0) / count);
    if (deviation >= ENCLOSED_MAX_DEVIATION) continue;
    return true;
  }
  return false;
}

export async function storeAsset(
  db: Db,
  input: ImageAssetInput,
  fixedId = crypto.randomUUID(),
): Promise<AssetDocument> {
  const id = fixedId;
  const base: AssetDocument = {
    id,
    organizationId: input.organizationId,
    kind: input.kind,
    ...visibilityFields(input.visibility),
    contentType: input.contentType,
    size: input.buffer.length,
    createdAt: new Date(),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  };

  if (cloudinaryStorageConfigured()) {
    try {
      const uploaded = await uploadCloudinary(
        input.buffer,
        `${serverConfig.cloudinaryUploadFolder}/${input.organizationId}/${input.kind}/${id}`,
      );
      base.cloudinaryPublicId = uploaded.public_id;
      base.cloudinaryFormat = uploaded.format;
      base.cloudinaryVersion = uploaded.version;
      base.cloudinaryDeliveryType = cloudinaryDeliveryType;
    } catch (reason) {
      console.error("Cloudinary upload failed; using MongoDB fallback", reason);
      base.bytes = new Binary(input.buffer);
    }
  } else {
    base.bytes = new Binary(input.buffer);
  }

  await collections(db).assets.updateOne(
    { id },
    { $set: base },
    { upsert: true },
  );
  return base;
}

/**
 * A17 of the audit: expiry used to be enforced only by the daily purge, so a
 * photo stayed readable for up to a day after the retention it was promised.
 * Reading one is refused as soon as it expires; the cron still decides when
 * the bytes physically go.
 */
export async function readAsset(
  db: Db,
  assetId: string,
): Promise<{ asset: AssetDocument; buffer: Buffer } | null> {
  const asset = await collections(db).assets.findOne({ id: assetId });
  if (!asset) return null;
  if (isExpired(asset)) return null;
  if (asset.bytes) {
    return {
      asset,
      buffer: Buffer.from(asset.bytes.buffer),
    };
  }
  if (!asset.cloudinaryPublicId || !asset.cloudinaryFormat) return null;
  const client = cloudinaryClient();
  const deliveryType = asset.cloudinaryDeliveryType ?? "authenticated";
  const url = client.utils.private_download_url(
    asset.cloudinaryPublicId,
    asset.cloudinaryFormat,
    {
      resource_type: "image",
      type: deliveryType,
      expires_at: Math.floor(Date.now() / 1000) + 300,
      attachment: false,
    },
  );
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) return null;
  const buffer = Buffer.from(await response.arrayBuffer());
  return { asset, buffer };
}

/**
 * Deletes an asset only if it is still expired when the deletion is claimed.
 *
 * The purge selects a batch by `expiresAt <= now` and then destroys each one;
 * between those two steps a merchant restoring an archived product can lift
 * the expiry. The claim below is one atomic update — the winner is whoever
 * flips `purgeClaimedAt`, and a lifted expiry no longer matches, so the image
 * survives.
 *
 * The claim is not a transaction over the bytes: the Cloudinary object is
 * destroyed after it, and an expiry lifted in that last instant loses. Closing
 * that too would need the storage and the metadata under one commit, which
 * this deployment does not have.
 *
 * `deleteAsset` stays unconditional, for deliberate deletions.
 */
export async function deleteExpiredAsset(
  db: Db,
  assetId: string,
  now = new Date(),
): Promise<boolean> {
  const claimed = await collections(db).assets.findOneAndUpdate(
    { id: assetId, expiresAt: { $lte: now } },
    { $set: { purgeClaimedAt: new Date() } },
  );
  if (!claimed) return false;
  await deleteAsset(db, assetId);
  return true;
}

export async function deleteAsset(db: Db, assetId: string): Promise<void> {
  const assets = collections(db).assets;
  const asset = await assets.findOne({ id: assetId });
  if (!asset) return;
  if (asset.cloudinaryPublicId) {
    const deliveryType = asset.cloudinaryDeliveryType ?? "authenticated";
    await cloudinaryClient().uploader.destroy(asset.cloudinaryPublicId, {
      resource_type: "image",
      type: deliveryType,
      invalidate: true,
    });
  }
  await assets.deleteOne({ id: assetId });
}

export function assetUrl(assetId: string | undefined): string | null {
  return assetId ? `/api/assets/${assetId}` : null;
}

function cloudinaryClient(): typeof cloudinary {
  if (cloudinaryReady) return cloudinary;
  if (!cloudinaryStorageConfigured()) {
    throw new Error("Cloudinary n’est pas configuré");
  }

  if (serverConfig.cloudinaryUrl) {
    const url = new URL(serverConfig.cloudinaryUrl);
    if (url.protocol !== "cloudinary:") {
      throw new Error("CLOUDINARY_URL doit commencer par cloudinary://");
    }
    cloudinary.config({
      cloud_name: decodeURIComponent(url.hostname),
      api_key: decodeURIComponent(url.username),
      api_secret: decodeURIComponent(url.password),
      secure: true,
      hide_sensitive: true,
    });
  } else {
    cloudinary.config({
      cloud_name: serverConfig.cloudinaryCloudName,
      api_key: serverConfig.cloudinaryApiKey,
      api_secret: serverConfig.cloudinaryApiSecret,
      secure: true,
      hide_sensitive: true,
    });
  }
  cloudinaryReady = true;
  return cloudinary;
}

function uploadCloudinary(
  buffer: Buffer,
  publicId: string,
): Promise<UploadApiResponse> {
  const client = cloudinaryClient();
  return new Promise((resolve, reject) => {
    const upload = client.uploader.upload_stream(
      {
        public_id: publicId,
        resource_type: "image",
        type: cloudinaryDeliveryType,
        overwrite: true,
        invalidate: true,
      },
      (error, result) => {
        if (error) return reject(error);
        if (!result) return reject(new Error("Réponse Cloudinary vide"));
        resolve(result);
      },
    );
    upload.end(buffer);
  });
}

export class ApiInputError extends Error {}
