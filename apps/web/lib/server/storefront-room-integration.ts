import sharp from "sharp";
import type { PaddedComposition, SimpleComposition } from "./simple-composite";
import type { StorefrontPerspectiveGuideObject } from "./storefront-perspective-guide";

export const STOREFRONT_ROOM_INTEGRATION_COMPOSITE_VERSION =
  "storefront-room-integration-v5";
export const STOREFRONT_LOCAL_ROOM_INTEGRATION_COMPOSITE_VERSION =
  "storefront-room-local-integration-v6";
export const STOREFRONT_ROOM_REFINEMENT_COMPOSITE_VERSION =
  "storefront-room-refinement-region-v1";
export const STOREFRONT_NATIVE_ROOM_REFINEMENT_FRAME_VERSION =
  "storefront-room-refinement-native-frame-v1";
export const STOREFRONT_NATIVE_ROOM_REFINEMENT_GUIDE_VERSION =
  "storefront-room-refinement-native-guide-v2";

export interface NativeRoomRefinementFrame {
  image: Buffer;
  maskPng: Buffer;
  frame: { width: number; height: number };
  /** One uniform source-padded to native-image transform, before raster rounding. */
  scale: number;
  padding: { x: number; y: number };
}

export interface StorefrontRoomIntegrationWindow {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface StorefrontLocalRoomIntegration {
  composition: SimpleComposition;
  guide: Buffer;
  /** Pixel coordinates in the oriented original room, before padding. */
  window: StorefrontRoomIntegrationWindow;
  originalFrame: { width: number; height: number };
}

const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const dimension = (value: unknown): value is number =>
  Number.isSafeInteger(value) && typeof value === "number" && value > 0 && value <= 8192;
const angle = (value: unknown, minimum: number, maximum: number) =>
  value === null || (typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum);
const invalid = () => new Error("Données d’intégration dans la pièce invalides.");

function validateComposition(composition: SimpleComposition) {
  if (!composition || !dimension(composition.sceneWidth) || !dimension(composition.sceneHeight) ||
      composition.sceneWidth * composition.sceneHeight > 16_000_000 ||
      !Buffer.isBuffer(composition.sceneWebp) || !composition.sceneWebp.length ||
      composition.sceneWebp.length > 32_000_000) throw invalid();
}

/** The model edits the original photograph, never a catalogue sprite. */
export function roomIntegrationEditComposition(
  composition: SimpleComposition,
  objects: StorefrontPerspectiveGuideObject[],
  replacements: Array<{ xMin: number; yMin: number; xMax: number; yMax: number }> = [],
  options: { confirmedReplacement?: boolean; allowEstimatedVolume?: boolean } = {},
): SimpleComposition {
  validateComposition(composition);
  if (!Array.isArray(objects) || objects.length < 1 || objects.length > 3) throw invalid();
  const { sceneWidth: width, sceneHeight: height } = composition;
  const maskRaw = Buffer.alloc(width * height * 4, 255);
  const indices = new Set<number>();
  const clearRectangle = (left: number, top: number, right: number, bottom: number) => {
    for (let y = Math.max(0, Math.floor(top)); y < Math.min(height, Math.ceil(bottom)); y++)
      for (let x = Math.max(0, Math.floor(left)); x < Math.min(width, Math.ceil(right)); x++)
        maskRaw[(y * width + x) * 4 + 3] = 0;
  };
  for (const object of objects) {
    if (!object || !Number.isInteger(object.index) || object.index < 0 || object.index > 2 ||
        indices.has(object.index) || !object.point ||
        ![object.point.x, object.point.y].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) ||
        !["standing", "flat", "wall"].includes(object.kind) ||
        !positive(object.pixelsPerCm) || !positive(object.widthPixelsPerCm) || !object.dimensionsCm ||
        !Object.values(object.dimensionsCm).every(positive) ||
        (object.pose !== undefined && (!object.pose ||
          !angle(object.pose.cameraElevationDegrees, 0, 85) || !angle(object.pose.cameraRollDegrees, -30, 30)))) throw invalid();
    indices.add(object.index);
    const physicalWidth = object.dimensionsCm.width * object.widthPixelsPerCm;
    const physicalHeight = object.dimensionsCm.height * object.pixelsPerCm;
    const physicalDepth = object.dimensionsCm.depth * object.widthPixelsPerCm;
    if (![physicalWidth, physicalHeight, physicalDepth].every(positive)) throw invalid();
    const anchor = {
      x: Math.min(width - 1, Math.round(object.point.x * width)),
      y: Math.min(height - 1, Math.round(object.point.y * height)),
    };
    const elevation = object.pose?.cameraElevationDegrees;
    // Unknown top elevation retains a conservative full-depth envelope.
    const projectedDepth = typeof elevation === "number"
      ? physicalDepth * Math.sin(elevation * Math.PI / 180) : physicalDepth;
    const bodyHeight = object.kind === "flat" ? physicalDepth : physicalHeight;
    const top = object.kind === "standing" ? -bodyHeight - projectedDepth : -bodyHeight / 2;
    const bottom = object.kind === "standing" ? 0 : bodyHeight / 2;
    const roll = object.kind === "standing" ? (object.pose?.cameraRollDegrees ?? 0) * Math.PI / 180 : 0;
    const corners = [[-physicalWidth / 2, top], [physicalWidth / 2, top],
      [-physicalWidth / 2, bottom], [physicalWidth / 2, bottom]].map(([x, y]) => ({
        x: anchor.x + x! * Math.cos(roll) - y! * Math.sin(roll),
        y: anchor.y + x! * Math.sin(roll) + y! * Math.cos(roll),
      }));
    const left = Math.min(...corners.map(corner => corner.x));
    const right = Math.max(...corners.map(corner => corner.x));
    const upper = Math.min(...corners.map(corner => corner.y));
    const lower = Math.max(...corners.map(corner => corner.y));
    if (!options.allowEstimatedVolume && (right - left > width || lower - upper > height)) throw invalid();
    const margin = Math.max(3, Math.min(40, Math.max(physicalWidth, bodyHeight, projectedDepth) * 0.12));
    clearRectangle(left - margin, upper - margin, right + margin, lower + margin);
    if (object.kind === "standing") {
      // A small support patch permits contact shading on the real floor/table.
      const rx = Math.max(4, physicalWidth * 0.65);
      const ry = Math.max(4, projectedDepth * 0.2, physicalHeight * 0.06);
      for (let y = Math.max(0, Math.floor(anchor.y - ry)); y <= Math.min(height - 1, Math.ceil(anchor.y + ry)); y++)
        for (let x = Math.max(0, Math.floor(anchor.x - rx)); x <= Math.min(width - 1, Math.ceil(anchor.x + rx)); x++)
          if (((x - anchor.x) / rx) ** 2 + ((y - anchor.y) / ry) ** 2 <= 1)
            maskRaw[(y * width + x) * 4 + 3] = 0;
    }
  }
  if (replacements.length > objects.length) throw invalid();
  for (const box of replacements) {
    if (!box || ![box.xMin, box.yMin, box.xMax, box.yMax].every(value => Number.isFinite(value) && value >= 0 && value <= 1) ||
        box.xMax <= box.xMin || box.yMax <= box.yMin ||
        (box.xMax - box.xMin) * (box.yMax - box.yMin) > (options.confirmedReplacement ? 0.5 : 0.35)) throw invalid();
    clearRectangle(box.xMin * width, box.yMin * height, box.xMax * width, box.yMax * height);
  }
  return { ...composition, imageWebp: composition.sceneWebp!, baseWebp: composition.sceneWebp!, maskRaw };
}

/** Opt-in region for a complete photographic correction. Space around each
 * estimated volume permits the model to reconstruct perspective and contact
 * without cutting its base at the old narrow mask. This is an authorisation
 * region, never evidence that the generated object has the correct geometry. */
export function roomRefinementEditComposition(
  composition: SimpleComposition,
  objects: StorefrontPerspectiveGuideObject[],
  replacements: Array<{ xMin: number; yMin: number; xMax: number; yMax: number }> = [],
  options: { confirmedReplacement?: boolean; allowEstimatedVolume?: boolean } = {},
): SimpleComposition {
  // Keep the historical validation and initial volume/replacement union intact.
  const validated = roomIntegrationEditComposition(composition, objects, replacements, options);
  const { sceneWidth: width, sceneHeight: height } = validated;
  const maskRaw = Buffer.from(validated.maskRaw);
  const clearRectangle = (left: number, top: number, right: number, bottom: number) => {
    for (let y = Math.max(0, Math.floor(top)); y < Math.min(height, Math.ceil(bottom)); y++)
      for (let x = Math.max(0, Math.floor(left)); x < Math.min(width, Math.ceil(right)); x++)
        maskRaw[(y * width + x) * 4 + 3] = 0;
  };
  for (const object of objects) {
    // Expand each object separately: distant products do not authorise editing
    // every unrelated pixel in the rectangle between them.
    const bounds = editableBounds(roomIntegrationEditComposition(composition, [object], [], options));
    const extent = Math.max(object.dimensionsCm.width * object.widthPixelsPerCm!,
      object.dimensionsCm.height * object.pixelsPerCm,
      object.dimensionsCm.depth * object.widthPixelsPerCm!);
    const margin = Math.min(64, Math.max(12, Math.ceil(extent * 0.5)));
    clearRectangle(bounds.left - margin, bounds.top - margin, bounds.right + margin, bounds.bottom + margin);
  }
  for (const box of replacements) {
    // Confirmed removal includes room for the object's immediate contact and
    // edge reconstruction, while distant architecture stays protected.
    const margin = options.confirmedReplacement ? 0 : Math.min(32, Math.max(8, Math.ceil(Math.min(
      (box.xMax - box.xMin) * width, (box.yMax - box.yMin) * height) * 0.15)));
    clearRectangle(box.xMin * width - margin, box.yMin * height - margin,
      box.xMax * width + margin, box.yMax * height + margin);
  }
  return { ...validated, maskRaw };
}

/** Prepare an opaque provider photograph for a second image edit. Its mask
 * and photograph must use the exact same padded canvas; resize uniformly only,
 * reject altered crops/aspects instead of stretching them into alignment. */
export async function prepareRoomRefinementBase(
  padded: PaddedComposition,
  generated: Buffer,
): Promise<Buffer> {
  if (!padded || !dimension(padded.paddedWidth) || !dimension(padded.paddedHeight) ||
      padded.paddedWidth * padded.paddedHeight > 16_000_000 ||
      !Number.isSafeInteger(padded.offsetX) || padded.offsetX < 0 || padded.offsetX >= padded.paddedWidth ||
      !Number.isSafeInteger(padded.offsetY) || padded.offsetY < 0 || padded.offsetY >= padded.paddedHeight ||
      !Buffer.isBuffer(generated) || !generated.length || generated.length > 32_000_000) throw invalid();
  const source = sharp(generated, { limitInputPixels: 16_000_000 });
  const metadata = await source.metadata();
  if (!metadata.width || !metadata.height || !["png", "jpeg", "webp"].includes(metadata.format ?? "") ||
      (metadata.pages ?? 1) !== 1 || (metadata.orientation !== undefined && metadata.orientation !== 1) ||
      Math.abs(metadata.height * padded.paddedWidth / metadata.width - padded.paddedHeight) > 0.5) throw invalid();
  if (metadata.hasAlpha && (await source.stats()).channels.at(-1)?.min !== 255)
    throw new Error("La correction nécessite une photographie entièrement opaque.");
  const result = await source.resize({ width: padded.paddedWidth }).removeAlpha()
    .toColourspace("srgb").png().toBuffer({ resolveWithObject: true });
  if (result.info.width !== padded.paddedWidth || result.info.height !== padded.paddedHeight || result.info.channels !== 3)
    throw invalid();
  return result.data;
}

/** Opt-in native-resolution bridge between providers. Retain every decoded
 * photograph pixel and scale only the binary edit mask. Coordinates supplied
 * to the next provider use this same uniform scale; restoration still uses
 * the original padded frame, never the native frame as a room-pixel window. */
export async function prepareNativeRoomRefinementFrame(
  padded: PaddedComposition,
  generated: Buffer,
): Promise<NativeRoomRefinementFrame> {
  if (!padded || !dimension(padded.paddedWidth) || !dimension(padded.paddedHeight) ||
      padded.paddedWidth * padded.paddedHeight > 16_000_000 ||
      !Number.isSafeInteger(padded.offsetX) || padded.offsetX < 0 || padded.offsetX >= padded.paddedWidth ||
      !Number.isSafeInteger(padded.offsetY) || padded.offsetY < 0 || padded.offsetY >= padded.paddedHeight ||
      !Buffer.isBuffer(padded.maskPng) || !padded.maskPng.length || padded.maskPng.length > 32_000_000 ||
      !Buffer.isBuffer(generated) || !generated.length || generated.length > 32_000_000) throw invalid();
  const source = sharp(generated, { limitInputPixels: 16_000_000 });
  const maskSource = sharp(padded.maskPng, { limitInputPixels: 16_000_000 });
  const [metadata, maskMetadata] = await Promise.all([source.metadata(), maskSource.metadata()]);
  if (!dimension(metadata.width) || !dimension(metadata.height) ||
      metadata.width * metadata.height > 16_000_000 ||
      !["png", "jpeg", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) !== 1 ||
      (metadata.orientation !== undefined && metadata.orientation !== 1) ||
      maskMetadata.format !== "png" || !maskMetadata.hasAlpha || (maskMetadata.pages ?? 1) !== 1 ||
      (maskMetadata.orientation !== undefined && maskMetadata.orientation !== 1) ||
      maskMetadata.width !== padded.paddedWidth || maskMetadata.height !== padded.paddedHeight) throw invalid();
  const scale = metadata.width / padded.paddedWidth;
  // At most raster rounding, not a second independent vertical scale or crop.
  if (Math.abs(padded.paddedHeight * scale - metadata.height) > 0.5 ||
      Math.round(padded.paddedHeight * scale) !== metadata.height) throw invalid();
  if (metadata.hasAlpha && (await source.stats()).channels.at(-1)?.min !== 255)
    throw new Error("La correction nécessite une photographie entièrement opaque.");
  const alpha = await maskSource.ensureAlpha().extractChannel(3).raw().toBuffer();
  if (alpha.some(value => value !== 0 && value !== 255)) throw invalid();
  const [image, scaledAlpha] = await Promise.all([
    source.removeAlpha().toColourspace("srgb").png().toBuffer(),
    sharp(alpha, { raw: { width: padded.paddedWidth, height: padded.paddedHeight, channels: 1 } })
      .resize({ width: metadata.width, kernel: "nearest" }).greyscale().raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (scaledAlpha.info.width !== metadata.width || scaledAlpha.info.height !== metadata.height ||
      scaledAlpha.info.channels !== 1 || scaledAlpha.data.some(value => value !== 0 && value !== 255)) throw invalid();
  const nativeMask = Buffer.alloc(metadata.width * metadata.height * 4, 255);
  for (let pixel = 0; pixel < scaledAlpha.data.length; pixel++) nativeMask[pixel * 4 + 3] = scaledAlpha.data[pixel]!;
  const maskPng = await sharp(nativeMask, { raw: { width: metadata.width, height: metadata.height, channels: 4 } })
    .png().toBuffer();
  return { image, maskPng, frame: { width: metadata.width, height: metadata.height }, scale,
    padding: { x: padded.offsetX * scale, y: padded.offsetY * scale } };
}

/** Separate reference image only: never replace the unmarked editable input.
 * Every marker uses the native image's pixel frame without another scale or
 * rounding. The red cross is the requested contact/centre; blue lateral ticks
 * show only the target width, not a silhouette, volume or editable boundary. */
export async function buildNativeRoomRefinementGuide(input: {
  image: Buffer;
  frame: { width: number; height: number };
  contactPixel: { x: number; y: number };
  physicalWidthPx: number;
  kind?: "standing" | "wall" | "flat";
}): Promise<Buffer> {
  if (!input || !input.frame || !dimension(input.frame.width) || !dimension(input.frame.height) ||
      input.frame.width * input.frame.height > 16_000_000 ||
      !Buffer.isBuffer(input.image) || !input.image.length || input.image.length > 32_000_000 ||
      !input.contactPixel || ![input.contactPixel.x, input.contactPixel.y].every(Number.isFinite) ||
      input.contactPixel.x < 0 || input.contactPixel.x > input.frame.width ||
      input.contactPixel.y < 0 || input.contactPixel.y > input.frame.height ||
      !positive(input.physicalWidthPx) || input.physicalWidthPx > input.frame.width ||
      (input.kind !== undefined && !["standing", "wall", "flat"].includes(input.kind))) throw invalid();
  const source = sharp(input.image, { limitInputPixels: 16_000_000 });
  const metadata = await source.metadata();
  if (metadata.width !== input.frame.width || metadata.height !== input.frame.height ||
      !["png", "jpeg", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) !== 1 ||
      (metadata.orientation !== undefined && metadata.orientation !== 1)) throw invalid();
  if (metadata.hasAlpha && (await source.stats()).channels.at(-1)?.min !== 255)
    throw new Error("Le guide nécessite une photographie entièrement opaque.");
  const { width, height } = input.frame, { x, y } = input.contactPixel;
  const left = x - input.physicalWidthPx / 2, right = x + input.physicalWidthPx / 2;
  const textX = width < 160 ? width / 2 : Math.max(80, Math.min(width - 80, x));
  const labelY = (wanted: number) => Math.max(18, Math.min(height - 6, wanted));
  const widthMarks = `M ${left} ${y - 12} V ${y + 12} M ${left} ${y} H ${left + 8} M ${right} ${y - 12} V ${y + 12} M ${right} ${y} H ${right - 8}`;
  const cross = `M ${x - 16} ${y} H ${x + 16} M ${x} ${y - 16} V ${y + 16}`;
  const label = input.kind === "wall" || input.kind === "flat" ? "POINT" : "BASE";
  // Serverless images have no guaranteed system fonts. These fixed outlines
  // keep diagnostic guidance legible without text rendering or font lookup.
  const glyphs: Record<string, string> = {
    W: "M0 0L2 14L5 7L8 14L10 0", I: "M1 0H9M5 0V14M1 14H9",
    D: "M0 0V14H4Q10 14 10 7Q10 0 4 0Z", T: "M0 0H10M5 0V14",
    H: "M0 0V14M10 0V14M0 7H10", A: "M0 14L5 0L10 14M2 9H8",
    B: "M0 0V14M0 0H5Q10 0 10 3.5Q10 7 5 7H0M5 7Q10 7 10 10.5Q10 14 5 14H0",
    S: "M10 1Q6 -1 2 1Q-2 6 5 7Q12 8 9 13Q5 16 0 13",
    E: "M10 0H0V14H10M0 7H8", P: "M0 14V0H5Q10 0 10 3.5Q10 7 5 7H0",
    O: "M5 0Q0 0 0 7Q0 14 5 14Q10 14 10 7Q10 0 5 0Z",
    N: "M0 14V0L10 14V0",
  };
  const vectorLabel = (word: string, baseline: number, colour: string) => {
    const start = textX - (word.length * 14 - 4) / 2;
    const paths = [...word].map((letter, index) =>
      `<path d="${glyphs[letter]}" transform="translate(${start + index * 14} ${baseline - 14})"/>`).join("");
    return `<g fill="none" stroke-linecap="round" stroke-linejoin="round"><g stroke="white" stroke-width="6">${paths}</g><g stroke="${colour}" stroke-width="2.5">${paths}</g></g>`;
  };
  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <g fill="none" stroke-linecap="round"><path d="${widthMarks}" stroke="white" stroke-width="7"/><path d="${widthMarks}" stroke="#0057c8" stroke-width="3"/>
    <circle cx="${x}" cy="${y}" r="12" stroke="white" stroke-width="7"/><path d="${cross}" stroke="white" stroke-width="7"/>
    <circle cx="${x}" cy="${y}" r="12" stroke="#e00028" stroke-width="3"/><path d="${cross}" stroke="#e00028" stroke-width="3"/></g>
    ${vectorLabel("WIDTH", labelY(y - 28), "#0057c8")}${vectorLabel(label, labelY(y + 40), "#e00028")}
  </svg>`);
  return source.removeAlpha().toColourspace("srgb").composite([{ input: overlay }]).removeAlpha().png().toBuffer();
}

/** Restore only the allowed full-scene edit, preserving every exterior RGB pixel. */
export async function restoreRoomIntegrationBackground(
  composition: SimpleComposition,
  padded: PaddedComposition,
  generated: Buffer,
  options: { edgeFeatherPx?: number } = {},
): Promise<Buffer> {
  validateComposition(composition);
  const feather = options.edgeFeatherPx ?? 3;
  if (!Number.isSafeInteger(feather) || feather < 1 || feather > 8) throw invalid();
  const { sceneWidth: width, sceneHeight: height } = composition;
  if (!Buffer.isBuffer(composition.maskRaw) || composition.maskRaw.length !== width * height * 4 ||
      !padded || !dimension(padded.paddedWidth) || !dimension(padded.paddedHeight) ||
      padded.paddedWidth * padded.paddedHeight > 16_000_000 ||
      !Number.isSafeInteger(padded.offsetX) || padded.offsetX < 0 ||
      !Number.isSafeInteger(padded.offsetY) || padded.offsetY < 0 ||
      padded.offsetX + width > padded.paddedWidth || padded.offsetY + height > padded.paddedHeight ||
      !Buffer.isBuffer(generated) || !generated.length || generated.length > 32_000_000) throw invalid();
  for (let pixel = 0; pixel < width * height; pixel++) {
    const alpha = composition.maskRaw[pixel * 4 + 3];
    if (alpha !== 0 && alpha !== 255) throw invalid();
  }
  const source = sharp(generated, { limitInputPixels: 16_000_000 });
  const metadata = await source.metadata();
  if (!metadata.width || !metadata.height || !["png", "jpeg", "webp"].includes(metadata.format ?? "") ||
      (metadata.pages ?? 1) !== 1 || (metadata.orientation !== undefined && metadata.orientation !== 1) ||
      metadata.width * metadata.height > 16_000_000 ||
      Math.abs(metadata.height * padded.paddedWidth / metadata.width - padded.paddedHeight) > 0.5) throw invalid();
  if (metadata.hasAlpha) {
    const stats = await source.stats();
    if (stats.channels.at(-1)?.min !== 255) throw new Error("L’intégration doit retourner une photographie entièrement opaque.");
  }
  const [room, scaled] = await Promise.all([
    sharp(composition.sceneWebp!).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true }),
    // Only a width is requested: scale remains uniform, never a fit:fill warp.
    source.resize({ width: padded.paddedWidth }).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (room.info.width !== width || room.info.height !== height || room.info.channels !== 3 ||
      scaled.info.width !== padded.paddedWidth || scaled.info.height !== padded.paddedHeight || scaled.info.channels !== 3) throw invalid();
  const edited = await sharp(scaled.data, { raw: { width: scaled.info.width, height: scaled.info.height, channels: 3 } })
    .extract({ left: padded.offsetX, top: padded.offsetY, width, height }).raw().toBuffer();
  const editable = (x: number, y: number) => x >= 0 && x < width && y >= 0 && y < height &&
    composition.maskRaw[(y * width + x) * 4 + 3] === 0;
  const output = Buffer.from(room.data);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!editable(x, y)) continue;
      let distance = feather;
      for (let radius = 1; radius <= feather; radius++) {
        if (!editable(x - radius, y) || !editable(x + radius, y) ||
            !editable(x, y - radius) || !editable(x, y + radius)) {
          distance = radius - 1;
          break;
        }
      }
      const blend = distance / feather;
      const offset = (y * width + x) * 3;
      for (let channel = 0; channel < 3; channel++)
        output[offset + channel] = Math.round(room.data[offset + channel]! * (1 - blend) + edited[offset + channel]! * blend);
    }
  }
  return sharp(output, { raw: { width, height, channels: 3 } }).webp({ lossless: true }).toBuffer();
}

function editableBounds(composition: SimpleComposition) {
  validateComposition(composition);
  const { sceneWidth: width, sceneHeight: height, maskRaw } = composition;
  if (!Buffer.isBuffer(maskRaw) || maskRaw.length !== width * height * 4) throw invalid();
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = maskRaw[(y * width + x) * 4 + 3];
      if (alpha !== 0 && alpha !== 255) throw invalid();
      if (alpha !== 0) continue;
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) throw invalid();
  return { left, top, right: right + 1, bottom: bottom + 1 };
}

function validateWindow(composition: SimpleComposition, window: StorefrontRoomIntegrationWindow) {
  const bounds = editableBounds(composition);
  if (!window || !Number.isSafeInteger(window.left) || window.left < 0 ||
      !Number.isSafeInteger(window.top) || window.top < 0 ||
      !dimension(window.width) || !dimension(window.height) ||
      window.left + window.width > composition.sceneWidth ||
      window.top + window.height > composition.sceneHeight ||
      window.left > bounds.left || window.top > bounds.top ||
      window.left + window.width < bounds.right || window.top + window.height < bounds.bottom) throw invalid();
}

async function cropRoomComposition(
  composition: SimpleComposition,
  window: StorefrontRoomIntegrationWindow,
): Promise<SimpleComposition> {
  validateWindow(composition, window);
  const room = await sharp(composition.sceneWebp!, { limitInputPixels: 16_000_000 })
    .removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  if (room.info.width !== composition.sceneWidth || room.info.height !== composition.sceneHeight || room.info.channels !== 3) throw invalid();
  const [photo, maskRaw] = await Promise.all([
    sharp(room.data, { raw: { width: room.info.width, height: room.info.height, channels: 3 } })
      .extract(window).webp({ lossless: true }).toBuffer(),
    sharp(composition.maskRaw, { raw: { width: composition.sceneWidth, height: composition.sceneHeight, channels: 4 } })
      .extract(window).raw().toBuffer(),
  ]);
  return {
    ...composition, sceneWebp: photo, imageWebp: photo, baseWebp: photo, maskRaw,
    sceneWidth: window.width, sceneHeight: window.height,
    placements: composition.placements.map(placement => {
      const visible = placement.visible;
      const left = visible ? Math.max(window.left, visible.left) : 0;
      const top = visible ? Math.max(window.top, visible.top) : 0;
      const right = visible ? Math.min(window.left + window.width, visible.left + visible.width) : 0;
      const bottom = visible ? Math.min(window.top + window.height, visible.top + visible.height) : 0;
      return { ...placement, left: placement.left - window.left, top: placement.top - window.top,
        baseX: placement.baseX - window.left, baseY: placement.baseY - window.top,
        visible: visible && right > left && bottom > top
          ? { left: left - window.left, top: top - window.top, width: right - left, height: bottom - top } : null };
    }),
    overlays: composition.overlays.map(overlay => ({ ...overlay,
      left: overlay.left - window.left, top: overlay.top - window.top,
      baseX: overlay.baseX - window.left, baseY: overlay.baseY - window.top })),
  };
}

/** Crop room, allowed region and guide identically; pixels and camera are unchanged. */
export async function localiseRoomIntegration(
  composition: SimpleComposition,
  objects: StorefrontPerspectiveGuideObject[],
  guide: Buffer,
  options: { allowEstimatedVolume?: boolean } = {},
): Promise<StorefrontLocalRoomIntegration> {
  // Reuse V9's geometry validation without changing the caller's edit mask.
  roomIntegrationEditComposition(composition, objects, [], options);
  const bounds = editableBounds(composition);
  if (!Buffer.isBuffer(guide) || !guide.length || guide.length > 32_000_000) throw invalid();
  const metadata = await sharp(guide, { limitInputPixels: 16_000_000 }).metadata();
  if (metadata.width !== composition.sceneWidth || metadata.height !== composition.sceneHeight ||
      !["png", "jpeg", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) !== 1 ||
      (metadata.orientation !== undefined && metadata.orientation !== 1)) throw invalid();
  for (const object of objects) {
    const x = Math.min(composition.sceneWidth - 1, Math.round(object.point.x * composition.sceneWidth));
    const y = Math.min(composition.sceneHeight - 1, Math.round(object.point.y * composition.sceneHeight));
    if (composition.maskRaw[(y * composition.sceneWidth + x) * 4 + 3] !== 0) throw invalid();
  }
  const extent = Math.max(...objects.flatMap(object => [
    object.dimensionsCm.width * object.widthPixelsPerCm!,
    object.dimensionsCm.height * object.pixelsPerCm,
    object.dimensionsCm.depth * object.widthPixelsPerCm!,
  ]));
  const margin = Math.max(24, Math.ceil(extent * 0.6));
  const left = Math.max(0, bounds.left - margin);
  const top = Math.max(0, bounds.top - margin);
  const right = Math.min(composition.sceneWidth, bounds.right + margin);
  const bottom = Math.min(composition.sceneHeight, bounds.bottom + margin);
  const window = { left, top, width: right - left, height: bottom - top };
  const [localComposition, localGuide] = await Promise.all([
    cropRoomComposition(composition, window),
    sharp(guide, { limitInputPixels: 16_000_000 }).extract(window).webp({ lossless: true }).toBuffer(),
  ]);
  return { composition: localComposition, guide: localGuide, window,
    originalFrame: { width: composition.sceneWidth, height: composition.sceneHeight } };
}

/** Reinsert the complete local scene edit; never rescale or re-stamp a product. */
export async function restoreLocalRoomIntegrationBackground(
  originalComposition: SimpleComposition,
  window: StorefrontRoomIntegrationWindow,
  paddedLocal: PaddedComposition,
  generated: Buffer,
  options: { edgeFeatherPx?: number } = {},
): Promise<Buffer> {
  const localComposition = await cropRoomComposition(originalComposition, window);
  const localEdited = await restoreRoomIntegrationBackground(localComposition, paddedLocal, generated, options);
  const [room, edited] = await Promise.all([
    sharp(originalComposition.sceneWebp!).removeAlpha().toColourspace("srgb").raw().toBuffer(),
    sharp(localEdited).removeAlpha().toColourspace("srgb").raw().toBuffer(),
  ]);
  const width = originalComposition.sceneWidth;
  const output = Buffer.from(room);
  for (let y = 0; y < window.height; y++) {
    for (let x = 0; x < window.width; x++) {
      const globalPixel = (y + window.top) * width + x + window.left;
      if (originalComposition.maskRaw[globalPixel * 4 + 3] !== 0) continue;
      const localOffset = (y * window.width + x) * 3;
      edited.copy(output, globalPixel * 3, localOffset, localOffset + 3);
    }
  }
  return sharp(output, { raw: { width, height: originalComposition.sceneHeight, channels: 3 } })
    .webp({ lossless: true }).toBuffer();
}
