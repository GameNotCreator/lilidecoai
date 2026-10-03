import type { Tenant } from "./auth";
import type { ProductDocument } from "./types";
import type { RenderInput } from "./render-request";
import { productOwnerSession } from "./product-visibility";

export const ORIENTED_ENGINE_VERSION = "oriented-v1" as const;
export class OrientedAdmissionError extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message);
  }
}
export function canReadOrientedRenders(tenant: Tenant) {
  return (
    !tenant.synthetic &&
    !tenant.publicSessionId &&
    ["owner", "admin", "member", "platform_admin"].includes(tenant.role)
  );
}
export function canUseOrientedPilot(
  tenant: Tenant,
  organizations: readonly string[],
) {
  return (
    canReadOrientedRenders(tenant) &&
    organizations.includes(tenant.organizationId)
  );
}
export function orientedProductForVariant(
  product: ProductDocument,
  variantId: string | null = null,
): ProductDocument {
  if (!variantId) {
    if ((product.variants?.length ?? 0) > 0)
      throw new OrientedAdmissionError("Choisissez la variante à visualiser.");
    return product;
  }
  const variant = product.variants?.find(
    (v) => v.id === variantId && v.available,
  );
  if (!variant || !variant.widthCm || !variant.heightCm || !variant.depthCm)
    throw new OrientedAdmissionError(
      "Les dimensions de cette variante sont indisponibles.",
    );
  return {
    ...product,
    widthCm: variant.widthCm,
    heightCm: variant.heightCm,
    depthCm: variant.depthCm,
  };
}
export function validateOrientedAdmission(
  input: RenderInput,
  product: ProductDocument,
  options: {
    enabled: boolean;
    productIds: readonly string[];
    publicSessionId?: string;
  },
) {
  if (
    !options.enabled ||
    options.publicSessionId ||
    !options.productIds.includes(product.id)
  )
    throw new OrientedAdmissionError(
      "Le rendu orienté est réservé aux produits des essais internes activés.",
      403,
    );
  if (product.visualizationBlockedReason)
    throw new OrientedAdmissionError(product.visualizationBlockedReason);
  if (
    product.status === "archived" ||
    product.archivedAt ||
    productOwnerSession(product)
  )
    throw new OrientedAdmissionError(
      "Ce produit n’est pas disponible pour les essais internes.",
    );
  const support =
    input.surfaceType ?? input.placement.surfaceType ?? product.placementType;
  if (
    input.mode === "replace" ||
    input.workflow === "simple_point" ||
    input.simplePlacements?.length ||
    !["floor", "table", "tabletop", "nightstand", "shelf"].includes(support) ||
    product.spatialMetadata?.contactProfile !== "solid-base" ||
    product.spatialMetadata.dimensionSource === "estimated" ||
    ["mirror", "frame", "rug", "lamp"].includes(product.objectType ?? "")
  )
    throw new OrientedAdmissionError(
      "Choisissez un seul objet opaque à base pleine et un support horizontal dégagé.",
    );
  if (
    input.dimensionReference ||
    (input.calibration && Object.keys(input.calibration).length) ||
    input.spatialReference
  )
    throw new OrientedAdmissionError(
      "Cet essai utilise les dimensions de la variante catalogue et une échelle estimée.",
    );
  const kind =
    support === "floor" ? "floor" : support === "shelf" ? "shelf" : "table";
  if (!product.spatialMetadata.supports.includes(kind))
    throw new OrientedAdmissionError(
      "Ce support ne convient pas au produit choisi.",
    );
  const selected = orientedProductForVariant(
    product,
    input.orientedVariantId ?? null,
  );
  if (
    input.dimensionsCm &&
    (input.dimensionsCm.width !== selected.widthCm ||
      input.dimensionsCm.height !== selected.heightCm ||
      input.dimensionsCm.depth !== selected.depthCm)
  )
    throw new OrientedAdmissionError(
      "Les dimensions demandées diffèrent de la variante catalogue.",
    );
  if (
    ![selected.widthCm, selected.heightCm, selected.depthCm].every(
      (n) => Number.isFinite(n) && n > 0 && n <= 2000,
    )
  )
    throw new OrientedAdmissionError(
      "Les dimensions catalogue doivent être complètes.",
    );
  return selected;
}
