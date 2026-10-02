import { assetUrl } from "./assets";
import type { ProductDocument, RenderDocument, SceneDocument } from "./types";
import { effectiveRenderDeadline } from "./storefront-render-deadline";

export const STOREFRONT_BUDGET_UNAVAILABLE_MESSAGE =
  "La visualisation est momentanément indisponible dans la boutique. Réessayez un peu plus tard.";

export function productResponse(product: ProductDocument) {
  return {
    spatialMetadata: product.spatialMetadata ?? undefined,
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
    ...(product.cutout ? { cutout: product.cutout } : {}),
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

function renderErrorResponse(render: RenderDocument) {
  const error = render.error ?? null;
  if (
    render.publicSessionId?.startsWith("storefront:") &&
    (error === "Crédits insuffisants." || error === "Crédits insuffisants")
  ) return STOREFRONT_BUDGET_UNAVAILABLE_MESSAGE;
  if (render.publicSessionId?.startsWith("storefront:") && error?.startsWith("Cet emplacement est occupé.")) {
    return "Cet emplacement semble occupé. Déplacez le point sur une zone libre, puis lancez une nouvelle visualisation.";
  }
  const prefix = "Le placement ne permet pas une intégration fiable : ";
  if (render.engine !== "spatial" || !error?.startsWith(prefix)) return error;

  // Translate at the API boundary; retain the technical cause in stored evidence.
  switch (error.slice(prefix.length)) {
    case "An uncertainty hypothesis intersects the image frame":
      return "Le produit risque de dépasser la photo. Choisissez un point plus éloigné du bord ou une photo plus large.";
    case "An uncertainty footprint leaves free support":
      return "Le produit risque de dépasser la surface disponible. Choisissez un autre emplacement ou un support plus grand.";
    case "Expanded uncertain volume intersects a hole, obstacle or reflection":
      return "Le produit risque de recouvrir un obstacle, une ouverture ou un reflet. Choisissez un emplacement plus dégagé.";
    default:
      return "Ce placement ne peut pas être confirmé à partir de cette photo. Choisissez un autre emplacement ou une autre photo.";
  }
}

/** Reference an already stored owner-only storefront image checkpoint. */
function isolatedProductStages(render: RenderDocument) {
  const existing = render.stages;
  if (existing?.model_output || render.status === "deleted" || render.status === "cancelled" ||
      !render.publicSessionId?.startsWith("storefront:") ||
      !["storefront-isolated-product-v4", "storefront-room-integration-v5"].includes(render.engineVersions?.composite ?? "") ||
      render.engineVersions?.mockMode !== false) return existing;
  const step = render.execution?.steps["storefront-perspective-image"];
  if (step?.status !== "completed" || !step.output || typeof step.output !== "object") return existing;
  const output = step.output as { status?: unknown; images?: Array<{ data?: unknown }> };
  if (output.status !== "succeeded" || !Array.isArray(output.images)) return existing;
  const data = output.images[0]?.data;
  if (!data || typeof data !== "object") return existing;
  const id = (data as { __checkpointImage?: unknown }).__checkpointImage;
  if (typeof id !== "string" || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(id)) return existing;
  // Asset reads still enforce ownerSessionId. Do not expose the checkpoint
  // payload, tokens, prompts, execution snapshot or any other asset IDs.
  return { ...existing, model_output: id };
}

export function renderResponse(render: RenderDocument) {
  return {
    engine: render.engine ?? "legacy",
    spatialEvidence: render.spatialEvidence,
    id: render.id,
    status: render.status,
    provider: render.provider,
    model: render.model,
    requestedSize: render.requestedSize,
    resultUrl: assetUrl(render.resultAssetId),
    compositeUrl: assetUrl(render.compositeAssetId),
    error: renderErrorResponse(render),
    qualityScore: render.qualityScore,
    qualityDecision: render.qualityDecision,
    creditCharged: render.creditCharged,
    placement: render.placement,
    mode: render.mode ?? "insert",
    outputQuality: render.outputQuality ?? "final",
    pipelineState: render.pipelineState,
    execution: render.execution ? {
      version: render.execution.version,
      deadlineAt: new Date(effectiveRenderDeadline(render)).toISOString(),
      attempts: render.execution.attempts,
      retrying: render.status === "queued" && render.execution.attempts > 0,
      errorCode: render.execution.errorCode,
    } : undefined,
    // MongoDB stores an explicitly undefined support as null; the public
    // contract represents an unspecified support by omitting this field.
    surfaceType: render.surfaceType ?? undefined,
    placementPoint: render.placementPoint,
    targetPoint: render.targetPoint,
    targetMaskUrl: assetUrl(render.targetMaskAssetId),
    promptVersion: render.promptVersion,
    // The engine that made this image, and the provenance of each stage. A
    // corpus case cannot localise a failure — bad source, bad scale, bad
    // cleanup — without them, and cannot be compared across engine versions.
    engineVersions: render.engineVersions,
    audit: render.audit,
    // Optional captures, plus the existing private isolated-product checkpoint.
    // A stage reference is never a delivered result or a quality acceptance.
    stages: isolatedProductStages(render),
    attemptCount: render.attemptCount ?? 0,
    estimatedCostUsd:
      (render.engine === "spatial"
        ? render.usageTotals?.estimatedCostUsd
        : undefined) ?? render.estimatedCostUsd ?? 0,
    /**
     * Every paid call this render made, not only its final edit. Diagnostic:
     * the cost is estimated from local constants, not reconciled.
     */
    usageTotals: render.usageTotals ?? {
      calls: 0,
      estimatedCostUsd: 0,
      unknownOutcomeCalls: 0,
    },
    degradedMode: render.degradedMode ?? false,
    qualityChecks: render.qualityChecks ?? [],
    modelChain: render.modelChain ?? [],
    createdAt: render.createdAt.toISOString(),
  };
}
