import "server-only";

import type { Db } from "mongodb";
import {
  storefrontProductSchema,
  productDimensionPair,
  productPlacementKind,
  type StorefrontCatalog,
} from "../storefront";
import { AuthError, type Tenant } from "./auth";
import { ApiInputError } from "./assets";
import { serverConfig } from "./config";
import { cutoutTrust } from "./cutout-identity";
import { productPreparationStatus } from "./product-preparation";
import { collections } from "./mongodb";
import { productResponse } from "./serializers";
import { DEMO_CATALOG_USER_ID, type ProductDocument } from "./types";
import type { RenderInput } from "./render-request";
import { isSameOriginRequest } from "./request-origin";

export function storefrontProductFilter(organizationId: string) {
  return {
    organizationId,
    status: "ready" as const,
    createdByUserId: DEMO_CATALOG_USER_ID,
  };
}

export function storefrontProductResponse(product: ProductDocument) {
  const validDimensions =
    product.widthCm > 0 &&
    product.heightCm > 0 &&
    (product.objectType !== "rug" || product.depthCm > 0);
  return storefrontProductSchema.parse({
    ...productResponse(product),
    visualizationAvailable: Boolean(
      product.cutoutAssetId &&
      cutoutTrust(product.cutout).trusted &&
      (!product.productPreparation || productPreparationStatus(product).status === "ready") &&
      !product.visualizationBlockedReason?.trim() &&
      validDimensions &&
      (product.stock == null || product.stock > 0),
    ),
  });
}

export function storefrontVisualization() {
  const available =
    process.env.STOREFRONT_VISUALIZATION_ENABLED !== "false" &&
    (serverConfig.aiMockMode
      ? process.env.NODE_ENV !== "production"
      : Boolean(serverConfig.openaiApiKey));
  return available
    ? { available }
    : { available, reason: "La visualisation est momentanément indisponible." };
}

export async function storefrontOrganization(db: Db) {
  // Browsing a store must never create an organization, seed products or refill credits.
  return collections(db).organizations.findOne({
    slug: serverConfig.adminOrganizationSlug,
  });
}

export async function getStorefrontCatalog(db: Db): Promise<StorefrontCatalog> {
  const organization = await storefrontOrganization(db);
  const products = organization
    ? await collections(db)
        .products.find(storefrontProductFilter(organization.id))
        .sort({ createdAt: -1 })
        .toArray()
    : [];
  return {
    store: { name: "LiliDeco" },
    products: products.map(storefrontProductResponse),
    visualization: storefrontVisualization(),
  };
}

export function assertStorefrontOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (
    (origin && !isSameOriginRequest(request)) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  ) {
    throw new AuthError("Origine de la demande non autorisée", 403);
  }
}

/** A signed storefront token only grants the routes needed for its own photos and renders. */
export function assertStorefrontRoute(request: Request, path: string[]) {
  const method = request.method;
  const [resource, id, action] = path;
  const allowed =
    (resource === "render-capabilities" &&
      path.length === 1 &&
      method === "GET") ||
    (resource === "scenes" &&
      ((path.length === 1 && method === "POST") ||
        (path.length === 2 &&
          Boolean(id) &&
          ["GET", "DELETE"].includes(method)))) ||
    (resource === "renders" &&
      ((path.length === 2 && id === "final" && method === "POST") ||
        (path.length === 2 &&
          Boolean(id) &&
          ["GET", "DELETE"].includes(method)) ||
        (path.length === 3 &&
          ["cancel", "retry"].includes(action ?? "") &&
          method === "POST")));
  if (!allowed)
    throw new AuthError("Action non disponible dans la boutique", 403);
  if (!["GET", "HEAD"].includes(method)) assertStorefrontOrigin(request);
}

/** Rebuild the request from current catalogue data, including during a retry. */
export async function normalizeStorefrontRender(
  db: Db,
  tenant: Tenant,
  input: RenderInput,
): Promise<RenderInput> {
  if (!tenant.storefront) return input;
  if (!storefrontVisualization().available)
    throw new AuthError(
      "La visualisation est momentanément indisponible.",
      503,
    );
  if (input.engine === "spatial" || input.workflow !== "simple_point") {
    throw new AuthError(
      "Ce mode de visualisation n’est pas ouvert dans la boutique.",
      403,
    );
  }
  const objects = input.simplePlacements;
  if (
    !objects ||
    objects.length < 1 ||
    objects.length > 3 ||
    objects[0]?.productId !== input.placement.productId
  ) {
    throw new ApiInputError(
      "Choisissez entre un et trois articles à visualiser.",
    );
  }
  const organization = await storefrontOrganization(db);
  if (organization?.id !== tenant.organizationId)
    throw new AuthError(
      "La session boutique a expiré. Rechargez la page.",
      403,
    );
  const ids = [...new Set(objects.map((item) => item.productId))];
  const products = await collections(db)
    .products.find({
      ...storefrontProductFilter(tenant.organizationId),
      id: { $in: ids },
    })
    .toArray();
  const simplePlacements = objects.map((item) => {
    const product = products.find((p) => p.id === item.productId);
    if (!product)
      throw new AuthError(
        "Un article n’est plus disponible au catalogue.",
        409,
      );
    const dto = storefrontProductResponse(product);
    if (!dto.visualizationAvailable)
      throw new AuthError(
        `La visualisation de ${product.name} est indisponible.`,
        409,
      );
    if (
      product.stock != null &&
      objects.filter((other) => other.productId === item.productId).length >
        product.stock
    ) {
      throw new AuthError(
        `Le stock de ${product.name} est insuffisant pour cette sélection.`,
        409,
      );
    }
    const point = item.placementPoint;
    if (
      !point ||
      ![point.x, point.y].every((n) => Number.isFinite(n) && n >= 0 && n <= 1)
    )
      throw new ApiInputError("Emplacement invalide.");
    return {
      productId: product.id,
      placementPoint: point,
      dimensionPair: productDimensionPair(dto),
      placementKind: productPlacementKind(dto),
    };
  });
  const first = simplePlacements[0]!;
  return {
    engine: "legacy",
    workflow: "simple_point",
    mode: "insert",
    outputQuality: "final",
    preserveBackground: true,
    idempotencyKey: input.idempotencyKey,
    simplePlacements,
    placementPoint: first.placementPoint,
    placement: {
      sceneId: input.placement.sceneId,
      productId: first.productId,
      xNormalized: first.placementPoint.x,
      yNormalized: first.placementPoint.y,
    },
  };
}
