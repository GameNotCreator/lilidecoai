import { createHash } from "node:crypto";
import { currentPlanarTexture } from "../planar-texture";
import { productGeometrySchema, type ProductGeometry } from "@lili/types";
import type { ProductDocument } from "./types";
import type { RenderInput } from "./render-request";

export const SPATIAL_ENGINE_VERSION = "spatial-v11";
export const SPATIAL_VOLUME_ENGINE_VERSION = "spatial-v13";
export function isSupportedSolidBaseProduct(product: ProductDocument) {
  const metadata = product.spatialMetadata;
  return (
    metadata?.contactProfile === "solid-base" &&
    metadata.dimensionSource !== "estimated" &&
    ((product.objectType === "vase" && metadata.volumeFamily === "vase") ||
      (product.objectType === "other" && metadata.volumeFamily === "basket"))
  );
}
export function spatialVersionForProduct(product: ProductDocument) {
  return product.spatialMetadata?.contactProfile === "solid-base"
    ? SPATIAL_VOLUME_ENGINE_VERSION
    : SPATIAL_ENGINE_VERSION;
}
/** Reading admitted jobs remains possible after admission is disabled. */
export function canReadSpatialRenders(tenant: import("./auth").Tenant) {
  return (
    !tenant.synthetic &&
    !tenant.publicSessionId &&
    !["guest", "viewer"].includes(tenant.role)
  );
}
export function canUseSpatialPilot(
  tenant: import("./auth").Tenant,
  organizations: readonly string[],
) {
  return (
    canReadSpatialRenders(tenant) &&
    organizations.includes(tenant.organizationId)
  );
}
export class SpatialAdmissionError extends Error {
  readonly status = 422;
}
export function validateSpatialAdmission(
  input: RenderInput,
  product: ProductDocument,
  enabled: boolean,
  publicSessionId?: string,
): ProductGeometry {
  // L'admission est plus stricte que la lecture : fermer le pilote interdit les
  // nouveaux travaux sans rendre inaccessibles les rendus déjà admis.
  if (!enabled || publicSessionId)
    throw new SpatialAdmissionError(
      "Le placement spatial est réservé aux essais internes des boutiques activées.",
    );
  if (input.mode === "replace" || (input.simplePlacements?.length ?? 1) !== 1)
    throw new SpatialAdmissionError(
      "Le placement spatial accepte un seul objet, en insertion.",
    );
  const item = input.simplePlacements?.[0];
  if (item && item.productId !== product.id)
    throw new SpatialAdmissionError(
      "Le produit du placement doit correspondre au produit sélectionné.",
    );
  const dimensionsChanged =
    input.dimensionsCm &&
    (input.dimensionsCm.width !== product.widthCm ||
      input.dimensionsCm.height !== product.heightCm ||
      input.dimensionsCm.depth !== product.depthCm);
  if (
    item?.pixelsPerCm ||
    input.calibration ||
    dimensionsChanged ||
    item?.dimensionPair ||
    item?.dimensionReference ||
    input.dimensionReference
  )
    throw new SpatialAdmissionError(
      "Ce mode utilise les dimensions catalogue. La calibration et les dimensions personnalisées nécessitent un parcours qualifié.",
    );
  const support =
    input.surfaceType ?? input.placement.surfaceType ?? product.placementType;
  if (
    !["floor", "table", "tabletop", "nightstand", "shelf"].includes(support) ||
    item?.placementKind === "wall"
  )
    throw new SpatialAdmissionError(
      "Choisissez un sol, une table ou une étagère. Les murs ne sont pas encore qualifiés.",
    );
  if (product.objectType === "rug") {
    if (support !== "floor" || !currentPlanarTexture(product))
      throw new SpatialAdmissionError(
        "Les produits plans exigent une texture confirmée dans le catalogue et un placement au sol.",
      );
    if (
      product.heightCm >
      Math.min(5, product.widthCm * 0.05, product.depthCm * 0.05)
    )
      throw new SpatialAdmissionError(
        "Ce tapis est trop épais pour la projection plane expérimentale.",
      );
  } else if (item?.placementKind === "flat")
    throw new SpatialAdmissionError(
      "Les produits plans ne sont pas encore activés : leurs références de texture et leur intégration doivent être validées.",
    );
  if (["mirror", "frame"].includes(product.objectType ?? ""))
    throw new SpatialAdmissionError(
      "Cette famille nécessite une qualification spécifique.",
    );
  const geometry = prepareProductGeometry(product);
  if (
    geometry.contactProfile === "solid-base" &&
    !isSupportedSolidBaseProduct(product)
  )
    throw new SpatialAdmissionError(
      "L’intégration à base pleine exige un vase ou un objet de rangement avec des dimensions catalogue ou mesurées.",
    );
  const normalizedSupport =
    support === "floor" ? "floor" : support === "shelf" ? "shelf" : "table";
  if (!geometry.supports.includes(normalizedSupport))
    throw new SpatialAdmissionError(
      "Ce support n’est pas compatible avec la fiche produit.",
    );
  return geometry;
}

/** Pure, versioned preparation: never write inferred dimensions to the catalog. */
export function prepareProductGeometry(
  product: ProductDocument,
): ProductGeometry {
  const dimensions = {
    widthCm: product.widthCm,
    heightCm: product.heightCm,
    depthCm: product.depthCm,
    unit: "cm" as const,
  };
  const references = [
    ...(product.assetId
      ? [{ assetId: product.assetId, view: "catalog", supplied: true as const }]
      : []),
    ...(currentPlanarTexture(product)
      ? [
          {
            assetId: currentPlanarTexture(product)!.assetId,
            view: "planar-texture",
            supplied: true as const,
          },
        ]
      : []),
    ...(product.views ?? [])
      .filter(
        (v) =>
          v.validationStatus === "valid" &&
          Math.min(v.widthPx, v.heightPx) >= 256,
      )
      .map((v) => ({
        assetId: v.assetId,
        view: v.type,
        supplied: true as const,
      })),
  ]
    .filter(
      (reference, index, all) =>
        all.findIndex((item) => item.assetId === reference.assetId) === index,
    )
    .slice(0, 7);
  const source = {
    productId: product.id,
    name: product.name,
    objectType: product.objectType,
    material: product.material,
    placementType: product.placementType,
    dimensions,
    references,
    referenceInventory: (product.views ?? []).map(
      ({ assetId, type, widthPx, heightPx, validationStatus }) => ({
        assetId,
        type,
        widthPx,
        heightPx,
        validationStatus,
      }),
    ),
    metadata: product.spatialMetadata ?? null,
    planarTexture: currentPlanarTexture(product),
  };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(source))
    .digest("hex");
  const cached = productGeometrySchema.safeParse(product.spatialPreparation);
  if (cached.success && cached.data.fingerprint === fingerprint)
    return cached.data;
  const result = productGeometrySchema.safeParse({
    ...(currentPlanarTexture(product)
      ? { planarTexture: currentPlanarTexture(product) }
      : {}),
    version: 1,
    productId: product.id,
    dimensions,
    references,
    fingerprint,
    measurementConvention:
      product.spatialMetadata?.measurementConvention ??
      "Convention non documentée dans le catalogue",
    dimensionSource: product.spatialMetadata?.dimensionSource ?? "catalog",
    shape: product.objectType === "rug" ? "plane" : "volume",
    ...(product.spatialMetadata?.contactProfile
      ? { contactProfile: product.spatialMetadata.contactProfile }
      : {}),
    ...(product.spatialMetadata?.volumeFamily
      ? { volumeFamily: product.spatialMetadata.volumeFamily }
      : {}),
    supports: product.spatialMetadata?.supports ?? [
      product.placementType === "floor"
        ? "floor"
        : product.placementType === "shelf"
          ? "shelf"
          : "table",
    ],
    characteristicParts: product.spatialMetadata?.characteristicParts ?? [],
    limitations: [
      "Faces cachées non mesurées",
      ...((product.views ?? []).some(
        (view) =>
          view.validationStatus !== "valid" ||
          Math.min(view.widthPx, view.heightPx) < 256,
      )
        ? ["Vues non validées ou de moins de 256 pixels exclues des références"]
        : []),
      ...(!product.spatialMetadata
        ? ["Convention de mesure et parties caractéristiques à compléter"]
        : []),
    ],
  });
  if (!result.success)
    throw new SpatialAdmissionError(
      "Complétez les trois dimensions et une référence catalogue avant le placement spatial.",
    );
  return result.data;
}

/** Incomplete spatial data must never prevent publication in the legacy catalog. */
export function spatialPreparationForCatalog(
  product: ProductDocument,
): ProductGeometry | null {
  try {
    return prepareProductGeometry(product);
  } catch (reason) {
    if (reason instanceof SpatialAdmissionError) return null;
    throw reason;
  }
}
