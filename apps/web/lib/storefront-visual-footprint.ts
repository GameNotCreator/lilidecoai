import { productPlacementKind, type StorefrontProduct } from "./storefront";

export type StorefrontReplacementRegion = { xMin: number; yMin: number; xMax: number; yMax: number };

/** A visual size guide in photo coordinates, never a metric or a 3D measurement. */
export function storefrontVisualFootprint(
  product: StorefrontProduct,
  scene: { widthPx: number; heightPx: number },
  point: { x: number; y: number },
  requestedWidth: number,
) {
  const standing = productPlacementKind(product) === "standing";
  const ratio = (productPlacementKind(product) === "flat" ? product.depthCm : product.heightCm) / product.widthCm;
  const heightPerWidth = ratio * scene.widthPx / scene.heightPx;
  const maxWidth = Math.min(0.75, 2 * Math.min(point.x, 1 - point.x),
    (standing ? point.y : 2 * Math.min(point.y, 1 - point.y)) / heightPerWidth);
  const width = Math.max(0.02, Math.min(maxWidth, requestedWidth));
  const height = width * heightPerWidth;
  return { width, height, maxWidth, xMin: point.x - width / 2,
    yMin: point.y - height / (standing ? 1 : 2) };
}

/** Gently keeps the minimum guide inside the photo instead of refusing an edge tap. */
export function fitStorefrontVisualPoint(
  product: StorefrontProduct,
  scene: { widthPx: number; heightPx: number },
  point: { x: number; y: number },
) {
  const kind = productPlacementKind(product);
  const heightPerWidth = (kind === "flat" ? product.depthCm : product.heightCm) / product.widthCm * scene.widthPx / scene.heightPx;
  const marginY = Math.min(kind === "standing" ? 0.99 : 0.49, heightPerWidth * (kind === "standing" ? 0.02 : 0.01));
  return { x: Math.max(0.01, Math.min(0.99, point.x)),
    y: Math.max(marginY, Math.min(kind === "standing" ? 1 : 1 - marginY, point.y)) };
}
