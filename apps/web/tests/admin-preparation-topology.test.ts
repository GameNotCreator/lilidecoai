import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Db } from "mongodb";
import sharp from "sharp";
import { mongoStore } from "./helpers/mongo-store";

const mocks = vi.hoisted(() => ({
  collections: vi.fn(), readAsset: vi.fn(), storeAsset: vi.fn(), deleteAsset: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/mongodb", () => ({ collections: mocks.collections }));
vi.mock("../lib/server/assets", async (original) => ({
  ...(await original<object>()),
  readAsset: mocks.readAsset, storeAsset: mocks.storeAsset, deleteAsset: mocks.deleteAsset,
}));

import { prepareAdminProduct } from "../lib/server/admin-product-preparation";
import { DEMO_CATALOG_USER_ID } from "../lib/server/types";

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

function arrange(source: Buffer) {
  const products = mongoStore();
  const assets = mongoStore();
  products.rows.push({
    id: "product-1", organizationId: "org-1", createdByUserId: DEMO_CATALOG_USER_ID,
    name: "Deux objets", description: "", sku: null, objectType: "vase",
    widthCm: 20, heightCm: 30, depthCm: 20, material: "ceramic", placementType: "table",
    generationInstructions: "", lightingProfile: {}, buyUrl: null,
    status: "draft", assetId: "source-1", views: [],
    createdAt: new Date("2026-09-01"), updatedAt: new Date("2026-09-01"),
  });
  mocks.collections.mockReturnValue({ products, assets });
  const bytes = new Map([["source-1", source]]);
  assets.rows.push({ id: "source-1", organizationId: "org-1", kind: "product" });
  mocks.readAsset.mockImplementation(async (_db, id: string) => ({
    asset: await assets.findOne({ id }), buffer: bytes.get(id),
  }));
  mocks.storeAsset.mockImplementation(async (_db, input: { buffer: Buffer; kind: string }) => {
    const asset = { id: "cutout-1", organizationId: "org-1", kind: input.kind };
    assets.rows.push(asset);
    bytes.set(asset.id, input.buffer);
    return asset;
  });
  return products;
}

it("refuses two separated product silhouettes before saving a reusable preparation", async () => {
  const source = await sharp(Buffer.from(
    '<svg width="600" height="400"><rect width="600" height="400" fill="white"/><rect x="60" y="60" width="140" height="280" fill="#802030"/><rect x="400" y="60" width="140" height="280" fill="#203080"/></svg>',
  )).png().toBuffer();
  const products = arrange(source);

  await expect(prepareAdminProduct({} as Db, "org-1", "product-1"))
    .rejects.toThrow("Plusieurs objets distincts");
  expect(mocks.storeAsset).not.toHaveBeenCalled();
  expect(products.rows[0]?.productPreparation).not.toHaveProperty("completed");
});

it("retains a single product with tiny detached detail and reuses the checked bytes", async () => {
  const source = await sharp(Buffer.from(
    '<svg width="600" height="400"><rect width="600" height="400" fill="white"/><rect x="220" y="60" width="160" height="280" fill="#802030"/><circle cx="430" cy="80" r="5" fill="#802030"/></svg>',
  )).png().toBuffer();
  arrange(source);
  const first = await prepareAdminProduct({} as Db, "org-1", "product-1");
  expect(first.cutout?.verdict?.usable).toBe(true);
  const second = await prepareAdminProduct({} as Db, "org-1", "product-1");
  expect(second.productPreparation?.completed).toEqual(first.productPreparation?.completed);
  expect(second.cutoutAssetId).toBe(first.cutoutAssetId);
  expect(mocks.storeAsset).toHaveBeenCalledTimes(1);
});

it.each([
  ["grenade-noire-blanche.jpg", "d12d00c13f00d414c7b9152ffa1941108904c2551adbfe0498a60e85a50c48b7"],
  ["panier-jute.jpeg", "2072f6730209f3fd4bcb23a607a645dd15f9c53b02f5f8f94101884f35a3e881"],
])("refuses the real catalog photo %s when its pale product pixels are lost, without network", async (file, hash) => {
  const source = await readFile(new URL(`./fixtures/catalogue/${file}`, import.meta.url));
  expect(createHash("sha256").update(source).digest("hex")).toBe(hash);
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
  const products = arrange(source);
  await expect(prepareAdminProduct({} as Db, "org-1", "product-1"))
    .rejects.toMatchObject({ status: 422, message: expect.stringContaining("zones transparentes") });
  expect(mocks.storeAsset).not.toHaveBeenCalled();
  expect(mocks.deleteAsset).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
  expect(products.rows[0]?.assetId).toBe("source-1");
  expect(products.rows[0]?.productPreparation).toMatchObject({
    failure: { sourceAssetId: "source-1", detail: expect.stringContaining("fond uni contrasté") },
  });
  expect(products.rows[0]?.productPreparation).not.toHaveProperty("completed");
});
