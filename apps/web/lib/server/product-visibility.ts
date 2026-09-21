import "server-only";

import type { Filter } from "mongodb";

import type { AssetVisibility } from "./assets";
import type { Tenant } from "./auth";
import {
  DEMO_CATALOG_USER_ID,
  DEMO_PRODUCT_ID,
  type ProductDocument,
} from "./types";

type ProductAccessState = Pick<ProductDocument, "createdByUserId" | "status">;

export interface StoredProductAssetAccess {
  visibility: "private" | "published";
  ownerSessionId?: string;
}

/**
 * Catalogue images stay private until the product is explicitly published.
 * A visitor upload always remains scoped to that visitor, even after it is
 * ready to render.
 */
export function productAssetVisibility(
  product: ProductAccessState,
): AssetVisibility {
  const owner = productOwnerSession(product);
  if (owner) return { ownerSessionId: owner };
  return product.status === "ready" ? "published" : "organization";
}

/** Fields persisted on an existing asset when a product changes state. */
export function storedProductAssetAccess(
  product: ProductAccessState,
): StoredProductAssetAccess {
  const owner = productOwnerSession(product);
  if (owner) return { visibility: "private", ownerSessionId: owner };
  return {
    visibility: product.status === "ready" ? "published" : "private",
  };
}

/**
 * A guest sees their own working products plus explicitly published catalogue
 * products. A public widget sees only its published product. Real merchant
 * members keep the complete non-archived working catalogue.
 */
export function productListFilter(tenant: Tenant): Filter<ProductDocument> {
  const organizationId = tenant.organizationId;
  if (tenant.publicProductId) {
    return {
      organizationId,
      id: tenant.publicProductId,
      status: "ready",
    };
  }
  if (tenant.role === "guest") {
    return {
      organizationId,
      $or: [
        {
          createdByUserId: tenant.userId,
          status: { $ne: "archived" },
        },
        {
          createdByUserId: DEMO_CATALOG_USER_ID,
          status: "ready",
        },
        { id: DEMO_PRODUCT_ID, status: "ready" },
      ],
    };
  }
  if (tenant.synthetic) {
    return {
      organizationId,
      status: "ready",
      $or: [{ createdByUserId: DEMO_CATALOG_USER_ID }, { id: DEMO_PRODUCT_ID }],
    };
  }
  return { organizationId, status: { $ne: "archived" } };
}

/** The visitor session that owns a product, when it is a visitor upload. */
export function productOwnerSession(
  product: Pick<ProductDocument, "createdByUserId">,
): string | undefined {
  const creator = product.createdByUserId;
  if (typeof creator !== "string") return undefined;
  if (creator.startsWith("guest:")) return creator;
  if (creator.startsWith("public:")) return creator.slice("public:".length);
  return undefined;
}
