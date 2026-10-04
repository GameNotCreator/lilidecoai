import { storefrontReplacementRegionSchema, storefrontVisualWidthSchema, type StorefrontReplacementRegion } from "@lili/types";

/** A pixel-width preference divided by nominal catalogue width; never a measured cm scale. */
export function resolveStorefrontVisualScale(
  visualWidthNormalized: number | undefined,
  sceneWidth: number,
  productWidthCm: number,
) {
  if (visualWidthNormalized === undefined) return null;
  const width = storefrontVisualWidthSchema.parse(visualWidthNormalized);
  if (!Number.isFinite(sceneWidth) || sceneWidth <= 0 || !Number.isFinite(productWidthCm) || productWidthCm <= 0)
    throw new Error("Dimensions du patron visuel invalides.");
  const pixelsPerCm = width * sceneWidth / productWidthCm;
  return { pixelsPerCm, widthPixelsPerCm: pixelsPerCm, scaleSource: "visual_size" as const,
    widthPx: width * sceneWidth, metricVerified: false as const };
}

/** A confirmed erase region is authoritative over a model's uncertain obstacle box. */
export function confirmedStorefrontReplacementRegion(
  region: StorefrontReplacementRegion | undefined,
  replaceExisting: boolean | undefined,
  points: ReadonlyArray<{ x: number; y: number }>,
) {
  if (region === undefined) return null;
  const parsed = storefrontReplacementRegionSchema.parse(region);
  const point = points[0];
  if (replaceExisting !== true || points.length !== 1 || !point ||
      ![point.x, point.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1) ||
      point.x < parsed.xMin || point.x > parsed.xMax || point.y < parsed.yMin || point.y > parsed.yMax)
    throw new Error("Confirmez le remplacement et placez le point dans la zone sélectionnée.");
  return parsed;
}
