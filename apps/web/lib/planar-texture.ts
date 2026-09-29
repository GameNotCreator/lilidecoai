import { planarTextureSchema, type PlanarTexture } from "@lili/types";
export function currentPlanarTexture(product: {
  objectType?: string;
  placementType?: string;
  widthCm: number;
  depthCm: number;
  assetId?: string | null;
  sourceAssetId?: string | null;
  views?: Array<{ assetId: string; validationStatus: string }>;
  planarTexture?: PlanarTexture | null;
}): PlanarTexture | null {
  const parsed = planarTextureSchema.safeParse(product.planarTexture);
  if (
    !parsed.success ||
    product.objectType !== "rug" ||
    product.placementType !== "floor"
  )
    return null;
  const ref = parsed.data;
  if (
    ref.productWidthCm !== product.widthCm ||
    ref.productDepthCm !== product.depthCm
  )
    return null;
  return ref.assetId === (product.assetId ?? product.sourceAssetId) ||
    product.views?.some(
      (v) => v.assetId === ref.assetId && v.validationStatus === "valid",
    )
    ? ref
    : null;
}
