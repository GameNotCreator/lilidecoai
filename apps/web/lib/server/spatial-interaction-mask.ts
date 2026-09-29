import "server-only";
import sharp from "sharp";
import type { ScreenPoint } from "@lili/geometry";
import { insidePolygon } from "../spatial-scene";

type Polygon = ScreenPoint[];
/** Fade only at the OUTER edit boundary, including protected holes and frame
 * edges. The texture is inside the domain, so contact is not faded at its edge.
 * A capped Manhattan distance keeps memory and runtime linear in image area. */
function contactOpacity(
  mask: Buffer,
  contact: Buffer,
  width: number,
  height: number,
  featherPx: number,
) {
  const distance = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (mask[i * 4 + 3] !== 0) continue;
      distance[i] = Math.min(
        featherPx + 1,
        x ? distance[i - 1]! + 1 : 1,
        y ? distance[i - width]! + 1 : 1,
      );
    }
  const opacity = Buffer.alloc(width * height);
  for (let y = height - 1; y >= 0; y--)
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (mask[i * 4 + 3] !== 0) continue;
      distance[i] = Math.min(
        distance[i]!,
        x < width - 1 ? distance[i + 1]! + 1 : 1,
        y < height - 1 ? distance[i + width]! + 1 : 1,
      );
      if (contact[i]) {
        const t = Math.min(1, Math.max(0, (distance[i]! - 1) / featherPx));
        opacity[i] = Math.round(255 * t * t * (3 - 2 * t));
      }
    }
  return opacity;
}
export class SpatialInteractionError extends Error {}
export interface InteractionSupport {
  boundary: Polygon;
  holes: Polygon[];
  obstacles: Polygon[];
}
export function convexHull(points: Polygon): Polygon {
  if (
    points.length < 3 ||
    points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))
  )
    throw new Error("Invalid volume outline");
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (a: ScreenPoint, b: ScreenPoint, c: ScreenPoint) =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const half = (source: Polygon) => {
    const result: Polygon = [];
    for (const p of source) {
      while (
        result.length >= 2 &&
        cross(result.at(-2)!, result.at(-1)!, p) <= 0
      )
        result.pop();
      result.push(p);
    }
    return result;
  };
  const hull = [
    ...half(sorted).slice(0, -1),
    ...half([...sorted].reverse()).slice(0, -1),
  ];
  if (hull.length < 3) throw new Error("Degenerate volume outline");
  return hull;
}
/** Binary masks in original-room pixels. This is a volume envelope, not a recovered silhouette. */
export async function spatialInteractionMask(input: {
  width: number;
  height: number;
  volume: Polygon;
  footprint: Polygon;
  support: InteractionSupport;
  reflectiveRegions: Polygon[];
  planarContact?: boolean;
}) {
  const { width, height, support } = input;
  if (
    ![width, height].every((n) => Number.isInteger(n) && n > 0) ||
    width * height > 25_000_000
  )
    throw new Error("Invalid mask dimensions");
  for (const polygon of [
    support.boundary,
    ...support.holes,
    ...support.obstacles,
    ...input.reflectiveRegions,
  ])
    if (
      polygon.length < 3 ||
      polygon.some(
        (p) =>
          !Number.isFinite(p.x) ||
          !Number.isFinite(p.y) ||
          p.x < 0 ||
          p.x > 1 ||
          p.y < 0 ||
          p.y > 1,
      )
    )
      throw new Error("Invalid support polygon");
  const hull = convexHull(input.volume),
    footprint = convexHull(input.footprint);
  const xs = footprint.map((p) => p.x),
    ys = footprint.map((p) => p.y);
  const objectMarginPx = input.planarContact
    ? 0
    : Math.max(2, Math.min(6, Math.min(width, height) * 0.005));
  const contactMarginPx = Math.max(
    6,
    Math.min(
      64,
      Math.max(
        Math.max(...xs) - Math.min(...xs),
        Math.max(...ys) - Math.min(...ys),
      ) * 0.25,
    ),
  );
  const polygon = (points: Polygon, fill: string, margin = 0) =>
    `<polygon points="${points.map((p) => `${p.x},${p.y}`).join(" ")}" fill="${fill}" stroke="${fill}" stroke-width="${margin * 2}" stroke-linejoin="round"/>`;
  const raster = (body: string) =>
    sharp(
      Buffer.from(
        `<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="black"/>${body}</svg>`,
      ),
    )
      .greyscale()
      .removeAlpha()
      .raw()
      .toBuffer();
  const pixels = (points: Polygon) =>
    points.map((p) => ({ x: p.x * width, y: p.y * height }));
  const [object, contact, free, reflective] = await Promise.all([
    raster(polygon(hull, "white", objectMarginPx)),
    raster(polygon(footprint, "white", contactMarginPx)),
    raster(
      polygon(pixels(support.boundary), "white") +
        [...support.holes, ...support.obstacles]
          .map((p) => polygon(pixels(p), "black", 1))
          .join(""),
    ),
    raster(
      input.reflectiveRegions
        .map((p) => polygon(pixels(p), "white", 1))
        .join(""),
    ),
  ]);
  const maskRaw = Buffer.alloc(width * height * 4, 255),
    objectMask = Buffer.alloc(width * height),
    contactMask = Buffer.alloc(width * height);
  let objectPixels = 0,
    contactPixels = 0;
  for (let i = 0; i < width * height; i++) {
    // Match the texture projector's pixel-centre coverage, including diagonal
    // edges. SVG antialiasing alone would leave a one-pixel unshadowed fringe.
    const onObject = input.planarContact
      ? object[i]! > 0 &&
        insidePolygon(
          { x: (i % width) + 0.5, y: Math.floor(i / width) + 0.5 },
          hull,
        )
      : object[i]! >= 128;
    if (onObject) {
      if (reflective[i]! > 0)
        throw new SpatialInteractionError(
          "Le volume recouvre une zone réfléchissante. Déplacez-le : les reflets ne sont pas encore pris en charge.",
        );
      objectMask[i] = 255;
      objectPixels++;
      maskRaw[i * 4 + 3] = 0;
    } else if (contact[i]! >= 128 && free[i]! >= 254 && reflective[i] === 0) {
      contactMask[i] = 255;
      contactPixels++;
      maskRaw[i * 4 + 3] = 0;
    }
  }
  if (!objectPixels) throw new Error("Empty object mask");
  const contactFeatherPx = input.planarContact
    ? Math.max(2, Math.min(8, Math.round(contactMarginPx / 3)))
    : undefined;
  return {
    maskRaw,
    objectMask,
    contactMask,
    contactOpacity:
      contactFeatherPx === undefined
        ? undefined
        : contactOpacity(maskRaw, contactMask, width, height, contactFeatherPx),
    metadata: {
      policy: input.planarContact
        ? ("plane-and-contact-v1" as const)
        : ("volume-and-contact-v1" as const),
      ...(contactFeatherPx === undefined ? {} : { contactFeatherPx }),
      objectMarginPx,
      contactMarginPx,
      objectPixels,
      contactPixels,
      limitation: input.planarContact
        ? "Emprise plane sans marge volumique ; ombre atténuée à la frontière du support libre, sans estimation physique ni occultation fine."
        : "Enveloppe volumique, sans extraction de silhouette ni occultation fine ; ombre bornée au support libre.",
    },
  };
}
