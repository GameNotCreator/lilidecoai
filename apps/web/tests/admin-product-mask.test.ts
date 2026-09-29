import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import type { Db } from "mongodb";
import sharp from "sharp";
import { mongoStore } from "./helpers/mongo-store";

const mocks = vi.hoisted(() => ({
  collections: vi.fn(), readAsset: vi.fn(), storeAsset: vi.fn(),
  deleteAsset: vi.fn(), withAdmin: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/mongodb", () => ({ collections: mocks.collections }));
vi.mock("../lib/server/assets", async (original) => ({
  ...(await original<object>()),
  readAsset: mocks.readAsset, storeAsset: mocks.storeAsset, deleteAsset: mocks.deleteAsset,
}));
vi.mock("../lib/server/admin-route", async (original) => ({
  ...(await original<object>()), withAdmin: mocks.withAdmin,
}));
vi.mock("@/lib/server/admin-products", () => import("../lib/server/admin-products"));
vi.mock("@/lib/server/admin-route", () => import("../lib/server/admin-route"));
vi.mock("@/lib/server/admin-product-preparation", () => import("../lib/server/admin-product-preparation"));
vi.mock("@/lib/server/admin-product-mask", () => import("../lib/server/admin-product-mask"));

import { applyAdminProductMask, MAX_ADMIN_MASK_BYTES } from "../lib/server/admin-product-mask";
import { prepareAdminProduct } from "../lib/server/admin-product-preparation";
import { findProduct } from "../lib/server/admin-products";
import { adminErrorResponse } from "../lib/server/admin-route";
import { ADMIN_MASK_VERSION, adminMaskConfiguration, preparationHash, productPreparationStatus } from "../lib/server/product-preparation";
import { DEMO_CATALOG_USER_ID, type ProductDocument } from "../lib/server/types";
import { POST } from "../app/api/admin/products/[id]/cutout-mask/route";

const db = {} as Db;
const productId = "00000000-0000-4000-8000-000000000010";
const sourceId = "00000000-0000-4000-8000-000000000020";
const width = 96, height = 96;
let products: ReturnType<typeof mongoStore>;
let assets: ReturnType<typeof mongoStore>;
let bytes: Map<string, Buffer>;
let source: Buffer;
let mask: Buffer;
let fetcher: ReturnType<typeof vi.spyOn>;

async function coverage(fill?: number, xOffset = 0, imageWidth = width, imageHeight = height) {
  const pixels = Buffer.alloc(imageWidth * imageHeight, fill ?? 0);
  if (fill === undefined) {
    for (let y = 16; y < Math.min(80, imageHeight); y++)
      for (let x = 24 + xOffset; x < Math.min(72 + xOffset, imageWidth); x++)
        pixels[y * imageWidth + x] = 255;
  }
  return sharp(pixels, { raw: { width: imageWidth, height: imageHeight, channels: 1 } })
    .toColourspace("b-w").png().toBuffer();
}

async function sourcePhoto() {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      pixels.set([40 + x, 50 + y, 70, 255], offset);
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

const load = () => findProduct(db, "org-1", productId);
const prepare = (buffer = mask) => prepareAdminProduct(db, "org-1", productId, {
  buffer, sourceAssetId: sourceId, sourceSha256: preparationHash(source),
});

beforeEach(async () => {
  vi.clearAllMocks();
  fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden in mask tests"));
  [source, mask] = await Promise.all([sourcePhoto(), coverage()]);
  products = mongoStore();
  assets = mongoStore();
  bytes = new Map([[sourceId, source]]);
  const product: ProductDocument = {
    id: productId, organizationId: "org-1", createdByUserId: DEMO_CATALOG_USER_ID,
    name: "Source photograph", description: "", sku: "MASK-TEST", objectType: "vase",
    widthCm: 20, heightCm: 30, depthCm: 20, material: "ceramic", placementType: "table",
    generationInstructions: "", lightingProfile: {}, buyUrl: null, status: "ready",
    assetId: sourceId, views: [], createdAt: new Date("2026-09-01"), updatedAt: new Date("2026-09-01"),
  };
  products.rows.push({ ...product });
  assets.rows.push({ id: sourceId, organizationId: "org-1", kind: "product", visibility: "published" });
  mocks.collections.mockReturnValue({ products, assets });
  mocks.readAsset.mockImplementation(async (_db, id: string) => {
    const asset = await assets.findOne({ id });
    return asset && bytes.has(id) ? { asset, buffer: bytes.get(id)! } : null;
  });
  mocks.storeAsset.mockImplementation(async (_db, input) => {
    const id = `00000000-0000-4000-8000-${String(100 + mocks.storeAsset.mock.calls.length).padStart(12, "0")}`;
    const asset = { id, organizationId: input.organizationId, kind: input.kind, visibility: input.visibility };
    await assets.insertOne(asset);
    bytes.set(id, input.buffer);
    return asset;
  });
  mocks.deleteAsset.mockImplementation(async (_db, id: string) => {
    bytes.delete(id);
    await assets.deleteOne({ id });
  });
  // Route-body tests use an already authenticated admin context. Authentication
  // itself is covered by the existing admin-route/auth suites.
  mocks.withAdmin.mockImplementation(async (_request, handler) => {
    try { return await handler({ db, organization: { id: "org-1" } }); }
    catch (reason) { return adminErrorResponse(reason); }
  });
});

afterEach(() => {
  expect(fetcher).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe("admin mask image validation", () => {
  it("uses the mask only as coverage and preserves source RGB and pre-existing alpha", async () => {
    const original = await sharp(source).ensureAlpha().raw().toBuffer();
    original[(32 * width + 32) * 4 + 3] = 128;
    const translucentSource = await sharp(original, { raw: { width, height, channels: 4 } }).png().toBuffer();
    const alpha = await sharp(mask).greyscale().raw().toBuffer();
    alpha[32 * width + 32] = 128;
    const softMask = await sharp(alpha, { raw: { width, height, channels: 1 } }).toColourspace("b-w").png().toBuffer();
    const output = await sharp(await applyAdminProductMask(translucentSource, softMask)).ensureAlpha().raw().toBuffer();
    for (let index = 0; index < alpha.length; index++) {
      const offset = index * 4;
      expect(output.subarray(offset, offset + 3)).toEqual(original.subarray(offset, offset + 3));
      expect(output[offset + 3]).toBe(Math.round(original[offset + 3]! * alpha[index]! / 255));
    }
  });

  it.each(["rgb", "alpha", "jpeg", "corrupt", "empty", "oversize"])("rejects a %s upload", async (kind) => {
    const invalid = kind === "rgb" ? await sharp(mask).toColourspace("srgb").png().toBuffer()
      : kind === "alpha" ? await sharp(mask).ensureAlpha().png().toBuffer()
      : kind === "jpeg" ? await sharp(mask).jpeg().toBuffer()
      : kind === "corrupt" ? Buffer.from("not an image")
      : kind === "empty" ? Buffer.alloc(0) : Buffer.alloc(MAX_ADMIN_MASK_BYTES + 1);
    await expect(applyAdminProductMask(source, invalid)).rejects.toMatchObject({ status: 422 });
  });

  it.each([0, 128, 255])("rejects a uniform %s coverage mask", async (fill) => {
    await expect(applyAdminProductMask(source, await coverage(fill))).rejects.toMatchObject({ status: 422 });
  });

  it("rejects mismatched source and mask dimensions", async () => {
    await expect(applyAdminProductMask(source, await coverage(undefined, 0, width + 1))).rejects.toMatchObject({ status: 422 });
  });

  it("rejects a highly compressed mask above the decoded pixel limit", async () => {
    const huge = await coverage(undefined, 0, 2049, 2049);
    expect(huge.length).toBeLessThan(MAX_ADMIN_MASK_BYTES);
    await expect(applyAdminProductMask(source, huge)).rejects.toMatchObject({ status: 422 });
  });
});

describe("admin mask provenance and reusable preparation", () => {
  // These are reviewed masks from real catalog photos, not an automatic rule
  // for new products. The grenade's solid interior was filled offline only;
  // no hole-filling repair is performed by the admin runtime.
  it.each([
    { name: "grenade", maskFile: "grenade-stored-solid-mask.png", sourceSha: "c5759fd4f64f06db125317e723cd4d96dece6a0c4342768eea45d074cdb6271f", maskSha: "78f203382f2800c535478a78330f52e287a18e081e9cdcec4db5dda0faf7457f", size: 14 },
    { name: "panier", maskFile: "panier-stored-mask.png", sourceSha: "fdfcc1dadc048b9cbfb22e3113f5b6d9205bb0becb3b426cbb014021965adfba", maskSha: "46f77815c154a182432c6a1cd368d28e4459bdf30610b9d5ee9a3ee1dfd4ac0f", size: 40 },
  ])("prepares and reuses the real $name source and reviewed mask without changing RGB", async (fixture) => {
    source = await readFile(new URL(`./fixtures/catalogue/${fixture.name}-stored-source.webp`, import.meta.url));
    mask = await readFile(new URL(`./fixtures/catalogue/${fixture.maskFile}`, import.meta.url));
    expect(preparationHash(source)).toBe(fixture.sourceSha);
    expect(preparationHash(mask)).toBe(fixture.maskSha);
    bytes.set(sourceId, source);
    await products.updateOne({ id: productId }, { $set: {
      objectType: "other", widthCm: fixture.size, heightCm: fixture.size, depthCm: fixture.size,
      placementType: fixture.name === "panier" ? "floor" : "table",
    } });
    const original = await sharp(source).ensureAlpha().raw().toBuffer();
    const alpha = await sharp(mask).greyscale().raw().toBuffer();
    const applied = await sharp(await applyAdminProductMask(source, mask)).ensureAlpha().raw().toBuffer();
    let changedRgb = 0, changedAlpha = 0;
    for (let index = 0; index < alpha.length; index++) {
      const offset = index * 4;
      if (applied[offset] !== original[offset] || applied[offset + 1] !== original[offset + 1] || applied[offset + 2] !== original[offset + 2]) changedRgb++;
      if (applied[offset + 3] !== Math.round(original[offset + 3]! * alpha[index]! / 255)) changedAlpha++;
    }
    expect(changedRgb).toBe(0);
    expect(changedAlpha).toBe(0);
    const first = await prepare();
    expect(first.status).toBe("draft");
    expect(first.cutout).toMatchObject({ source: "matting", synthetic: false, cutoutVersion: ADMIN_MASK_VERSION, verdict: { usable: true } });
    expect(first.productPreparation?.completed).toMatchObject({ sourceSha256: fixture.sourceSha, maskSha256: fixture.maskSha, configuration: adminMaskConfiguration() });
    expect(productPreparationStatus(first).status).toBe("ready");
    expect(preparationHash(bytes.get(first.cutoutAssetId!)!)).toBe(first.productPreparation?.completed?.cutoutSha256);
    await products.updateOne({ id: productId }, { $set: { status: "ready" } });
    const second = await prepare();
    expect(second.status).toBe("ready");
    expect(second.cutoutAssetId).toBe(first.cutoutAssetId);
    expect(second.productPreparation).toEqual(first.productPreparation);
    expect(mocks.storeAsset).toHaveBeenCalledTimes(1);
  });

  it("stores real source pixels, fingerprints the mask, and makes a new preparation draft", async () => {
    const result = await prepare();
    expect(result.status).toBe("draft");
    expect(result.cutout).toMatchObject({ source: "matting", synthetic: false, cutoutVersion: ADMIN_MASK_VERSION, verdict: { usable: true } });
    expect(result.productPreparation?.completed).toMatchObject({
      sourceAssetId: sourceId, sourceSha256: preparationHash(source), maskSha256: preparationHash(mask), configuration: adminMaskConfiguration(),
    });
    expect(productPreparationStatus(result).status).toBe("ready");
    const output = await sharp(bytes.get(result.cutoutAssetId!)!).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const original = await sharp(source).ensureAlpha().raw().toBuffer();
    const allowed = new Set<string>();
    for (let y = 16; y < 80; y++) for (let x = 24; x < 72; x++) {
      const offset = (y * width + x) * 4;
      allowed.add(original.subarray(offset, offset + 3).toString("hex"));
    }
    for (let i = 0; i < output.data.length; i += 4)
      if (output.data[i + 3]! > 0) expect(allowed.has(output.data.subarray(i, i + 3).toString("hex"))).toBe(true);
    expect(bytes.get(sourceId)).toEqual(source);
  });

  it("reuses identical bytes with and without re-uploading the mask, including a geometry refresh", async () => {
    const first = await prepare();
    await products.updateOne({ id: productId }, { $set: { status: "ready" } });
    const same = await prepare();
    expect(same.status).toBe("ready");
    expect(same.updatedAt).toEqual(first.updatedAt);
    expect(same.productPreparation).toEqual(first.productPreparation);
    await products.updateOne({ id: productId }, { $set: { heightCm: 42 } });
    const refreshed = await prepareAdminProduct(db, "org-1", productId);
    expect(refreshed.cutoutAssetId).toBe(first.cutoutAssetId);
    expect(refreshed.status).toBe("ready");
    expect(productPreparationStatus(refreshed).status).toBe("ready");
    expect(refreshed.productPreparation?.completed?.maskSha256).toBe(preparationHash(mask));
    expect(refreshed.productPreparation?.completed?.configuration).toBe(adminMaskConfiguration());
    expect(mocks.storeAsset).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a changed mask and retains the previous bytes privately", async () => {
    const first = await prepare();
    await products.updateOne({ id: productId }, { $set: { status: "ready" } });
    await assets.updateOne({ id: first.cutoutAssetId }, { $set: { visibility: "published" } });
    const second = await prepare(await coverage(undefined, 2));
    expect(second.cutoutAssetId).not.toBe(first.cutoutAssetId);
    expect(second.status).toBe("draft");
    expect(second.productPreparation?.completed?.maskSha256).not.toBe(first.productPreparation?.completed?.maskSha256);
    expect(bytes.has(first.cutoutAssetId!)).toBe(true);
    expect(await assets.findOne({ id: first.cutoutAssetId })).toMatchObject({ visibility: "private" });
  });

  it.each(["id", "sha"])("refuses a mismatched source %s before creating a cutout", async (kind) => {
    await expect(prepareAdminProduct(db, "org-1", productId, {
      buffer: mask, sourceAssetId: kind === "id" ? "different-source" : sourceId,
      sourceSha256: kind === "sha" ? "0".repeat(64) : preparationHash(source),
    })).rejects.toMatchObject({ status: 409 });
    expect(mocks.storeAsset).not.toHaveBeenCalled();
    expect((await load()).cutoutAssetId).toBeUndefined();
    expect((await load()).productPreparation?.lease).toBeUndefined();
  });

  it("never overrides the merchant's visualization veto", async () => {
    await products.updateOne({ id: productId }, { $set: { visualizationBlockedReason: "Photo includes an unlisted object" } });
    await expect(prepare()).rejects.toMatchObject({ status: 422 });
    expect(mocks.readAsset).not.toHaveBeenCalled();
    expect(mocks.storeAsset).not.toHaveBeenCalled();
  });

  it("refuses a source from another organization", async () => {
    await assets.updateOne({ id: sourceId }, { $set: { organizationId: "another-org" } });
    await expect(prepare()).rejects.toMatchObject({ status: 404 });
    expect(mocks.storeAsset).not.toHaveBeenCalled();
  });

  it("recomputes instead of reusing changed cutout bytes", async () => {
    const first = await prepare();
    bytes.set(first.cutoutAssetId!, Buffer.from("tampered"));
    const second = await prepare();
    expect(second.cutoutAssetId).not.toBe(first.cutoutAssetId);
    expect(mocks.storeAsset).toHaveBeenCalledTimes(2);
  });

  it("keeps the cutout when the commit succeeded but its acknowledgement was lost", async () => {
    const update = products.updateOne.bind(products);
    vi.spyOn(products, "updateOne").mockImplementation(async (filter, changes, options) => {
      const result = await update(filter, changes, options);
      if (changes.$set && "cutoutAssetId" in (changes.$set as Record<string, unknown>))
        throw new Error("Mongo acknowledgement lost after write");
      return result;
    });
    await expect(prepare()).rejects.toThrow("Mongo acknowledgement lost after write");
    const persisted = await load();
    expect(persisted.cutoutAssetId).toBeDefined();
    expect(bytes.has(persisted.cutoutAssetId!)).toBe(true);
    expect(await assets.findOne({ id: persisted.cutoutAssetId })).not.toBeNull();
    expect(mocks.deleteAsset).not.toHaveBeenCalled();
  });

  it.each(["source", "veto", "lease"])("cannot commit after a concurrent %s change", async (kind) => {
    const save = mocks.storeAsset.getMockImplementation()!;
    mocks.storeAsset.mockImplementationOnce(async (...args) => {
      const asset = await save(...args);
      if (kind === "source") await products.updateOne({ id: productId }, {
        $set: { assetId: "new-source" }, $unset: { productPreparation: "" },
      });
      if (kind === "veto") await products.updateOne({ id: productId }, { $set: { visualizationBlockedReason: "Stop publication" } });
      if (kind === "lease") await products.updateOne({ id: productId }, { $set: {
        "productPreparation.lease": { token: "new-worker", sourceAssetId: sourceId, expiresAt: new Date(Date.now() + 60_000) },
      } });
      return asset;
    });
    await expect(prepare()).rejects.toMatchObject({ status: kind === "veto" ? 422 : 409 });
    expect((await load()).cutoutAssetId).toBeUndefined();
    expect(mocks.deleteAsset).toHaveBeenCalledTimes(1);
    if (kind === "lease") expect((await load()).productPreparation?.lease?.token).toBe("new-worker");
  });
});

describe("raw PNG mask route", () => {
  const context = { params: Promise.resolve({ id: productId }) };
  function request(body: Uint8Array = new Uint8Array(mask), headers: Record<string, string> = {}) {
    return new Request("http://localhost/api/admin/products/product/cutout-mask", {
      method: "POST", body: new Uint8Array(body), headers: {
        "content-type": "image/png", "x-source-asset-id": sourceId,
        "x-source-sha256": preparationHash(source), ...headers,
      },
    });
  }

  it("accepts only the fixed source and returns the new draft preparation", async () => {
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "draft", preparation: { status: "ready" } });
  });

  it.each(["content-type", "x-source-asset-id", "x-source-sha256"])("rejects invalid %s before processing", async (header) => {
    const response = await POST(request(undefined, { [header]: "invalid" }), context);
    expect(response.status).toBe(422);
    expect(mocks.readAsset).not.toHaveBeenCalled();
  });

  it("stops an oversized body even without a content-length header", async () => {
    const response = await POST(request(new Uint8Array(MAX_ADMIN_MASK_BYTES + 1)), context);
    expect(response.status).toBe(413);
    expect(mocks.readAsset).not.toHaveBeenCalled();
    expect(mocks.storeAsset).not.toHaveBeenCalled();
  });
});
