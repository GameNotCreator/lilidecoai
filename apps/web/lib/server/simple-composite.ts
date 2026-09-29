import sharp from "sharp";
import {
  computeSimplePlacement,
  footprintsCollide,
  orderByDepth,
  type SimpleDimensionPair,
  type SimplePlacementKind,
  type SimplePlacementResult,
  type SimpleScaleSource,
} from "@lili/geometry";
import type { SceneLightingEstimate } from "@lili/ai-router";

/**
 * Deterministic composite pipeline for the simple multi-point workflow.
 *
 * Position and size are geometry, not generation: the product cutout is pasted
 * at its exact target location before the model is called, the model may only
 * touch the masked area around each object (edge-blend ring, contact shadow),
 * and `pasteBackOutsideMask` restores every pixel outside the mask from the
 * placeholder-free composite afterwards. Overflow past a shelf, a moved object
 * or a redecorated room become impossible by construction, not by prompt.
 *
 * sharp pitfalls this file works around (each one bit us once):
 * - sharp applies operations in a fixed internal order, not chaining order:
 *   `.blur().threshold()` thresholds first, so it never erodes or dilates. All
 *   morphology here is explicit JS over RAW buffers.
 * - removeAlpha() and joinChannel() must never share a pipeline.
 * - composite() runs at the END of a pipeline; the alpha it introduces must be
 *   stripped in a fresh pipeline.
 * - Channel math is done on RAW buffers: sharp(buf, { raw: {...} }).
 */

export type SimpleCompositeDimensionPair = SimpleDimensionPair;

export class SimpleCompositeError extends Error {
  constructor(
    message: string,
    readonly status: number = 422,
  ) {
    super(message);
    this.name = "SimpleCompositeError";
  }
}

export interface SimplePlacementSpec {
  objectIndex: number;
  point: { x: number; y: number };
  dimensions: SimpleDimensionPair;
  pixelsPerCm: number | null;
  scaleSource?: SimpleScaleSource;
  kind?: SimplePlacementKind;
  cutout: { widthPx: number; heightPx: number; baseRowFraction?: number };
}

export interface SimpleCompositePlacement extends SimplePlacementResult {
  objectIndex: number;
  /** The full box intersects another object's box. */
  overlaps: boolean;
}

export interface SimpleCompositeObjectInput {
  objectIndex?: number;
  cutout: Buffer;
  point: { x: number; y: number };
  dimensions: SimpleDimensionPair;
  /** Pixels per centimetre on the support surface at the point, when known. */
  pixelsPerCm: number | null;
  scaleSource?: SimpleScaleSource;
  kind?: SimplePlacementKind;
  baseRowFraction?: number;
}

export interface PlacedOverlay {
  /** The cutout resized to its final size, full RGBA png (never cropped). */
  png: Buffer;
  left: number;
  top: number;
  widthPx: number;
  heightPx: number;
  baseX: number;
  baseY: number;
  kind: SimplePlacementKind;
  depthKey: number;
  objectIndex: number;
}

export interface SimpleComposition {
  /** Unmodified scene, retained for source-alpha recomposition over shadows. */
  sceneWebp?: Buffer;
  /** Model input: scene + shadow placeholders + overlays. */
  imageWebp: Buffer;
  /** Scene + overlays, no placeholders: the paste-back base. */
  baseWebp: Buffer;
  /** RGBA scene-sized mask: alpha 0 = editable, alpha 255 = preserved. */
  maskRaw: Buffer;
  sceneWidth: number;
  sceneHeight: number;
  /** Input order. */
  placements: SimpleCompositePlacement[];
  /** Depth order, far to near. Kept for the identity re-stamp. */
  overlays: PlacedOverlay[];
  lighting: SceneLightingEstimate | null;
}

export type CompositionLike = {
  sceneWebp?: Buffer;
  imageWebp: Buffer;
  baseWebp?: Buffer;
  maskRaw: Buffer;
  sceneWidth: number;
  sceneHeight: number;
  overlays: PlacedOverlay[];
  lighting?: SceneLightingEstimate | null;
};

export interface PaddedComposition {
  imageWebp: Buffer;
  maskPng: Buffer;
  offsetX: number;
  offsetY: number;
  paddedWidth: number;
  paddedHeight: number;
  padded: boolean;
}

/** Silhouette ring the model may blend, in pixels. */
/**
 * Version of the deterministic compositing: the silhouette mask, the shadow
 * placeholders, the depth-ordered overlay, the aspect padding and the
 * paste-back. Bump it whenever any of those changes — a corpus baseline
 * compared across a silent change here compares two different engines
 * (PRO-007, phase 0 "baseline des versions").
 */
export const SIMPLE_COMPOSITE_VERSION = "composite-v2";
/** Opt-in source-faithful insertion; legacy/spatial paste-back is unchanged. */
export const CONTACT_LIGHT_COMPOSITE_VERSION = "composite-v3/contact-light-v4";

export const SILHOUETTE_DILATION_PX = 3;
/** Identity stamp inset, in pixels: the model keeps this much of the edge. */
export const STAMP_EROSION_PX = 2;
/** Only a broad, achromatic exposure field can be transferred to real pixels. */
export const MAX_RELIGHT_GAIN = 0.12;
/** Maximum achromatic attenuation transferred to the original support texture. */
export const MAX_CONTACT_DARKENING = 0.25;
/** Contact occlusion plus cast shadow; applied only to the real support. */
export const MAX_SOURCE_SHADOW_DARKENING = 0.45;
/** Subpixel alpha contraction; source RGB and opaque interiors are untouched. */
export const BRIGHT_CONTOUR_TRIM = 0.35;
/** Nothing above the base (outside the silhouette ring) is ever editable. */
const SHADOW_WINDOW_ABOVE_BASE_PX = 2;
const MIN_VISIBLE_PX = 1;
const MAX_CROPPED_BY_FRAME = 0.85;

const KIND_RANK: Record<SimplePlacementKind, number> = {
  wall: 0,
  flat: 1,
  standing: 2,
};

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// Explicit binary morphology on RAW buffers (Chebyshev / square structuring
// element of the given radius). Outside the buffer counts as background.
// ---------------------------------------------------------------------------

function binaryMorph(
  source: Uint8Array,
  width: number,
  height: number,
  radius: number,
  mode: "dilate" | "erode",
): Uint8Array {
  if (radius <= 0) return Uint8Array.from(source);
  // Dilation looks for a foreground neighbour, erosion for a background one;
  // pixels past the buffer edge are background in both cases.
  const seek = mode === "dilate" ? 1 : 0;
  const passRow = (
    input: Uint8Array,
    output: Uint8Array,
    stepX: number,
    stepY: number,
  ) => {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        const current = input[index] ?? 0;
        if (current === seek) {
          output[index] = current;
          continue;
        }
        let found = false;
        for (let d = -radius; d <= radius && !found; d += 1) {
          const sx = x + d * stepX;
          const sy = y + d * stepY;
          if (sx < 0 || sx >= width || sy < 0 || sy >= height) {
            found = seek === 0;
          } else {
            found = (input[sy * width + sx] ?? 0) === seek;
          }
        }
        output[index] = found ? seek : current;
      }
    }
  };
  const horizontal = new Uint8Array(width * height);
  passRow(source, horizontal, 1, 0);
  const out = new Uint8Array(width * height);
  passRow(horizontal, out, 0, 1);
  return out;
}

/** Binary dilation (1 = foreground) by `radius` pixels, square element. */
export function dilateBinary(
  source: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  return binaryMorph(source, width, height, radius, "dilate");
}

/** Binary erosion (1 = foreground) by `radius` pixels, square element. */
export function erodeBinary(
  source: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  return binaryMorph(source, width, height, radius, "erode");
}

/**
 * Gaussian blur of a single-channel RAW buffer that really returns one
 * channel. sharp promotes a 1-channel raw input to 3-channel greyscale RGB on
 * output, so reading the result with a stride of 1 — as the obvious code does
 * — silently scrambles it: a shadow ellipse loses most of its opacity and a
 * feathered mask stops matching the image it is joined to.
 */
async function blurGreyscale(
  source: Buffer,
  width: number,
  height: number,
  sigma: number,
): Promise<Buffer> {
  const { data, info } = await sharp(source, {
    raw: { width, height, channels: 1 },
  })
    .blur(sigma)
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels === 1) return data;
  const single = Buffer.alloc(width * height);
  for (let i = 0; i < single.length; i += 1) {
    single[i] = data[i * info.channels] ?? 0;
  }
  return single;
}

async function overlayAlpha(
  png: Buffer,
): Promise<{ alpha: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .extractChannel("alpha")
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { alpha: data, width: info.width, height: info.height };
}

function binarize(alpha: Buffer): Uint8Array {
  const out = new Uint8Array(alpha.length);
  for (let i = 0; i < alpha.length; i += 1) {
    if ((alpha[i] ?? 0) > 0) out[i] = 1;
  }
  return out;
}

/** Marks every pixel of an axis-aligned ellipse, clipped to the frame. */
function paintEllipse(
  editable: Uint8Array,
  width: number,
  height: number,
  ellipse: { cx: number; cy: number; rx: number; ry: number },
  minY: number,
): void {
  if (ellipse.rx <= 0 || ellipse.ry <= 0) return;
  const x0 = Math.max(0, Math.floor(ellipse.cx - ellipse.rx));
  const x1 = Math.min(width - 1, Math.ceil(ellipse.cx + ellipse.rx));
  const y0 = Math.max(0, minY, Math.floor(ellipse.cy - ellipse.ry));
  const y1 = Math.min(height - 1, Math.ceil(ellipse.cy + ellipse.ry));
  for (let y = y0; y <= y1; y += 1) {
    const ny = (y - ellipse.cy) / ellipse.ry;
    for (let x = x0; x <= x1; x += 1) {
      const nx = (x - ellipse.cx) / ellipse.rx;
      if (nx * nx + ny * ny <= 1) editable[y * width + x] = 1;
    }
  }
}

/**
 * The editable region hugs each object's silhouette (3–12 px with resolution) plus, for
 * standing objects only, a contact-shadow window under the base: a symmetric
 * ellipse and, when the light has a side, a directional ellipse on the shadow
 * side. Both are clipped to y >= baseY - 2 so the wall behind the object never
 * opens up. Wall objects get a local offset cast shadow and flat objects a
 * contact ring. Never a bounding box.
 */
export async function createSilhouetteMask(
  width: number,
  height: number,
  overlays: PlacedOverlay[],
  lighting?: SceneLightingEstimate | null,
): Promise<Buffer> {
  // The silhouettes are stamped into the scene first and dilated once, in
  // scene space. Dilating inside each overlay's own tile would clip the ring
  // at the bounding box, leaving the model no pixels outside the object to
  // blend into — the edge would stay a visible cut-out line.
  const silhouettes = new Uint8Array(width * height);
  for (const overlay of overlays) {
    const { alpha, width: ow, height: oh } = await overlayAlpha(overlay.png);
    const shape = binarize(alpha);
    for (let y = 0; y < oh; y += 1) {
      const sy = overlay.top + y;
      if (sy < 0 || sy >= height) continue;
      for (let x = 0; x < ow; x += 1) {
        const sx = overlay.left + x;
        if (sx < 0 || sx >= width) continue;
        if (shape[y * ow + x] === 1) silhouettes[sy * width + sx] = 1;
      }
    }
  }
  const ringRadius = clampNumber(
    Math.round(Math.min(width, height) / 160),
    SILHOUETTE_DILATION_PX,
    12,
  );
  const editable = dilateBinary(silhouettes, width, height, ringRadius);
  for (const overlay of overlays) {
    if (overlay.kind === "wall" || overlay.kind === "flat") {
      // Paint a local offset silhouette, not a rectangular edit window. Wall
      // art needs a cast shadow; a rug needs ambient contact along its edge.
      const { alpha, width: ow, height: oh } = await overlayAlpha(overlay.png);
      const spread =
        overlay.kind === "flat"
          ? clampNumber(Math.round(Math.min(ow, oh) * 0.025), 3, 10)
          : ringRadius;
      const shape = dilateBinary(binarize(alpha), ow, oh, spread);
      const offset =
        overlay.kind === "wall"
          ? clampNumber(Math.round(Math.min(ow, oh) * 0.08), 3, 14)
          : 0;
      const shiftX =
        lighting?.lightDirection === "left"
          ? offset
          : lighting?.lightDirection === "right"
            ? -offset
            : 0;
      const shiftY =
        overlay.kind === "wall" ? Math.max(2, Math.round(offset / 2)) : 0;
      // Extra tile padding keeps dilation beyond the cutout's tight bounds.
      for (let y = -spread; y < oh + spread; y += 1) {
        const sy = overlay.top + y + shiftY;
        if (sy < 0 || sy >= height) continue;
        for (let x = -spread; x < ow + spread; x += 1) {
          const sx = overlay.left + x + shiftX;
          if (sx < 0 || sx >= width) continue;
          const ix = clampNumber(x, 0, ow - 1);
          const iy = clampNumber(y, 0, oh - 1);
          if (shape[iy * ow + ix]) editable[sy * width + sx] = 1;
        }
      }
    }
    if (overlay.kind !== "standing") continue;
    const minY = overlay.baseY - SHADOW_WINDOW_ABOVE_BASE_PX;
    paintEllipse(
      editable,
      width,
      height,
      {
        cx: overlay.baseX,
        cy: overlay.baseY,
        rx: 0.55 * overlay.widthPx,
        ry: Math.max(10, 0.06 * overlay.heightPx),
      },
      minY,
    );
    const direction = lighting?.lightDirection;
    if (direction === "left" || direction === "right") {
      // Light from the left throws the shadow to the right.
      const sign = direction === "left" ? 1 : -1;
      const shift = lighting?.lightElevation === "low" ? 0.45 : 0.3;
      paintEllipse(
        editable,
        width,
        height,
        {
          cx: overlay.baseX + sign * shift * overlay.widthPx,
          cy: overlay.baseY,
          rx: 0.75 * overlay.widthPx,
          ry: Math.max(10, 0.07 * overlay.heightPx),
        },
        minY,
      );
    }
  }
  const data = Buffer.alloc(width * height * 4, 255);
  for (let i = 0; i < width * height; i += 1) {
    if (editable[i] === 1) data[i * 4 + 3] = 0;
  }
  return data;
}

/** Fraction of pixels that are meaningfully transparent (alpha < 245). */
export async function transparencyRatio(image: Buffer): Promise<number> {
  const { data, info } = await sharp(image)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let transparent = 0;
  const total = info.width * info.height;
  for (let i = 3; i < data.length; i += 4) {
    if ((data[i] ?? 255) < 245) transparent += 1;
  }
  return total === 0 ? 0 : transparent / total;
}

/**
 * Scene-sized RGBA mask opening one rectangular editable window from a
 * normalized box (alpha 0 = editable). Used to paste back an obstacle-removal
 * edit so the model's regeneration stays confined to the removed object.
 */
export function createRectMask(
  width: number,
  height: number,
  box: { xMin: number; yMin: number; xMax: number; yMax: number },
  paddingPx = 14,
): Buffer {
  const data = Buffer.alloc(width * height * 4, 255);
  const minX = Math.max(0, Math.round(box.xMin * width) - paddingPx);
  const maxX = Math.min(width, Math.round(box.xMax * width) + paddingPx);
  const minY = Math.max(0, Math.round(box.yMin * height) - paddingPx);
  const maxY = Math.min(height, Math.round(box.yMax * height) + paddingPx);
  for (let y = minY; y < maxY; y += 1) {
    for (let x = minX; x < maxX; x += 1) {
      data[(y * width + x) * 4 + 3] = 0;
    }
  }
  return data;
}

/**
 * Pure pre-flight: every geometric decision comes from `computeSimplePlacement`
 * (the same code the client preview runs). Throws a 422 with a French message
 * when an object cannot be shown at its point or two standing objects would
 * occupy the same spot. Returns placements in input order.
 */
export function planSimplePlacements(
  sceneWidth: number,
  sceneHeight: number,
  specs: SimplePlacementSpec[],
): SimpleCompositePlacement[] {
  const results = specs.map((spec) =>
    computeSimplePlacement({
      sceneWidth,
      sceneHeight,
      point: spec.point,
      cutout: {
        widthPx: spec.cutout.widthPx,
        heightPx: spec.cutout.heightPx,
        baseRowFraction: spec.cutout.baseRowFraction,
      },
      dimensions: spec.dimensions,
      pixelsPerCm: spec.pixelsPerCm,
      scaleSource: spec.scaleSource,
      kind: spec.kind,
    }),
  );
  const boxesIntersect = (a: SimplePlacementResult, b: SimplePlacementResult) =>
    a.left < b.left + b.widthPx &&
    b.left < a.left + a.widthPx &&
    a.top < b.top + b.heightPx &&
    b.top < a.top + a.heightPx;

  const placements: SimpleCompositePlacement[] = results.map(
    (result, index) => ({
      ...result,
      objectIndex: specs[index]?.objectIndex ?? index,
      overlaps: results.some(
        (other, otherIndex) =>
          otherIndex !== index && boxesIntersect(result, other),
      ),
    }),
  );

  for (const placement of placements) {
    const visible = placement.visible;
    if (
      !visible ||
      visible.width < MIN_VISIBLE_PX ||
      visible.height < MIN_VISIBLE_PX ||
      placement.croppedByFrame > MAX_CROPPED_BY_FRAME
    ) {
      throw new SimpleCompositeError(
        `L’objet ${placement.objectIndex + 1} ne tient pas dans le cadre à cet endroit : placez le point plus bas ou plus au centre.`,
        422,
      );
    }
  }
  for (let i = 0; i < placements.length; i += 1) {
    for (let j = i + 1; j < placements.length; j += 1) {
      const a = placements[i];
      const b = placements[j];
      if (!a || !b) continue;
      if (footprintsCollide(a, b, sceneHeight)) {
        throw new SimpleCompositeError(
          `Espacez les points : les objets ${a.objectIndex + 1} et ${b.objectIndex + 1} se chevauchent sur la même surface.`,
          422,
        );
      }
    }
  }
  return placements;
}

/**
 * Soft contact-shadow placeholder under a standing object: an ellipse at the
 * base, blurred, then multiplied in RAW JS by the editable window so no blur
 * tail survives outside the mask. Gives the model a hint of where the shadow
 * goes without letting it paint anything the paste-back would keep.
 */
async function createShadowPlaceholder(
  overlay: PlacedOverlay,
  maskRaw: Buffer,
  sceneWidth: number,
  sceneHeight: number,
): Promise<{ input: Buffer; left: number; top: number } | null> {
  const rx = 0.4 * overlay.widthPx;
  const ry = Math.max(5, 0.025 * overlay.heightPx);
  const sigma = clampNumber(overlay.widthPx / 40, 2, 6);
  const pad = Math.ceil(3 * sigma) + 1;
  const tileLeft = Math.max(0, Math.floor(overlay.baseX - rx) - pad);
  const tileTop = Math.max(0, Math.floor(overlay.baseY - ry) - pad);
  const tileRight = Math.min(sceneWidth, Math.ceil(overlay.baseX + rx) + pad);
  const tileBottom = Math.min(sceneHeight, Math.ceil(overlay.baseY + ry) + pad);
  const tileWidth = tileRight - tileLeft;
  const tileHeight = tileBottom - tileTop;
  if (tileWidth <= 0 || tileHeight <= 0) return null;

  const shape = Buffer.alloc(tileWidth * tileHeight, 0);
  for (let y = 0; y < tileHeight; y += 1) {
    const ny = (tileTop + y - overlay.baseY) / ry;
    for (let x = 0; x < tileWidth; x += 1) {
      const nx = (tileLeft + x - overlay.baseX) / rx;
      if (nx * nx + ny * ny <= 1) shape[y * tileWidth + x] = 255;
    }
  }
  const blurred = await blurGreyscale(shape, tileWidth, tileHeight, sigma);

  const rgba = Buffer.alloc(tileWidth * tileHeight * 4, 0);
  let any = false;
  for (let y = 0; y < tileHeight; y += 1) {
    const sy = tileTop + y;
    for (let x = 0; x < tileWidth; x += 1) {
      const sx = tileLeft + x;
      const editable = maskRaw[(sy * sceneWidth + sx) * 4 + 3] === 0;
      const alpha = editable
        ? Math.round((blurred[y * tileWidth + x] ?? 0) * 0.2)
        : 0;
      const offset = (y * tileWidth + x) * 4;
      rgba[offset] = 0x15;
      rgba[offset + 1] = 0x10;
      rgba[offset + 2] = 0x09;
      rgba[offset + 3] = alpha;
      if (alpha > 0) any = true;
    }
  }
  if (!any) return null;
  const input = await sharp(rgba, {
    raw: { width: tileWidth, height: tileHeight, channels: 4 },
  })
    .png()
    .toBuffer();
  return { input, left: tileLeft, top: tileTop };
}

export async function compositeObjectsOnScene(
  sceneImage: Buffer,
  sceneWidth: number,
  sceneHeight: number,
  objects: SimpleCompositeObjectInput[],
  options: { lighting?: SceneLightingEstimate | null } = {},
): Promise<SimpleComposition> {
  const lighting = options.lighting ?? null;
  const metadata = await Promise.all(
    objects.map((object) => sharp(object.cutout).metadata()),
  );
  const specs: SimplePlacementSpec[] = objects.map((object, index) => ({
    objectIndex: object.objectIndex ?? index,
    point: object.point,
    dimensions: object.dimensions,
    pixelsPerCm: object.pixelsPerCm,
    scaleSource: object.scaleSource,
    kind: object.kind,
    cutout: {
      widthPx: Math.max(1, metadata[index]?.width ?? 1),
      heightPx: Math.max(1, metadata[index]?.height ?? 1),
      baseRowFraction: object.baseRowFraction,
    },
  }));
  const placements = planSimplePlacements(sceneWidth, sceneHeight, specs);

  const placed: PlacedOverlay[] = await Promise.all(
    placements.map(async (placement, index) => {
      const object = objects[index] as SimpleCompositeObjectInput;
      // The tile is cropped to the frame here, once, for every consumer.
      // An object may legitimately be larger than the photograph — the frame
      // cuts it, exactly as a camera would — but sharp refuses to composite a
      // tile bigger than its base ("Image to composite must have same
      // dimensions or smaller"), and negative offsets do not exempt it.
      // `extract` chained after `resize` is a post-resize crop, one of the few
      // places where sharp honours chaining order.
      const visible = placement.visible ?? {
        left: Math.max(0, placement.left),
        top: Math.max(0, placement.top),
        width: placement.widthPx,
        height: placement.heightPx,
      };
      const cropLeft = Math.max(0, -placement.left);
      const cropTop = Math.max(0, -placement.top);
      const cropped =
        cropLeft > 0 ||
        cropTop > 0 ||
        visible.width !== placement.widthPx ||
        visible.height !== placement.heightPx;
      const resized = sharp(object.cutout).ensureAlpha().resize({
        width: placement.widthPx,
        height: placement.heightPx,
        fit: "fill",
      });
      const png = await (
        cropped
          ? resized.extract({
              left: cropLeft,
              top: cropTop,
              width: visible.width,
              height: visible.height,
            })
          : resized
      )
        .png()
        .toBuffer();
      return {
        png,
        left: visible.left,
        top: visible.top,
        // Deliberately the FULL box, not the cropped tile: these two drive the
        // contact-shadow ellipse and its editable window, which must keep the
        // object's real footprint even when the frame cuts the object off.
        widthPx: placement.widthPx,
        heightPx: placement.heightPx,
        baseX: placement.baseX,
        baseY: placement.baseY,
        kind: placement.kind,
        depthKey: placement.depthKey,
        objectIndex: placement.objectIndex,
      };
    }),
  );
  // Farther objects composite first so nearer ones overlap them.
  const overlays = orderByDepth(placed);
  const maskRaw = await createSilhouetteMask(
    sceneWidth,
    sceneHeight,
    overlays,
    lighting,
  );

  const overlayLayers = overlays.map((overlay) => ({
    input: overlay.png,
    left: overlay.left,
    top: overlay.top,
    blend: "over" as const,
  }));
  const baseWebp = await sharp(sceneImage)
    .composite(overlayLayers)
    .webp({ lossless: true })
    .toBuffer();

  const modelLayers: Array<{
    input: Buffer;
    left: number;
    top: number;
    blend: "over";
  }> = [];
  for (const [index, overlay] of overlays.entries()) {
    if (overlay.kind === "standing") {
      const placeholder = await createShadowPlaceholder(
        overlay,
        maskRaw,
        sceneWidth,
        sceneHeight,
      );
      if (placeholder) modelLayers.push({ ...placeholder, blend: "over" });
    }
    modelLayers.push(overlayLayers[index] as (typeof overlayLayers)[number]);
  }
  const imageWebp = await sharp(sceneImage)
    .composite(modelLayers)
    .webp({ lossless: true })
    .toBuffer();

  return {
    sceneWebp: await sharp(sceneImage).webp({ lossless: true }).toBuffer(),
    imageWebp,
    baseWebp,
    maskRaw,
    sceneWidth,
    sceneHeight,
    placements,
    overlays,
    lighting,
  };
}

/**
 * gpt-image-2 only outputs 1024x1024 / 1536x1024 / 1024x1536. When the scene
 * has a different aspect ratio the composite is letterboxed with neutral gray
 * (masked as non-editable) so the model never crops; the bars are removed
 * before paste-back.
 */
export async function padCompositionForAspect(
  composition: CompositionLike,
  requestedSize: string,
): Promise<PaddedComposition> {
  const [requestedWidth, requestedHeight] = requestedSize
    .split("x")
    .map((part) => Number(part));
  const targetRatio = (requestedWidth || 1) / Math.max(1, requestedHeight || 1);
  const { sceneWidth, sceneHeight } = composition;
  const ratio = sceneWidth / sceneHeight;
  let paddedWidth = sceneWidth;
  let paddedHeight = sceneHeight;
  if (Math.abs(ratio - targetRatio) / targetRatio > 0.01) {
    if (ratio > targetRatio) {
      paddedHeight = Math.round(sceneWidth / targetRatio);
    } else {
      paddedWidth = Math.round(sceneHeight * targetRatio);
    }
  }
  const offsetX = Math.floor((paddedWidth - sceneWidth) / 2);
  const offsetY = Math.floor((paddedHeight - sceneHeight) / 2);
  const padded = paddedWidth !== sceneWidth || paddedHeight !== sceneHeight;

  const imageWebp = padded
    ? await sharp(composition.imageWebp)
        .extend({
          top: offsetY,
          bottom: paddedHeight - sceneHeight - offsetY,
          left: offsetX,
          right: paddedWidth - sceneWidth - offsetX,
          background: { r: 118, g: 118, b: 118, alpha: 1 },
        })
        .webp({ lossless: true })
        .toBuffer()
    : composition.imageWebp;

  let maskPng: Buffer;
  if (!padded) {
    maskPng = await sharp(composition.maskRaw, {
      raw: { width: sceneWidth, height: sceneHeight, channels: 4 },
    })
      .png()
      .toBuffer();
  } else {
    const paddedMask = Buffer.alloc(paddedWidth * paddedHeight * 4, 255);
    for (let y = 0; y < sceneHeight; y += 1) {
      composition.maskRaw.copy(
        paddedMask,
        ((y + offsetY) * paddedWidth + offsetX) * 4,
        y * sceneWidth * 4,
        (y + 1) * sceneWidth * 4,
      );
    }
    maskPng = await sharp(paddedMask, {
      raw: { width: paddedWidth, height: paddedHeight, channels: 4 },
    })
      .png()
      .toBuffer();
  }
  return {
    imageWebp,
    maskPng,
    offsetX,
    offsetY,
    paddedWidth,
    paddedHeight,
    padded,
  };
}

/** Defensive far-to-near order for the identity stamps. */
function stampOrder(overlays: PlacedOverlay[]): PlacedOverlay[] {
  return [...overlays].sort(
    (a, b) =>
      a.depthKey - b.depthKey ||
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      a.objectIndex - b.objectIndex,
  );
}

/**
 * Preserve source texture, hue and alpha while transferring a bounded broad
 * lighting field. Generated detail and geometry are never copied. A global
 * chromatic/exposure gate rejects a changed product or a misregistered output;
 * valid local samples are normalized by their blurred weights, so transparent
 * corners and the room cannot darken a thin product edge.
 */
async function relightProductPixels(
  placed: PlacedOverlay,
  alignedModel: Buffer,
  strength: number,
  lighting?: SceneLightingEstimate | null,
): Promise<Buffer> {
  const { data: source, info } = await sharp(placed.png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const model = await sharp(alignedModel)
    .extract({
      left: placed.left,
      top: placed.top,
      width,
      height,
    })
    .removeAlpha()
    .raw()
    .toBuffer();
  const weights = Buffer.alloc(width * height);
  const gains = Buffer.alloc(width * height);
  let solid = 0;
  let compatible = 0;
  for (let i = 0; i < width * height; i += 1) {
    if ((source[i * 4 + 3] ?? 0) < 245) continue;
    solid += 1;
    const sr = source[i * 4] ?? 0;
    const sg = source[i * 4 + 1] ?? 0;
    const sb = source[i * 4 + 2] ?? 0;
    const mr = model[i * 3] ?? 0;
    const mg = model[i * 3 + 1] ?? 0;
    const mb = model[i * 3 + 2] ?? 0;
    const sourceSum = sr + sg + sb;
    const modelSum = mr + mg + mb;
    const luminance = 0.2126 * sr + 0.7152 * sg + 0.0722 * sb;
    const modelLuminance = 0.2126 * mr + 0.7152 * mg + 0.0722 * mb;
    if (luminance < 12 || sourceSum === 0 || modelSum === 0) continue;
    const ratio = modelLuminance / luminance;
    const chromaDifference = Math.max(
      Math.abs(sr / sourceSum - mr / modelSum),
      Math.abs(sg / sourceSum - mg / modelSum),
      Math.abs(sb / sourceSum - mb / modelSum),
    );
    if (chromaDifference > 0.08 || ratio < 0.65 || ratio > 1.5) continue;
    compatible += 1;
    weights[i] = 255;
    // Map gain [-12%, +12%] to [0,255] for a normalized blur.
    gains[i] = Math.round(
      (clampNumber(ratio - 1, -MAX_RELIGHT_GAIN, MAX_RELIGHT_GAIN) /
        MAX_RELIGHT_GAIN +
        1) *
        127.5,
    );
  }
  const compatibleField = solid >= 16 && compatible / solid >= 0.65;
  // A displaced model cannot supply a registered light field. In the opt-in
  // insertion path, the observed room light still supplies a broad lateral
  // correction to a standing volume. A half sine has no edge discontinuity
  // or product-frequency detail: the catalogue texture is multiplied, never
  // replaced. Wall/flat items and non-lateral light have no inferred normal.
  const direction =
    placed.kind !== "standing"
      ? 0
      : lighting?.lightDirection === "right"
        ? 1
        : lighting?.lightDirection === "left"
          ? -1
          : 0;
  if (!compatibleField && direction === 0) return placed.png;
  const sigma = clampNumber(Math.min(width, height) / 10, 2, 32);
  const [smoothWeights, smoothGains] = compatibleField
    ? await Promise.all([
        blurGreyscale(weights, width, height, sigma),
        blurGreyscale(gains, width, height, sigma),
      ])
    : [Buffer.alloc(width * height), Buffer.alloc(width * height)];
  for (let i = 0; i < width * height; i += 1) {
    const weight = smoothWeights[i] ?? 0;
    if (weight < 32 && direction === 0) continue;
    const modelDelta =
      weight >= 32
        ? ((smoothGains[i] ?? 0) / weight * 2 - 1) * MAX_RELIGHT_GAIN
        : 0;
    const lateral = width > 1 ? (2 * (i % width)) / (width - 1) - 1 : 0;
    const sceneDelta = direction * Math.sin(lateral * Math.PI / 2) * MAX_RELIGHT_GAIN;
    const proposedGain =
      1 +
      clampNumber(
        // Bound the TOTAL relative to the source, not two stacked gains.
        modelDelta + sceneDelta,
        -MAX_RELIGHT_GAIN,
        MAX_RELIGHT_GAIN,
      ) *
        strength;
    const brightest = Math.max(
      source[i * 4] ?? 0,
      source[i * 4 + 1] ?? 0,
      source[i * 4 + 2] ?? 0,
    );
    const gain = Math.min(proposedGain, brightest > 0 ? 255 / brightest : 1);
    for (let channel = 0; channel < 3; channel += 1) {
      source[i * 4 + channel] = clampNumber(
        Math.round((source[i * 4 + channel] ?? 0) * gain),
        0,
        255,
      );
    }
  }
  return sharp(source, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

/**
 * Source-alpha shadow, anchored to the actual foot rather than its bounding
 * box. The silhouette is projected away from the observed lateral light and
 * softened on the support. This is an explicit geometric approximation, not
 * generated scene content. The final edit mask still bounds every pixel.
 */
async function sourceShadowField(
  composition: CompositionLike,
): Promise<Buffer> {
  const { sceneWidth: width, sceneHeight: height, lighting } = composition;
  const field = Buffer.alloc(width * height);
  if (!lighting) return field;
  for (const placed of composition.overlays) {
    if (placed.kind !== "standing") continue;
    const { alpha, width: ow, height: oh } = await overlayAlpha(placed.png);
    const baseRow = clampNumber(
      Math.round(placed.baseY - placed.top) - 1,
      0,
      oh - 1,
    );
    const footBand = clampNumber(Math.round(placed.heightPx * 0.04), 2, 8);
    let footLeft = ow,
      footRight = -1;
    for (let y = Math.max(0, baseRow - footBand + 1); y <= baseRow; y += 1) {
      for (let x = 0; x < ow; x += 1) {
        if ((alpha[y * ow + x] ?? 0) >= 128) {
          footLeft = Math.min(footLeft, x);
          footRight = Math.max(footRight, x);
        }
      }
    }
    // A cropped or transparent foot is not evidence of a support contact.
    if (footRight < footLeft) continue;
    const cast = Buffer.alloc(width * height);
    const direction =
      lighting.shadowDirection === "left"
        ? -1
        : lighting.shadowDirection === "right"
          ? 1
          : 0;
    if (direction !== 0) {
      const lengthFactor =
        lighting.lightElevation === "high"
          ? 0.42
          : lighting.lightElevation === "mid"
            ? 0.65
            : 0.9;
      const length = Math.min(
        placed.heightPx * lengthFactor,
        placed.widthPx * 0.65,
      );
      for (let y = 0; y <= baseRow; y += 1) {
        for (let x = 0; x < ow; x += 1) {
          const a = alpha[y * ow + x] ?? 0;
          if (!a) continue;
          const fraction = (baseRow - y) / Math.max(1, placed.heightPx - 1);
          const px = placed.left + x + direction * fraction * length;
          const py = placed.baseY + fraction * placed.heightPx * 0.075;
          const x0 = Math.floor(px),
            y0 = Math.floor(py);
          for (let yy = y0; yy <= y0 + 1; yy += 1) {
            for (let xx = x0; xx <= x0 + 1; xx += 1) {
              if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
              const weight = (1 - Math.abs(xx - px)) * (1 - Math.abs(yy - py));
              const i = yy * width + xx;
              cast[i] = Math.max(cast[i] ?? 0, Math.round(a * weight));
            }
          }
        }
      }
    }
    const softness = lighting.shadowSoftness === "soft" ? 0.025 : 0.008;
    const softened = await blurGreyscale(
      cast,
      width,
      height,
      clampNumber(placed.widthPx * softness, 0.5, 8),
    );
    const cx = placed.left + (footLeft + footRight) / 2;
    const rx = Math.max(1, (footRight - footLeft) / 2);
    const ry = clampNumber(placed.heightPx * 0.014, 0.7, 3);
    for (
      let y = Math.max(0, placed.baseY - SHADOW_WINDOW_ABOVE_BASE_PX);
      y <=
      Math.min(
        height - 1,
        Math.ceil(placed.baseY + Math.max(10, placed.heightPx * 0.07)),
      );
      y += 1
    ) {
      for (
        let x = Math.max(0, Math.floor(placed.baseX - placed.widthPx * 1.2));
        x <=
        Math.min(width - 1, Math.ceil(placed.baseX + placed.widthPx * 1.2));
        x += 1
      ) {
        const i = y * width + x;
        if (composition.maskRaw[i * 4 + 3] !== 0) continue;
        const dx = (x - cx) / rx;
        const dy = (y - placed.baseY - 0.15) / ry;
        const contact = Math.exp(-2 * (dx * dx + dy * dy)) * 0.34;
        const attenuation = Math.min(
          MAX_SOURCE_SHADOW_DARKENING,
          contact + ((softened[i] ?? 0) / 255) * 0.18,
        );
        // Use the strongest local shadow, not additive layers that can turn
        // overlapping supports into an unbounded black patch.
        field[i] = Math.max(field[i] ?? 0, Math.round(attenuation * 255));
      }
    }
  }
  return field;
}

/**
 * A bright fringe can survive matting and resize on a thick product contour.
 * Mix only its alpha with a one-pixel minimum by 0.35, never its RGB. Opening
 * the binary silhouette identifies thick material: wires, handle rims and
 * isolated crown tips without a three-pixel interior keep their original alpha.
 * Dark/coloured edges and all fully surrounded pixels are also unchanged.
 * This must be recomposed on a real room, never on the already-stamped base.
 */
export async function softenBrightContour(png: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const original = Buffer.alloc(width * height);
  const brightMaterial = new Uint8Array(width * height);
  for (let i = 0; i < original.length; i += 1) {
    original[i] = data[i * 4 + 3] ?? 0;
    const r = data[i * 4] ?? 0,
      g = data[i * 4 + 1] ?? 0,
      b = data[i * 4 + 2] ?? 0;
    if (
      original[i] &&
      0.2126 * r + 0.7152 * g + 0.0722 * b >= 185 &&
      Math.min(r, g, b) >= 145 &&
      Math.max(r, g, b) - Math.min(r, g, b) <= 80
    )
      brightMaterial[i] = 1;
  }
  const thick = dilateBinary(
    erodeBinary(binarize(original), width, height, 3),
    width,
    height,
    3,
  );
  let changed = false;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const alpha = original[i] ?? 0;
      if (!alpha || !thick[i]) continue;
      if (!brightMaterial[i]) continue;
      let minimum = alpha;
      let brightNeighbours = 0,
        darkNeighbours = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const sx = x + dx,
            sy = y + dy;
          minimum = Math.min(
            minimum,
            sx < 0 || sy < 0 || sx >= width || sy >= height
              ? 0
              : (original[sy * width + sx] ?? 0),
          );
          if (
            sx >= 0 &&
            sy >= 0 &&
            sx < width &&
            sy < height &&
            (original[sy * width + sx] ?? 0) >= 245
          ) {
            if (brightMaterial[sy * width + sx]) brightNeighbours += 1;
            else darkNeighbours += 1;
          }
        }
      }
      // At a dark detail's junction with bright material, a pale fractional
      // pixel belongs to the detail's antialiasing, not a broad white rim.
      if (alpha < 128 && darkNeighbours > brightNeighbours) continue;
      const contracted = Math.round(
        alpha * (1 - BRIGHT_CONTOUR_TRIM) + minimum * BRIGHT_CONTOUR_TRIM,
      );
      if (contracted === alpha) continue;
      data[i * 4 + 3] = contracted;
      changed = true;
    }
  }
  return changed
    ? sharp(data, { raw: { width, height, channels: 4 } })
        .png()
        .toBuffer()
    : png;
}

/**
 * Product insertion must never copy generated RGB, even in the silhouette
 * ring: a displaced model rendition survives there as a second object. Keep
 * the original composite and transfer only a smooth, achromatic light field.
 * Product alpha, source detail and support texture remain authoritative.
 */
async function transferContactLight(
  composition: CompositionLike,
  alignedModel: Buffer,
  options: { featherSigma?: number; relightStrength?: number },
): Promise<Buffer> {
  const { sceneWidth: width, sceneHeight: height } = composition;
  const [source, model] = await Promise.all([
    sharp(composition.baseWebp ?? composition.imageWebp)
      .removeAlpha()
      .raw()
      .toBuffer(),
    sharp(alignedModel).removeAlpha().raw().toBuffer(),
  ]);
  const ordered = stampOrder(composition.overlays);
  const tiles = await Promise.all(
    ordered.map(async (placed) => ({
      placed,
      ...(await sharp(placed.png)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })),
    })),
  );
  const productPixels = new Uint8Array(width * height);
  const support = new Uint8Array(width * height);
  for (const { placed, data, info } of tiles) {
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        const sx = placed.left + x;
        const sy = placed.top + y;
        if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
        if ((data[(y * info.width + x) * 4 + 3] ?? 0) > 0)
          productPixels[sy * width + sx] = 1;
      }
    }
    // Standing products can shade the support only, never their surrounding
    // wall. Wall/flat products retain their existing silhouette-shaped cast
    // shadow/contact ring, bounded by the original edit mask below.
    const margin =
      placed.kind === "standing" ? Math.ceil(placed.widthPx * 1.2) : 38; // maximum ring (12) + cast offset (14) + ring (12)
    const left =
      placed.kind === "standing" ? placed.baseX - margin : placed.left - margin;
    const right =
      placed.kind === "standing"
        ? placed.baseX + margin
        : placed.left + info.width + margin;
    const top =
      placed.kind === "standing"
        ? placed.baseY - SHADOW_WINDOW_ABOVE_BASE_PX
        : placed.top - margin;
    const bottom =
      placed.kind === "standing"
        ? placed.baseY + Math.max(10, 0.07 * placed.heightPx)
        : placed.top + info.height + margin;
    for (
      let y = Math.max(0, Math.ceil(top));
      y <= Math.min(height - 1, Math.floor(bottom));
      y += 1
    ) {
      for (
        let x = Math.max(0, Math.ceil(left));
        x <= Math.min(width - 1, Math.floor(right));
        x += 1
      ) {
        const i = y * width + x;
        if (composition.maskRaw[i * 4 + 3] === 0) support[i] = 1;
      }
    }
  }

  const darkening = Buffer.alloc(width * height);
  for (let i = 0; i < darkening.length; i += 1) {
    if (!support[i] || productPixels[i]) continue;
    const sr = source[i * 3] ?? 0;
    const sg = source[i * 3 + 1] ?? 0;
    const sb = source[i * 3 + 2] ?? 0;
    const mr = model[i * 3] ?? 0;
    const mg = model[i * 3 + 1] ?? 0;
    const mb = model[i * 3 + 2] ?? 0;
    const sum = sr + sg + sb;
    const modelSum = mr + mg + mb;
    const luminance = 0.2126 * sr + 0.7152 * sg + 0.0722 * sb;
    if (luminance < 12 || modelSum === 0) continue;
    const ratio = (0.2126 * mr + 0.7152 * mg + 0.0722 * mb) / luminance;
    const chromaDifference = Math.max(
      Math.abs(sr / sum - mr / modelSum),
      Math.abs(sg / sum - mg / modelSum),
      Math.abs(sb / sum - mb / modelSum),
    );
    // A coloured replacement, a highlight or a very dark displaced object is
    // not evidence of a contact shadow. Rejected samples contribute zero.
    if (chromaDifference > 0.025 || ratio < 0.65 || ratio >= 1) continue;
    darkening[i] = Math.round(Math.min(MAX_CONTACT_DARKENING, 1 - ratio) * 255);
  }
  const smooth = await blurGreyscale(
    darkening,
    width,
    height,
    clampNumber(options.featherSigma ?? 3, 2, 12),
  );
  if (composition.sceneWebp && composition.lighting) {
    const shadow = await sourceShadowField(composition);
    const room = await sharp(composition.sceneWebp)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (room.info.width !== width || room.info.height !== height)
      throw new SimpleCompositeError(
        "La scène de référence ne correspond pas au composite.",
      );
    for (let i = 0; i < width * height; i += 1) {
      if (!support[i]) continue;
      const attenuation = Math.min(
        MAX_SOURCE_SHADOW_DARKENING,
        Math.max((shadow[i] ?? 0) / 255, (smooth[i] ?? 0) / 255),
      );
      for (let channel = 0; channel < 3; channel += 1)
        room.data[i * 3 + channel] = Math.round(
          (room.data[i * 3 + channel] ?? 0) * (1 - attenuation),
        );
    }
    const strength = clampNumber(options.relightStrength ?? 1, 0, 1);
    const stamps = await Promise.all(
      ordered.map(async (placed) => {
        const lit =
          strength > 0
            ? await relightProductPixels(placed, alignedModel, strength, composition.lighting)
            : placed.png;
        // Decide the fringe from the unmodified catalogue pixels, not from
        // a generated light field. Only alpha comes from this cleanup.
        const contour =
          placed.kind === "standing"
            ? await softenBrightContour(placed.png)
            : placed.png;
        let input = lit;
        if (contour !== placed.png) {
          const { alpha, width: ow, height: oh } = await overlayAlpha(contour);
          const rgb = await sharp(lit).removeAlpha().png().toBuffer();
          input = await sharp(rgb)
            .joinChannel(alpha, {
              raw: { width: ow, height: oh, channels: 1 },
            })
            .png()
            .toBuffer();
        }
        return {
          input,
          left: placed.left,
          top: placed.top,
          blend: "over" as const,
        };
      }),
    );
    // Stamp once onto the actual room. Bright thick outlines receive only a
    // subpixel alpha cleanup; thin details and interior highlights stay intact.
    return sharp(room.data, { raw: { width, height, channels: 3 } })
      .composite(stamps)
      .webp({ lossless: true })
      .toBuffer();
  }
  const output = Buffer.from(source);
  for (let i = 0; i < smooth.length; i += 1) {
    // Clip AFTER blur as well: no feather tail may darken a wall or a product
    // edge. Geometry and the original editable mask remain hard boundaries.
    if (!support[i] || productPixels[i]) continue;
    const gain = 1 - Math.min(MAX_CONTACT_DARKENING, (smooth[i] ?? 0) / 255);
    for (let channel = 0; channel < 3; channel += 1)
      output[i * 3 + channel] = Math.round(
        (source[i * 3 + channel] ?? 0) * gain,
      );
  }

  // Identity is already stamped in baseWebp. Apply only the difference from
  // relighting the SOURCE, weighted by its complete alpha and visibility.
  // Re-stamping semi-transparent pixels over themselves would double their
  // opacity and invent an outline. Near-to-far visibility also prevents a
  // rear product's relighting from changing the nearer product's pixels.
  const remaining = new Float32Array(width * height).fill(1);
  const strength = clampNumber(options.relightStrength ?? 1, 0, 1);
  for (const { placed, data: original, info } of [...tiles].reverse()) {
    const lit =
      strength > 0
        ? await sharp(
            await relightProductPixels(placed, alignedModel, strength, composition.lighting),
          )
            .ensureAlpha()
            .raw()
            .toBuffer()
        : original;
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        const sx = placed.left + x;
        const sy = placed.top + y;
        if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
        const i = sy * width + sx;
        const ti = (y * info.width + x) * 4;
        const alpha = (original[ti + 3] ?? 0) / 255;
        const visible = alpha * (remaining[i] ?? 0);
        for (let channel = 0; channel < 3; channel += 1) {
          const delta =
            (lit[ti + channel] ?? 0) - (original[ti + channel] ?? 0);
          output[i * 3 + channel] = clampNumber(
            Math.round((output[i * 3 + channel] ?? 0) + delta * visible),
            0,
            255,
          );
        }
        remaining[i] = (remaining[i] ?? 0) * (1 - alpha);
      }
    }
  }
  return sharp(output, { raw: { width, height, channels: 3 } })
    .webp({ lossless: true })
    .toBuffer();
}

/**
 * The hard guarantee: outside the feathered edit mask, every pixel of the
 * final image comes from the placeholder-free composite, never from the
 * model. Inside it, the object core is re-stamped from the catalog cutout.
 */
export async function pasteBackOutsideMask(
  composition: CompositionLike,
  padded: PaddedComposition,
  modelOutput: Buffer,
  options: {
    featherSigma?: number;
    relightStrength?: number;
    /** Opt-in insertion policy. Obstacle removal still needs generated RGB. */
    transferMode?: "masked-rgb" | "contact-light";
  } = {},
): Promise<Buffer> {
  const { sceneWidth, sceneHeight } = composition;
  const base = composition.baseWebp ?? composition.imageWebp;
  const featherSigma = options.featherSigma ?? 3;
  const aligned = await sharp(modelOutput)
    .resize(padded.paddedWidth, padded.paddedHeight, { fit: "fill" })
    .extract({
      left: padded.offsetX,
      top: padded.offsetY,
      width: sceneWidth,
      height: sceneHeight,
    })
    .removeAlpha()
    .png()
    .toBuffer();

  if (
    options.transferMode === "contact-light" &&
    composition.overlays.length > 0
  )
    return transferContactLight(composition, aligned, options);

  const alpha = Buffer.alloc(sceneWidth * sceneHeight);
  for (let i = 0; i < sceneWidth * sceneHeight; i += 1) {
    alpha[i] = composition.maskRaw[i * 4 + 3] === 0 ? 255 : 0;
  }
  const feathered = await blurGreyscale(
    alpha,
    sceneWidth,
    sceneHeight,
    featherSigma,
  );
  const overlay = await sharp(aligned)
    .joinChannel(feathered, {
      raw: { width: sceneWidth, height: sceneHeight, channels: 1 },
    })
    .png()
    .toBuffer();

  // Identity re-stamp: the model's rendition of the object (softened by
  // regeneration and resampling) is covered again by the source texture,
  // eroded 2 px so the model keeps only the blend ring and the shadow.
  // A bounded broad luminance field supplies lighting without generated detail.
  const relightStrength = clampNumber(options.relightStrength ?? 1, 0, 1);
  const stamps = await Promise.all(
    stampOrder(composition.overlays).map(async (placed) => {
      const { alpha: original, width, height } = await overlayAlpha(placed.png);
      // Explicit JS erosion on the RAW alpha — sharp's blur/threshold are
      // applied in a fixed order and never erode. The eroded core is
      // multiplied by the original alpha: outside the silhouette the stamp is
      // exactly transparent, so the black RGB that removeAlpha() exposes under
      // transparent pixels can never bleed out.
      const core = erodeBinary(
        binarize(original),
        width,
        height,
        STAMP_EROSION_PX,
      );
      // Thin legs, wires and small calibrated products must not disappear
      // from the identity stamp just because a fixed erosion eats their core.
      const thin = dilateBinary(core, width, height, STAMP_EROSION_PX);
      const stampAlpha = Buffer.alloc(width * height, 0);
      for (let i = 0; i < stampAlpha.length; i += 1) {
        stampAlpha[i] = core[i] === 1 || thin[i] === 0 ? (original[i] ?? 0) : 0;
      }
      // removeAlpha and joinChannel cannot share a pipeline: sharp applies
      // them in a fixed internal order that yields a 3-channel image with no
      // alpha at all — an opaque tile that would paint its black corners
      // over the scene. Two passes, always. For the same reason removeAlpha()
      // stands alone here: paired with ensureAlpha() in one pipeline it is
      // reordered and returns four channels with alpha 255 everywhere, so the
      // joined stamp alpha is ignored and the tile turns opaque again.
      const litPixels =
        relightStrength > 0
          ? await relightProductPixels(placed, aligned, relightStrength)
          : placed.png;
      const stampRgb = await sharp(litPixels).removeAlpha().png().toBuffer();
      const stamp = await sharp(stampRgb)
        .joinChannel(stampAlpha, { raw: { width, height, channels: 1 } })
        .png()
        .toBuffer();
      return {
        input: stamp,
        left: placed.left,
        top: placed.top,
        blend: "over" as const,
      };
    }),
  );
  return (
    sharp(base)
      .composite([{ input: overlay, blend: "over" }, ...stamps])
      // Lossy WebP chroma subsampling erases a two-pixel wire or changes its
      // colour even when the identity stamp is perfect. Encode once losslessly.
      .webp({ lossless: true })
      .toBuffer()
  );
}
