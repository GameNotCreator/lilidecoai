import "server-only";

import type { Db, Filter, Sort } from "mongodb";
import type { z } from "zod";

import {
  productStatuses,
  roundOrNull,
  variantSchema,
  type AdminProductInput,
  type AdminProductPatch,
  type ListQuery,
} from "./admin-product-schema";
import { assetUrl, deleteAsset } from "./assets";
import { serverConfig } from "./config";
import { collections } from "./mongodb";
import { productResponse } from "./serializers";
import {
  DEMO_CATALOG_USER_ID,
  type OrganizationDocument,
  type ProductDocument,
  type ProductVariantDocument,
} from "./types";

export {
  adminProductPatchSchema,
  adminProductSchema,
  listQuerySchema,
  objectTypes,
  placementTypes,
  productStatuses,
  type AdminProductInput,
  type ListQuery,
} from "./admin-product-schema";

export class AdminProductError extends Error {
  constructor(
    message: string,
    public readonly status = 422,
  ) {
    super(message);
  }
}

/**
 * The back office writes into one organization — the storefront the site
 * serves. It is created on first use so the panel works on a fresh database.
 */
export async function resolveAdminOrganization(
  db: Db,
): Promise<OrganizationDocument> {
  const slug = serverConfig.adminOrganizationSlug;
  const existing = await collections(db).organizations.findOne({ slug });
  if (existing) return existing;
  const organization: OrganizationDocument = {
    id: crypto.randomUUID(),
    name: serverConfig.adminOrganizationName,
    slug,
    createdAt: new Date(),
  };
  await collections(db).organizations.updateOne(
    { slug },
    { $setOnInsert: organization },
    { upsert: true },
  );
  return (
    (await collections(db).organizations.findOne({ slug })) ?? organization
  );
}

export async function listProducts(
  db: Db,
  organizationId: string,
  query: ListQuery,
): Promise<{
  items: ReturnType<typeof adminProductResponse>[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  counts: Record<string, number>;
}> {
  const c = collections(db);
  const base = baseFilter(organizationId, query);
  const filter: Filter<ProductDocument> = {
    ...base,
    ...statusFilter(query.status),
  };
  const [items, total, counts] = await Promise.all([
    c.products
      .find(filter)
      .sort(sortSpec(query.sort))
      .skip((query.page - 1) * query.pageSize)
      .limit(query.pageSize)
      .toArray(),
    c.products.countDocuments(filter),
    countByStatus(db, base),
  ]);
  return {
    items: items.map(adminProductResponse),
    total,
    page: query.page,
    pageSize: query.pageSize,
    pageCount: Math.max(1, Math.ceil(total / query.pageSize)),
    counts,
  };
}

export async function findProduct(
  db: Db,
  organizationId: string,
  productId: string,
): Promise<ProductDocument> {
  const product = await collections(db).products.findOne({
    organizationId,
    id: productId,
  });
  if (!product) throw new AdminProductError("Produit introuvable", 404);
  return product;
}

export async function createProduct(
  db: Db,
  organizationId: string,
  input: AdminProductInput,
): Promise<ProductDocument> {
  const now = new Date();
  const product: ProductDocument = {
    id: crypto.randomUUID(),
    organizationId,
    // Products of the bank belong to the shared catalogue so the public
    // visualizer and the demo can list them.
    createdByUserId: DEMO_CATALOG_USER_ID,
    name: input.name,
    description: input.description,
    objectType: input.objectType,
    sku: input.sku ?? null,
    widthCm: input.widthCm,
    heightCm: input.heightCm,
    depthCm: input.depthCm,
    material: input.material,
    placementType: input.placementType,
    generationInstructions: input.generationInstructions,
    lightingProfile: {
      source: input.lightingSource,
      reflectance: input.reflectance,
    },
    buyUrl: input.buyUrl ?? null,
    brand: input.brand,
    collection: input.collection,
    tags: input.tags,
    priceCents: roundOrNull(input.priceCents),
    currency: input.currency.toUpperCase(),
    stock: roundOrNull(input.stock),
    weightKg: input.weightKg ?? null,
    variants: input.variants.map(toVariant),
    status: "draft",
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await collections(db).products.insertOne(product);
  return product;
}

export async function updateProduct(
  db: Db,
  product: ProductDocument,
  patch: AdminProductPatch,
): Promise<ProductDocument> {
  const fields = documentFields(patch, product);
  const next: ProductDocument = {
    ...product,
    ...fields,
    updatedAt: new Date(),
  };
  if (patch.status) {
    next.status = resolveStatus(patch.status, next);
    next.archivedAt = next.status === "archived" ? new Date() : null;
  }
  await collections(db).products.updateOne(
    { id: product.id, organizationId: product.organizationId },
    {
      $set: {
        ...fields,
        ...(patch.status
          ? { status: next.status, archivedAt: next.archivedAt }
          : {}),
        updatedAt: next.updatedAt,
      },
    },
  );
  return next;
}

export async function setProductStatus(
  db: Db,
  product: ProductDocument,
  status: (typeof productStatuses)[number],
): Promise<ProductDocument> {
  const resolved = resolveStatus(status, product);
  const archivedAt = resolved === "archived" ? new Date() : null;
  await collections(db).products.updateOne(
    { id: product.id, organizationId: product.organizationId },
    { $set: { status: resolved, archivedAt, updatedAt: new Date() } },
  );
  return { ...product, status: resolved, archivedAt, updatedAt: new Date() };
}

/** Copies everything but the images, which stay attached to the original. */
export async function duplicateProduct(
  db: Db,
  product: ProductDocument,
): Promise<ProductDocument> {
  const now = new Date();
  const copy: ProductDocument = {
    ...product,
    id: crypto.randomUUID(),
    name: `${product.name} (copie)`.slice(0, 120),
    sku: product.sku ? `${product.sku}-COPIE`.slice(0, 80) : null,
    variants: (product.variants ?? []).map((variant) => ({
      ...variant,
      id: crypto.randomUUID(),
    })),
    status: "draft",
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  delete (copy as { _id?: unknown })._id;
  delete copy.assetId;
  delete copy.cutoutAssetId;
  delete copy.views;
  delete copy.expiresAt;
  await collections(db).products.insertOne(copy);
  return copy;
}

/** Removes the retention clock a temporary (guest) product carries. */
export async function persistProduct(
  db: Db,
  product: ProductDocument,
): Promise<void> {
  await collections(db).products.updateOne(
    { id: product.id, organizationId: product.organizationId },
    {
      $set: { createdByUserId: DEMO_CATALOG_USER_ID, updatedAt: new Date() },
      $unset: { expiresAt: "" },
    },
  );
  const assetIds = imageAssetIds(product);
  if (assetIds.length) {
    await collections(db).assets.updateMany(
      { id: { $in: assetIds } },
      { $unset: { expiresAt: "" } },
    );
  }
}

export async function deleteProduct(
  db: Db,
  product: ProductDocument,
): Promise<void> {
  for (const assetId of imageAssetIds(product)) {
    await deleteAsset(db, assetId).catch((reason) => {
      console.error(`Asset ${assetId} non supprimé`, reason);
    });
  }
  await collections(db).products.deleteOne({
    id: product.id,
    organizationId: product.organizationId,
  });
}

export async function overview(
  db: Db,
  organizationId: string,
): Promise<Record<string, unknown>> {
  const c = collections(db);
  const [counts, withPhoto, recent, renders, succeeded, failed, attempts] =
    await Promise.all([
      countByStatus(db, { organizationId }),
      c.products.countDocuments({
        organizationId,
        cutoutAssetId: { $exists: true },
      }),
      c.products
        .find({ organizationId })
        .sort({ updatedAt: -1 })
        .limit(6)
        .toArray(),
      c.renders.countDocuments({ organizationId }),
      c.renders.countDocuments({ organizationId, status: "succeeded" }),
      c.renders.countDocuments({ organizationId, status: "failed" }),
      c.renderAttempts
        .find({ organizationId })
        .sort({ createdAt: -1 })
        .limit(25)
        .toArray(),
    ]);
  return {
    products: { ...counts, withPhoto },
    renders: {
      total: renders,
      succeeded,
      failed,
      successRate: renders ? succeeded / renders : 0,
      estimatedCostUsd: attempts.reduce(
        (sum, attempt) => sum + (attempt.estimatedCostUsd ?? 0),
        0,
      ),
    },
    recentProducts: recent.map(adminProductResponse),
    attempts: attempts.map((attempt) => ({
      id: attempt.id,
      provider: attempt.provider,
      model: attempt.model,
      status: attempt.status,
      stage: attempt.stage ?? null,
      latencyMs: attempt.latencyMs,
      estimatedCostUsd: attempt.estimatedCostUsd,
      error: attempt.error ?? null,
      createdAt: attempt.createdAt.toISOString(),
    })),
  };
}

export function adminProductResponse(product: ProductDocument) {
  return {
    ...productResponse(product),
    organizationId: product.organizationId,
    lightingSource: String(product.lightingProfile?.source ?? "front"),
    reflectance: String(product.lightingProfile?.reflectance ?? "matte"),
    viewCount: (product.views ?? []).length,
    hasCutout: Boolean(product.cutoutAssetId),
    temporary: Boolean(product.expiresAt),
    expiresAt: product.expiresAt ? product.expiresAt.toISOString() : null,
    archivedAt: product.archivedAt ? product.archivedAt.toISOString() : null,
    thumbnailUrl: assetUrl(product.cutoutAssetId ?? product.assetId),
  };
}

export function productsToCsv(products: ProductDocument[]): string {
  const header = [
    "id",
    "nom",
    "sku",
    "type",
    "marque",
    "collection",
    "matiere",
    "support",
    "largeur_cm",
    "hauteur_cm",
    "profondeur_cm",
    "poids_kg",
    "prix",
    "devise",
    "stock",
    "tags",
    "declinaisons",
    "statut",
    "lien_achat",
    "description",
    "mis_a_jour",
  ];
  const rows = products.map((product) => [
    product.id,
    product.name,
    product.sku ?? "",
    product.objectType ?? "other",
    product.brand ?? "",
    product.collection ?? "",
    product.material,
    product.placementType,
    product.widthCm,
    product.heightCm,
    product.depthCm,
    product.weightKg ?? "",
    product.priceCents === null || product.priceCents === undefined
      ? ""
      : (product.priceCents / 100).toFixed(2),
    product.currency ?? "TND",
    product.stock ?? "",
    (product.tags ?? []).join(" | "),
    (product.variants ?? [])
      .map((variant) => `${variant.label}${variant.sku ? ` (${variant.sku})` : ""}`)
      .join(" | "),
    product.status,
    product.buyUrl ?? "",
    product.description,
    product.updatedAt.toISOString(),
  ]);
  return [header, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function baseFilter(
  organizationId: string,
  query: ListQuery,
): Filter<ProductDocument> {
  const filter: Filter<ProductDocument> = { organizationId };
  if (query.objectType !== "all") filter.objectType = query.objectType;
  if (query.placementType !== "all") {
    filter.placementType = query.placementType;
  }
  if (query.q) {
    const pattern = new RegExp(escapeRegExp(query.q), "i");
    filter.$or = [
      { name: pattern },
      { sku: pattern },
      { material: pattern },
      { brand: pattern },
      { collection: pattern },
      { description: pattern },
      { tags: pattern },
    ];
  }
  return filter;
}

function statusFilter(
  status: ListQuery["status"],
): Filter<ProductDocument> {
  if (status === "all") return {};
  if (status === "live") return { status: { $in: ["ready", "processing"] } };
  return { status };
}

function sortSpec(sort: ListQuery["sort"]): Sort {
  if (sort === "recent") return { createdAt: -1 };
  if (sort === "name") return { name: 1 };
  if (sort === "price_desc") return { priceCents: -1, updatedAt: -1 };
  if (sort === "price_asc") return { priceCents: 1, updatedAt: -1 };
  return { updatedAt: -1 };
}

async function countByStatus(
  db: Db,
  filter: Filter<ProductDocument>,
): Promise<Record<string, number>> {
  const c = collections(db);
  const [all, draft, processing, ready, archived] = await Promise.all([
    c.products.countDocuments(filter),
    c.products.countDocuments({ ...filter, status: "draft" }),
    c.products.countDocuments({ ...filter, status: "processing" }),
    c.products.countDocuments({ ...filter, status: "ready" }),
    c.products.countDocuments({ ...filter, status: "archived" }),
  ]);
  return { all, draft, processing, ready, archived };
}

/** A product only goes live once it owns a usable cutout. */
function resolveStatus(
  requested: (typeof productStatuses)[number],
  product: Pick<ProductDocument, "cutoutAssetId">,
): ProductDocument["status"] {
  if (requested === "ready" && !product.cutoutAssetId) {
    throw new AdminProductError(
      "Ajoutez une photo et lancez la préparation avant de publier ce produit.",
    );
  }
  return requested;
}

function documentFields(
  input: AdminProductPatch | AdminProductInput,
  current?: ProductDocument,
): Partial<ProductDocument> {
  const fields: Partial<ProductDocument> = {};
  if (input.name !== undefined) fields.name = input.name;
  if (input.description !== undefined) fields.description = input.description;
  if (input.objectType !== undefined) fields.objectType = input.objectType;
  if (input.placementType !== undefined) {
    fields.placementType = input.placementType;
  }
  if (input.material !== undefined) fields.material = input.material;
  if (input.sku !== undefined) fields.sku = input.sku;
  if (input.brand !== undefined) fields.brand = input.brand;
  if (input.collection !== undefined) fields.collection = input.collection;
  if (input.tags !== undefined) fields.tags = input.tags;
  if (input.widthCm !== undefined) fields.widthCm = input.widthCm;
  if (input.heightCm !== undefined) fields.heightCm = input.heightCm;
  if (input.depthCm !== undefined) fields.depthCm = input.depthCm;
  if (input.weightKg !== undefined) fields.weightKg = input.weightKg;
  if (input.priceCents !== undefined) {
    fields.priceCents = roundOrNull(input.priceCents);
  }
  if (input.currency !== undefined) {
    fields.currency = input.currency.toUpperCase();
  }
  if (input.stock !== undefined) {
    fields.stock = roundOrNull(input.stock);
  }
  if (input.buyUrl !== undefined) fields.buyUrl = input.buyUrl;
  if (input.generationInstructions !== undefined) {
    fields.generationInstructions = input.generationInstructions;
  }
  if (input.lightingSource !== undefined || input.reflectance !== undefined) {
    fields.lightingProfile = {
      ...(current?.lightingProfile ?? {}),
      source: input.lightingSource ?? current?.lightingProfile?.source ?? "front",
      reflectance:
        input.reflectance ?? current?.lightingProfile?.reflectance ?? "matte",
    };
  }
  if (input.variants !== undefined) {
    fields.variants = input.variants.map(toVariant);
  }
  return fields;
}

function toVariant(
  variant: z.infer<typeof variantSchema>,
): ProductVariantDocument {
  return {
    id: variant.id || crypto.randomUUID(),
    label: variant.label,
    sku: variant.sku ?? null,
    widthCm: variant.widthCm ?? null,
    heightCm: variant.heightCm ?? null,
    depthCm: variant.depthCm ?? null,
    priceCents: roundOrNull(variant.priceCents),
    stock: roundOrNull(variant.stock),
    available: variant.available,
  };
}

function imageAssetIds(product: ProductDocument): string[] {
  const ids = new Set<string>();
  if (product.assetId) ids.add(product.assetId);
  if (product.cutoutAssetId) ids.add(product.cutoutAssetId);
  for (const view of product.views ?? []) ids.add(view.assetId);
  return [...ids];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
