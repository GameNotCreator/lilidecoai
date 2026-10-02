import sharp from "sharp";
import type { StorefrontScaleReference } from "./ai/storefront-placement-review";
import type { StorefrontPerspectiveGuideObject } from "./storefront-perspective-guide";

export interface StorefrontPerspectiveGuideWindowInput {
  guide: Buffer;
  /** The oriented original frame, before letterbox padding. */
  width: number;
  height: number;
  objects: readonly StorefrontPerspectiveGuideObject[];
  /** Optional uniform fit within this square; no resize when omitted. */
  maxDimension?: number;
  /** Include the reference's 101/102 markers when the source guide has them. */
  reference?: StorefrontScaleReference;
}

export interface StorefrontPerspectiveGuideWindowResult {
  image: Buffer;
  /** Crop bounds in original pixels, before any optional uniform resize. */
  window: { left: number; top: number; width: number; height: number };
  originalFrame: { width: number; height: number };
}

type Bounds = { left: number; top: number; right: number; bottom: number };
type Rotation = { x: number; y: number; angle: number };
const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const validPoint = (point: { x: number; y: number } | undefined) =>
  point != null && [point.x, point.y].every(value =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1);
const validAngle = (value: unknown, minimum: number, maximum: number) =>
  value === null || (typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum);

function validate(input: StorefrontPerspectiveGuideWindowInput) {
  if (!input || !Buffer.isBuffer(input.guide) || input.guide.length === 0 || input.guide.length > 32_000_000 ||
    !Number.isSafeInteger(input.width) || input.width < 1 || input.width > 8192 ||
    !Number.isSafeInteger(input.height) || input.height < 1 || input.height > 8192 ||
    input.width * input.height > 16_000_000 ||
    !Array.isArray(input.objects) || input.objects.length < 1 || input.objects.length > 3 ||
    (input.maxDimension !== undefined && (!Number.isSafeInteger(input.maxDimension) || input.maxDimension < 1 || input.maxDimension > 4096)))
    throw new Error("Données de la fenêtre du guide invalides.");
  const indices = new Set<number>();
  for (const object of input.objects) {
    if (!object || !Number.isInteger(object.index) || object.index < 0 || object.index > 2 ||
      indices.has(object.index) || !validPoint(object.point) ||
      !["standing", "wall", "flat"].includes(object.kind) || !positive(object.pixelsPerCm) ||
      !object.dimensionsCm || ![object.dimensionsCm.width, object.dimensionsCm.height, object.dimensionsCm.depth]
        .every(value => positive(value) && positive(value * object.pixelsPerCm)))
      throw new Error("Mesures ou ancrage de la fenêtre du guide invalides.");
    if (object.pose !== undefined && (!object.pose ||
      !validAngle(object.pose.cameraElevationDegrees, 0, 85) ||
      !validAngle(object.pose.cameraRollDegrees, -30, 30)))
      throw new Error("Angles de la fenêtre du guide invalides.");
    indices.add(object.index);
  }
  const reference = input.reference;
  if (reference && (!positive(reference.realHeightCm) || reference.sameDepthConfirmed !== true ||
    !validPoint(reference.basePoint) || !validPoint(reference.topPoint) ||
    reference.basePoint.y - reference.topPoint.y <= 0.005))
    throw new Error("Référence de hauteur de la fenêtre du guide invalide.");
}

function include(bounds: Bounds, box: Bounds, rotation?: Rotation) {
  const radians = (rotation?.angle ?? 0) * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  for (const [x, y] of [[box.left, box.top], [box.right, box.top], [box.left, box.bottom], [box.right, box.bottom]]) {
    const dx = x! - (rotation?.x ?? 0);
    const dy = y! - (rotation?.y ?? 0);
    const projectedX = rotation ? rotation.x + dx * cosine - dy * sine : x!;
    const projectedY = rotation ? rotation.y + dx * sine + dy * cosine : y!;
    if (!Number.isFinite(projectedX) || !Number.isFinite(projectedY))
      throw new Error("Étendue de la fenêtre du guide invalide.");
    bounds.left = Math.min(bounds.left, projectedX);
    bounds.top = Math.min(bounds.top, projectedY);
    bounds.right = Math.max(bounds.right, projectedX);
    bounds.bottom = Math.max(bounds.bottom, projectedY);
  }
}

/** A camera-reference crop only: no added drawing, catalogue pixels or new pose. */
export async function localiseStorefrontPerspectiveGuide(
  input: StorefrontPerspectiveGuideWindowInput,
): Promise<StorefrontPerspectiveGuideWindowResult> {
  validate(input);
  const { guide, width, height, objects, reference, maxDimension } = input;
  const metadata = await sharp(guide, { limitInputPixels: 16_000_000 }).metadata();
  if (metadata.width !== width || metadata.height !== height ||
    (metadata.pages !== undefined && metadata.pages !== 1) ||
    (metadata.orientation !== undefined && metadata.orientation !== 1))
    throw new Error("Dimensions du guide et de sa fenêtre incohérentes.");

  // Match the existing v3 guide's original-pixel geometry, including its text.
  const radius = clamp(Math.round(Math.min(width, height) / 180), 3, 7);
  const fontSize = clamp(Math.round(Math.min(width, height) / 60), 10, 20);
  const stroke = clamp(Math.min(width, height) / 600, 1, 2);
  const bounds: Bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  const pixel = (point: { x: number; y: number }) => ({
    x: clamp(Math.round(point.x * width), 0, width - 1),
    y: clamp(Math.round(point.y * height), 0, height - 1),
  });
  const textBounds = (x: number, y: number, text: string): Bounds => ({
    left: x - 2, top: y - fontSize - 2,
    right: x + fontSize * text.length + 2, bottom: y + fontSize * 0.35 + 2,
  });
  const marker = (point: { x: number; y: number }, label: number) => {
    const contact = pixel(point);
    include(bounds, { left: contact.x - radius - 2, top: contact.y - radius - 2,
      right: contact.x + radius + 2, bottom: contact.y + radius + 2 });
    const text = String(label);
    const textX = clamp(contact.x + radius + 5, 1, Math.max(1, width - fontSize * text.length));
    const textY = clamp(contact.y - radius - 4, fontSize, Math.max(fontSize, height - 2));
    include(bounds, textBounds(textX, textY, text));
  };
  let maximumPhysicalExtent = 0;
  for (const object of objects) {
    const anchor = pixel(object.point);
    const projectedWidth = object.dimensionsCm.width * object.pixelsPerCm;
    const projectedHeight = object.dimensionsCm.height * object.pixelsPerCm;
    const projectedDepth = object.dimensionsCm.depth * object.pixelsPerCm;
    maximumPhysicalExtent = Math.max(maximumPhysicalExtent, projectedWidth, projectedHeight, projectedDepth);
    const rotation = object.kind === "standing" && object.pose
      ? { ...anchor, angle: object.pose.cameraRollDegrees ?? 0 } : undefined;
    const topDepth = object.kind === "standing" && object.pose?.cameraElevationDegrees != null
      ? projectedDepth * Math.sin(object.pose.cameraElevationDegrees * Math.PI / 180) : 0;
    const boxHeight = object.kind === "flat" ? projectedDepth : projectedHeight;
    const left = anchor.x - projectedWidth / 2;
    const top = anchor.y - (object.kind === "standing" ? boxHeight : boxHeight / 2);
    include(bounds, { left: left - stroke, right: left + projectedWidth + stroke,
      top: top - topDepth - stroke, bottom: top + boxHeight + stroke }, rotation);

    const segmentBottom = object.kind === "wall" ? anchor.y + projectedHeight / 2 : anchor.y;
    const segmentTop = segmentBottom - projectedHeight;
    const segmentX = clamp(left + projectedWidth + radius + 6, 1, Math.max(1, width - 2));
    include(bounds, { left: segmentX - 3 - stroke, right: segmentX + 3 + stroke,
      top: segmentTop - stroke, bottom: segmentBottom + stroke }, rotation);
    include(bounds, textBounds(
      clamp(segmentX + 5, 1, Math.max(1, width - fontSize * 5)),
      clamp(segmentTop - 4, fontSize, Math.max(fontSize, height - 2)),
      `${Math.round(projectedHeight)} px`,
    ), rotation);
    marker(object.point, object.index + 1);
  }
  if (reference) {
    const base = pixel(reference.basePoint);
    const top = pixel(reference.topPoint);
    include(bounds, { left: Math.min(base.x, top.x) - stroke, right: Math.max(base.x, top.x) + stroke,
      top: Math.min(base.y, top.y) - stroke, bottom: Math.max(base.y, top.y) + stroke });
    marker(reference.basePoint, 101);
    marker(reference.topPoint, 102);
  }
  const margin = maximumPhysicalExtent * 0.7;
  const left = clamp(Math.floor(bounds.left - margin), 0, width - 1);
  const top = clamp(Math.floor(bounds.top - margin), 0, height - 1);
  const right = clamp(Math.ceil(bounds.right + margin), left + 1, width);
  const bottom = clamp(Math.ceil(bounds.bottom + margin), top + 1, height);
  const window = { left, top, width: right - left, height: bottom - top };
  const originalFrame = { width, height };
  if (left === 0 && top === 0 && window.width === width && window.height === height &&
    maxDimension === undefined && metadata.format === "webp")
    return { image: guide, window, originalFrame };

  let cropped = sharp(guide, { limitInputPixels: 16_000_000 }).extract(window);
  if (maxDimension !== undefined)
    cropped = cropped.resize({ width: maxDimension, height: maxDimension, fit: "inside" });
  return { image: await cropped.webp({ lossless: true }).toBuffer(), window, originalFrame };
}
