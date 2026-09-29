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
  archiveExpiry,
  productImageAssetIds,
  setProductStatus,
} from "../lib/server/admin-products";
import type { ProductDocument } from "../lib/server/types";
import { mongoStore } from "./helpers/mongo-store";

const db = {} as Db;

let products: ReturnType<typeof mongoStore>;
let assets: ReturnType<typeof mongoStore>;

const product = {
  id: "p1",
  organizationId: "org",
  name: "Vase", widthCm: 20, heightCm: 30, depthCm: 20,
  material: "Céramique", placementType: "table",
  status: "ready",
  assetId: "a-main",
  cutoutAssetId: "a-cutout",
  views: [
    { id: "v1", assetId: "a-main", type: "front" },
    { id: "v2", assetId: "a-side", type: "side" },
  ],
} as unknown as ProductDocument;

beforeEach(() => {
  products = mongoStore();
  assets = mongoStore();
  products.rows.push({ ...product });
  for (const id of ["a-main", "a-cutout", "a-side"]) {
    assets.rows.push({ id, organizationId: "org", kind: "product" });
  }
  mocks.collections.mockReturnValue({ products, assets });
});

describe("archived product retention", () => {
  it("collects every image the product owns, without duplicates", () => {
    expect(productImageAssetIds(product).sort()).toEqual([
      "a-cutout",
      "a-main",
      "a-side",
    ]);
  });

  // A17 of the audit: archiving hid the product but nothing ever stamped an
  // expiry on its images, and the purge only reads `expiresAt`.
  it("stamps a retention on the product and its images when archiving", async () => {
    const before = Date.now();
    await setProductStatus(db, product, "archived");
    const stored = products.rows[0]!;
    expect(stored.status).toBe("archived");
    expect(stored.expiresAt).toBeInstanceOf(Date);
    expect((stored.expiresAt as Date).getTime()).toBeGreaterThan(before);
    expect(assets.rows.every((row) => row.expiresAt instanceof Date)).toBe(
      true,
    );
  });

  // Found by the adversarial review of this change set: stamping without a
  // matching lift means the purge destroys the images of a live product.
  it("lifts the retention again when the product is restored", async () => {
    const archived = await setProductStatus(db, product, "archived");
    expect(archived.expiresAt).toBeInstanceOf(Date);

    const restored = await setProductStatus(db, archived, "ready");
    expect(restored.status).toBe("ready");
    expect(restored.expiresAt).toBeUndefined();
    expect(products.rows[0]!.expiresAt).toBeUndefined();
    expect(assets.rows.every((row) => row.expiresAt === undefined)).toBe(true);
  });

  it("never re-stamps an expiry an image already carries", async () => {
    const own = new Date("2026-01-01T00:00:00Z");
    assets.rows[0]!.expiresAt = own;
    await setProductStatus(db, product, "archived");
    expect(assets.rows[0]!.expiresAt).toEqual(own);
    expect(assets.rows[1]!.expiresAt).not.toEqual(own);
  });

  it("derives the archive retention from the configured room retention", () => {
    const expiry = archiveExpiry();
    const hours = (expiry.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThan(24.1);
  });
});
