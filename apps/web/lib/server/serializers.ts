import { assetUrl } from "./assets";
import type { ProductDocument, RenderDocument, SceneDocument } from "./types";

export function productResponse(product: ProductDocument) {
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    sku: product.sku,
    widthCm: product.widthCm,
    heightCm: product.heightCm,
    depthCm: product.depthCm,
    material: product.material,
    placementType: product.placementType,
    lightingProfile: product.lightingProfile,
    buyUrl: product.buyUrl,
    status: product.status,
    assetUrl: assetUrl(product.assetId),
    cutoutUrl: assetUrl(product.cutoutAssetId),
    anchor: product.anchor ?? null,
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
  };
}

export function sceneResponse(scene: SceneDocument) {
  return {
    id: scene.id,
    status: scene.status,
    imageUrl: assetUrl(scene.assetId),
    widthPx: scene.widthPx,
    heightPx: scene.heightPx,
    analysis: scene.analysis,
    createdAt: scene.createdAt.toISOString(),
    expiresAt: scene.expiresAt.toISOString(),
  };
}

export function renderResponse(render: RenderDocument) {
  return {
    id: render.id,
    status: render.status,
    provider: render.provider,
    model: render.model,
    requestedSize: render.requestedSize,
    resultUrl: assetUrl(render.resultAssetId),
    qualityScore: render.qualityScore,
    creditCharged: render.creditCharged,
    createdAt: render.createdAt.toISOString(),
  };
}
