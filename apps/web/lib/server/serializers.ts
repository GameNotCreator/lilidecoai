import { assetUrl } from "./assets";
import type { ProductDocument, RenderDocument, SceneDocument } from "./types";

export function productResponse(product: ProductDocument) {
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    objectType: product.objectType ?? "other",
    sku: product.sku,
    widthCm: product.widthCm,
    heightCm: product.heightCm,
    depthCm: product.depthCm,
    material: product.material,
    placementType: product.placementType,
    generationInstructions: product.generationInstructions ?? "",
    lightingProfile: product.lightingProfile,
    buyUrl: product.buyUrl,
    brand: product.brand ?? "",
    collection: product.collection ?? "",
    tags: product.tags ?? [],
    priceCents: product.priceCents ?? null,
    currency: product.currency ?? "TND",
    stock: product.stock ?? null,
    weightKg: product.weightKg ?? null,
    variants: (product.variants ?? []).map((variant) => ({
      id: variant.id,
      label: variant.label,
      sku: variant.sku,
      widthCm: variant.widthCm,
      heightCm: variant.heightCm,
      depthCm: variant.depthCm,
      priceCents: variant.priceCents,
      stock: variant.stock,
      available: variant.available,
    })),
    imageSourceUrl: product.imageSourceUrl,
    imageCredit: product.imageCredit,
    status: product.status,
    assetUrl: assetUrl(product.assetId),
    cutoutUrl: assetUrl(product.cutoutAssetId),
    views: (product.views ?? []).map((view) => ({
      id: view.id,
      assetId: view.assetId,
      type: view.type,
      widthPx: view.widthPx,
      heightPx: view.heightPx,
      validationStatus: view.validationStatus,
      url: assetUrl(view.assetId),
    })),
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
    error: render.error ?? null,
    qualityScore: render.qualityScore,
    creditCharged: render.creditCharged,
    placement: render.placement,
    mode: render.mode ?? "insert",
    outputQuality: render.outputQuality ?? "final",
    pipelineState: render.pipelineState,
    surfaceType: render.surfaceType,
    placementPoint: render.placementPoint,
    targetPoint: render.targetPoint,
    targetMaskUrl: assetUrl(render.targetMaskAssetId),
    promptVersion: render.promptVersion,
    attemptCount: render.attemptCount ?? 0,
    estimatedCostUsd: render.estimatedCostUsd ?? 0,
    degradedMode: render.degradedMode ?? false,
    qualityChecks: render.qualityChecks ?? [],
    modelChain: render.modelChain ?? [],
    createdAt: render.createdAt.toISOString(),
  };
}
