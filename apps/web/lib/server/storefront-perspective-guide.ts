import sharp from "sharp";
import type { StorefrontScaleReference } from "./ai/storefront-placement-review";

export const STOREFRONT_GUIDED_REALISTIC_COMPOSITE_VERSION =
  "storefront-guided-perspective-v3";

export interface StorefrontPerspectiveGuideObject {
  /** Zero-based placement index. Labels 1..3 match the original selection. */
  index: number;
  point: { x: number; y: number };
  kind: "standing" | "wall" | "flat";
  dimensionsCm: { width: number; height: number; depth: number };
  pixelsPerCm: number;
  pose?: {
    /** Unknown elevation draws no inferred top face. */
    cameraElevationDegrees: number | null;
    /** Positive is clockwise; null keeps a neutral, unmeasured orientation. */
    cameraRollDegrees: number | null;
  };
}

export interface StorefrontPerspectiveGuideInput {
  room: Buffer;
  /** Dimensions of the oriented original room, before any letterbox padding. */
  width: number;
  height: number;
  objects: readonly StorefrontPerspectiveGuideObject[];
  reference?: StorefrontScaleReference;
}

const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const validPoint = (point: { x: number; y: number } | undefined) =>
  point != null &&
  [point.x, point.y].every((value) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1,
  );
const nullableAngle = (value: unknown, minimum: number, maximum: number) =>
  value === null || (
    typeof value === "number" && Number.isFinite(value) &&
    value >= minimum && value <= maximum
  );

function validate(input: StorefrontPerspectiveGuideInput): void {
  if (
    !input || !Buffer.isBuffer(input.room) || !input.room.length ||
    !Number.isSafeInteger(input.width) || input.width < 1 ||
    !Number.isSafeInteger(input.height) || input.height < 1 ||
    !Array.isArray(input.objects) || input.objects.length < 1 || input.objects.length > 3
  ) throw new Error("Données du guide de perspective invalides.");
  const indices = new Set<number>();
  for (const object of input.objects) {
    if (
      !object || !Number.isInteger(object.index) || object.index < 0 || object.index > 2 ||
      indices.has(object.index) || !validPoint(object.point) ||
      !["standing", "wall", "flat"].includes(object.kind) ||
      !positive(object.pixelsPerCm) || !object.dimensionsCm ||
      ![object.dimensionsCm.width, object.dimensionsCm.height, object.dimensionsCm.depth]
        .every((value) => positive(value) && positive(value * object.pixelsPerCm))
    ) throw new Error("Mesures ou ancrage du guide de perspective invalides.");
    if (object.pose !== undefined && (
      !object.pose ||
      !nullableAngle(object.pose.cameraElevationDegrees, 0, 85) ||
      !nullableAngle(object.pose.cameraRollDegrees, -30, 30)
    )) throw new Error("Angles du guide de perspective invalides.");
    indices.add(object.index);
  }
  const reference = input.reference;
  if (reference && (
    !positive(reference.realHeightCm) || reference.sameDepthConfirmed !== true ||
    !validPoint(reference.basePoint) || !validPoint(reference.topPoint) ||
    reference.basePoint.y - reference.topPoint.y <= 0.005
  )) throw new Error("Référence de hauteur du guide invalide.");
}

/** Geometry annotations only. No catalogue pixels or product silhouette. */
export async function buildStorefrontPerspectiveGuide(
  input: StorefrontPerspectiveGuideInput,
): Promise<Buffer> {
  validate(input);
  const { room, width, height, objects, reference } = input;
  // Input dimensions refer to the oriented photo, as do the requested points.
  const oriented = await sharp(room).rotate().removeAlpha().toColourspace("srgb")
    .raw().toBuffer({ resolveWithObject: true });
  if (oriented.info.width !== width || oriented.info.height !== height)
    throw new Error("Dimensions de la photographie du guide incohérentes.");

  const clamp = (value: number, minimum: number, maximum: number) =>
    Math.max(minimum, Math.min(maximum, value));
  const pixel = (point: { x: number; y: number }) => ({
    x: clamp(Math.round(point.x * width), 0, width - 1),
    y: clamp(Math.round(point.y * height), 0, height - 1),
  });
  const radius = clamp(Math.round(Math.min(width, height) / 180), 3, 7);
  const fontSize = clamp(Math.round(Math.min(width, height) / 60), 10, 20);
  const stroke = clamp(Math.min(width, height) / 600, 1, 2);
  const annotations: string[] = [];
  const markers: string[] = [];
  const marker = (point: { x: number; y: number }, label: number, colour: string) => {
    const contact = pixel(point);
    const textX = clamp(contact.x + radius + 5, 1, Math.max(1, width - fontSize * String(label).length));
    const textY = clamp(contact.y - radius - 4, fontSize, Math.max(fontSize, height - 2));
    markers.push(
      `<circle cx="${contact.x}" cy="${contact.y}" r="${radius + 2}" fill="#ffffff"/>`,
      `<circle cx="${contact.x}" cy="${contact.y}" r="${radius}" fill="${colour}"/>`,
      `<text x="${textX}" y="${textY}" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="bold" fill="${colour}" stroke="#ffffff" stroke-width="3" paint-order="stroke">${label}</text>`,
    );
  };
  for (const object of objects) {
    const anchor = pixel(object.point);
    const projectedWidth = object.dimensionsCm.width * object.pixelsPerCm;
    // Physical upright height excludes the extra projection of the top face.
    const projectedHeight = object.dimensionsCm.height * object.pixelsPerCm;
    const boxHeight = object.kind === "flat"
      ? object.dimensionsCm.depth * object.pixelsPerCm
      : projectedHeight;
    const left = anchor.x - projectedWidth / 2;
    const top = anchor.y - (object.kind === "standing" ? boxHeight : boxHeight / 2);
    const segmentBottom = object.kind === "wall" ? anchor.y + projectedHeight / 2 : anchor.y;
    const segmentTop = segmentBottom - projectedHeight;
    const segmentX = clamp(left + projectedWidth + radius + 6, 1, Math.max(1, width - 2));
    const heightGuide = [
      `<path d="M ${segmentX} ${segmentTop} V ${segmentBottom} M ${segmentX - 3} ${segmentTop} H ${segmentX + 3} M ${segmentX - 3} ${segmentBottom} H ${segmentX + 3}" fill="none" stroke="#00856a" stroke-width="${stroke}"/>`,
      `<text x="${clamp(segmentX + 5, 1, Math.max(1, width - fontSize * 5))}" y="${clamp(segmentTop - 4, fontSize, Math.max(fontSize, height - 2))}" font-family="Arial, sans-serif" font-size="${fontSize}" fill="#00856a" stroke="#ffffff" stroke-width="3" paint-order="stroke">${Math.round(projectedHeight)} px</text>`,
    ];
    if (object.kind === "standing" && object.pose) {
      const { cameraElevationDegrees, cameraRollDegrees } = object.pose;
      const projectedDepth = cameraElevationDegrees === null ? null
        : object.dimensionsCm.depth * object.pixelsPerCm *
          Math.sin(cameraElevationDegrees * Math.PI / 180);
      // Contact and top are the visible front edges. The projected top face
      // extends above the physical body height, never into that measurement.
      const halfDepth = (projectedDepth ?? 0) / 2;
      const volume = projectedDepth === null || projectedDepth === 0
        ? `<rect x="${left}" y="${top}" width="${projectedWidth}" height="${projectedHeight}" fill="none" stroke="#0073cc" stroke-width="${stroke}"/>`
        : `<path d="M ${left} ${top - halfDepth} V ${anchor.y - halfDepth} M ${left + projectedWidth} ${top - halfDepth} V ${anchor.y - halfDepth}" fill="none" stroke="#0073cc" stroke-width="${stroke}"/><ellipse cx="${anchor.x}" cy="${top - halfDepth}" rx="${projectedWidth / 2}" ry="${halfDepth}" fill="none" stroke="#0073cc" stroke-width="${stroke}"/><ellipse cx="${anchor.x}" cy="${anchor.y - halfDepth}" rx="${projectedWidth / 2}" ry="${halfDepth}" fill="none" stroke="#0073cc" stroke-width="${stroke}"/>`;
      const transform = cameraRollDegrees === null ? ""
        : ` transform="rotate(${cameraRollDegrees} ${anchor.x} ${anchor.y})"`;
      annotations.push(`<g${transform}>${volume}${heightGuide.join("")}</g>`);
    } else {
      annotations.push(
        `<rect x="${left}" y="${top}" width="${projectedWidth}" height="${boxHeight}" fill="none" stroke="#0073cc" stroke-width="${stroke}" stroke-dasharray="5 4"/>`,
        ...heightGuide,
      );
    }
    marker(object.point, object.index + 1, "#e5232b");
  }
  if (reference) {
    const base = pixel(reference.basePoint);
    const top = pixel(reference.topPoint);
    annotations.push(`<path d="M ${base.x} ${base.y} L ${top.x} ${top.y}" fill="none" stroke="#7b40aa" stroke-width="${stroke}"/>`);
    marker(reference.basePoint, 101, "#7b40aa");
    marker(reference.topPoint, 102, "#7b40aa");
  }
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${annotations.join("")}${markers.join("")}</svg>`);
  return sharp(oriented.data, { raw: { width, height, channels: oriented.info.channels } })
    .composite([{ input: svg }]).webp({ lossless: true }).toBuffer();
}
