import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "mongodb";

const mocks = vi.hoisted(() => ({
  collections: vi.fn(),
  config: { roomRetentionHours: 24, adminOrganizationSlug: "atelier-lili" },
}));

vi.mock("server-only", () => ({}));
vi.mock("../lib/server/mongodb", () => ({ collections: mocks.collections }));
vi.mock("../lib/server/config", () => ({ serverConfig: mocks.config }));
vi.mock("../lib/server/assets", () => ({
  assetUrl: (id?: string) => (id ? `/api/assets/${id}` : null),
  deleteAsset: vi.fn(),
}));

import {
  persistProduct,
  productQueryFilter,
  productSortSpec,
  setProductStatus,
  updateProduct,
} from "../lib/server/admin-products";
import {
  productAssetVisibility,
  productListFilter,
} from "../lib/server/product-visibility";
import type { Tenant } from "../lib/server/auth";
import {
  DEMO_CATALOG_USER_ID,
  DEMO_PRODUCT_ID,
  type ProductDocument,
} from "../lib/server/types";
import { mongoStore } from "./helpers/mongo-store";

const db = {} as Db;
let products: ReturnType<typeof mongoStore>;
let assets: ReturnType<typeof mongoStore>;

function product(overrides: Partial<ProductDocument> = {}): ProductDocument {
  return {
    id: "product-1",
    organizationId: "org-1",
    createdByUserId: DEMO_CATALOG_USER_ID,
    name: "Vase",
    description: "",
    sku: null,
    widthCm: 20,
    heightCm: 30,
    depthCm: 20,
    material: "Céramique",
    placementType: "table",
    generationInstructions: "",
    lightingProfile: {},
    buyUrl: null,
    status: "draft",
    assetId: "asset-main",
    cutoutAssetId: "asset-cutout",
    views: [],
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  products = mongoStore();
  assets = mongoStore();
  mocks.collections.mockReturnValue({ products, assets });
});

describe("catalogue publication boundary", () => {
  it("persists preparation at publication and refreshes it when dimensions change", async () => {
    const original = product();
    products.rows.push(original as unknown as Record<string, unknown>);
    assets.rows.push({ id: original.assetId, organizationId: original.organizationId, kind: "product" });
    const published = await setProductStatus(db, original, "ready");
    expect(published.spatialPreparation?.dimensions.widthCm).toBe(20);
    expect(products.rows[0]!.spatialPreparation).toEqual(
      published.spatialPreparation,
    );
    const edited = await updateProduct(db, published, { widthCm: 25 });
    expect(edited.spatialPreparation?.dimensions.widthCm).toBe(25);
    expect(edited.spatialPreparation?.fingerprint).not.toBe(
      published.spatialPreparation?.fingerprint,
    );
    const incomplete = await updateProduct(db, edited, { depthCm: 0 });
    expect(incomplete.spatialPreparation).toBeNull();
    expect(incomplete.status).toBe("ready");
  });
  it("publishes a commercial listing with its original photo and no prepared cutout", async () => {
    const original = product({ cutoutAssetId: undefined, cutout: undefined });
    products.rows.push({ ...original });
    assets.rows.push({ id: original.assetId, organizationId: original.organizationId, kind: "product", visibility: "private" });
    const published = await setProductStatus(db, original, "ready");
    expect(published.status).toBe("ready");
    expect(published.cutoutAssetId).toBeUndefined();
    expect(published.productPreparation).toBeUndefined();
    expect(assets.rows[0]?.visibility).toBe("published");
  });
  it.each([
    { name: "" }, { widthCm: 0 }, { heightCm: 0 }, { depthCm: -1 },
    { assetId: undefined },
  ])("refuses commercial publication without a valid photo and catalog fields: %j", async patch => {
    const original = product(patch);
    products.rows.push({ ...original });
    assets.rows.push({ id: "asset-main", organizationId: original.organizationId, kind: "product", visibility: "private" });
    await expect(setProductStatus(db, original, "ready")).rejects.toMatchObject({ status: 422 });
    expect(products.rows[0]?.status).toBe("draft");
    expect(assets.rows[0]?.visibility).toBe("private");
  });
  it.each(["missing", "foreign", "wrong-kind"])("refuses a %s source asset", async state => {
    const original = product();
    products.rows.push({ ...original });
    if (state !== "missing") assets.rows.push({
      id: original.assetId, organizationId: state === "foreign" ? "other-org" : original.organizationId,
      kind: state === "wrong-kind" ? "scene" : "product", visibility: "private",
    });
    await expect(setProductStatus(db, original, "ready")).rejects.toMatchObject({ status: 422 });
    expect(products.rows[0]?.status).toBe("draft");
  });
  it("keeps catalogue draft images private and publishes only ready images", () => {
    expect(productAssetVisibility(product())).toBe("organization");
    expect(productAssetVisibility(product({ status: "processing" }))).toBe(
      "organization",
    );
    expect(productAssetVisibility(product({ status: "ready" }))).toBe(
      "published",
    );
  });

  it("never publishes a visitor upload, even when it is ready", () => {
    expect(
      productAssetVisibility(
        product({ createdByUserId: "guest:abc", status: "ready" }),
      ),
    ).toEqual({ ownerSessionId: "guest:abc" });
  });

  it("limits guest and synthetic lists to the intended public catalogue", () => {
    const guest: Tenant = {
      organizationId: "org-1",
      userId: "guest:abc",
      role: "guest",
      publicSessionId: "guest:abc",
    };
    expect(productListFilter(guest)).toEqual({
      organizationId: "org-1",
      $or: [
        {
          createdByUserId: "guest:abc",
          status: { $ne: "archived" },
        },
        { createdByUserId: DEMO_CATALOG_USER_ID, status: "ready" },
        { id: DEMO_PRODUCT_ID, status: "ready" },
      ],
    });
    expect(
      productListFilter({
        organizationId: "org-1",
        userId: "demo",
        role: "owner",
        synthetic: true,
      }),
    ).toEqual({
      organizationId: "org-1",
      status: "ready",
      $or: [{ createdByUserId: DEMO_CATALOG_USER_ID }, { id: DEMO_PRODUCT_ID }],
    });
  });

  it("requires a widget product to remain ready", () => {
    expect(
      productListFilter({
        organizationId: "org-1",
        userId: "public:abc",
        role: "viewer",
        publicSessionId: "abc",
        publicProductId: "product-1",
      }),
    ).toEqual({
      organizationId: "org-1",
      id: "product-1",
      status: "ready",
    });
  });

  it("uses the same filters and sorting for the table and CSV export", () => {
    const filter = productQueryFilter("org-1", {
      q: "Vase",
      status: "ready",
      objectType: "vase",
      placementType: "table",
      sort: "price_desc",
      page: 1,
      pageSize: 24,
    });
    expect(filter).toMatchObject({
      organizationId: "org-1",
      objectType: "vase",
      placementType: "table",
      status: "ready",
    });
    expect(filter.$or).toHaveLength(7);
    expect(String(filter.$or?.[0]?.name)).toBe("/Vase/i");
    expect(productSortSpec("price_desc")).toEqual({
      priceCents: -1,
      updatedAt: -1,
    });
  });
});

describe("asset state follows product state", () => {
  function seed(item: ProductDocument, visibility = "private") {
    products.rows.push({ ...item });
    for (const id of [item.assetId, item.cutoutAssetId]) {
      assets.rows.push({
        id,
        kind: id === item.assetId ? "product" : "cutout",
        organizationId: item.organizationId,
        visibility,
        ownerSessionId: "guest:old",
      });
    }
  }

  it("publishes every image on publish and privatizes it on unpublish", async () => {
    const draft = product();
    seed(draft);
    const ready = await setProductStatus(db, draft, "ready");
    expect(assets.rows.every((row) => row.visibility === "published")).toBe(
      true,
    );
    expect(assets.rows.every((row) => row.ownerSessionId === undefined)).toBe(
      true,
    );

    await setProductStatus(db, ready, "draft");
    expect(assets.rows.every((row) => row.visibility === "private")).toBe(true);
    expect(assets.rows.every((row) => row.ownerSessionId === undefined)).toBe(
      true,
    );
  });

  it("keeps a ready visitor product scoped to its own session", async () => {
    const visitor = product({ createdByUserId: "guest:abc" });
    seed(visitor);
    await setProductStatus(db, visitor, "ready");
    expect(
      assets.rows.every(
        (row) =>
          row.visibility === "private" && row.ownerSessionId === "guest:abc",
      ),
    ).toBe(true);
  });

  it("persists a draft into the organization without making it public", async () => {
    const visitor = product({
      createdByUserId: "guest:abc",
      expiresAt: new Date("2026-09-21T00:00:00Z"),
    });
    seed(visitor);
    await persistProduct(db, visitor);
    expect(products.rows[0]!.createdByUserId).toBe(DEMO_CATALOG_USER_ID);
    expect(products.rows[0]!.expiresAt).toBeUndefined();
    expect(assets.rows.every((row) => row.visibility === "private")).toBe(true);
    expect(assets.rows.every((row) => row.ownerSessionId === undefined)).toBe(
      true,
    );
  });
});
