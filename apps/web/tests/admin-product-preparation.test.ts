import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "mongodb";
import { mongoStore } from "./helpers/mongo-store";

const mocks = vi.hoisted(() => ({
  collections: vi.fn(), readAsset: vi.fn(), storeAsset: vi.fn(),
  deleteAsset: vi.fn(), prepareCutout: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/mongodb", () => ({ collections: mocks.collections }));
vi.mock("../lib/server/config", () => ({ serverConfig: { roomRetentionHours: 24 } }));
vi.mock("../lib/server/mask-topology", () => ({ hasSeparatedSubjects: vi.fn(async () => false) }));
vi.mock("../lib/server/assets", () => ({
  CUTOUT_VERSION: "cutout-v2", ...mocks,
  assetUrl: (id?: string) => id ? `/api/assets/${id}` : null,
}));

import { prepareAdminProduct } from "../lib/server/admin-product-preparation";
import { adminProductResponse, duplicateProduct, findProduct, setProductStatus, updateProduct } from "../lib/server/admin-products";
import { productPreparationStatus } from "../lib/server/product-preparation";
import { prepareProductGeometry } from "../lib/server/spatial-policy";
import { DEMO_CATALOG_USER_ID, type ProductDocument } from "../lib/server/types";

const db = {} as Db;
let products: ReturnType<typeof mongoStore>;
let assets: ReturnType<typeof mongoStore>;
let bytes: Map<string, Buffer>;
const matte = () => ({
  buffer: Buffer.from("authentic local cutout"), widthPx: 300, heightPx: 500,
  baseRowFraction: 0.98, shadowRemoved: false, warnings: [],
  quality: { opaque: false, vanished: false, multipleSubjects: false },
});
const load = () => findProduct(db, "org-1", "product-1");
const prepare = () => prepareAdminProduct(db, "org-1", "product-1");

beforeEach(() => {
  vi.clearAllMocks();
  products = mongoStore();
  assets = mongoStore();
  bytes = new Map([["source-1", Buffer.from("original photo")]]);
  mocks.collections.mockReturnValue({ products, assets });
  const product: ProductDocument = {
    id: "product-1", organizationId: "org-1", createdByUserId: DEMO_CATALOG_USER_ID,
    name: "Vase", description: "", sku: null, objectType: "vase",
    widthCm: 20, heightCm: 30, depthCm: 20, material: "ceramic", placementType: "table",
    generationInstructions: "", lightingProfile: {}, buyUrl: null,
    status: "processing", assetId: "source-1", views: [],
    createdAt: new Date("2026-09-01"), updatedAt: new Date("2026-09-01"),
  };
  products.rows.push({ ...product });
  assets.rows.push({ id: "source-1", organizationId: "org-1", kind: "product", visibility: "private" });
  mocks.readAsset.mockImplementation(async (_db, id: string) => {
    const asset = await assets.findOne({ id });
    return asset && bytes.has(id) ? { asset, buffer: bytes.get(id)! } : null;
  });
  mocks.storeAsset.mockImplementation(async (_db, input) => {
    const id = `cutout-${mocks.storeAsset.mock.calls.length}`;
    const asset = { id, organizationId: input.organizationId, kind: input.kind, visibility: "private" };
    await assets.insertOne(asset);
    bytes.set(id, input.buffer);
    return asset;
  });
  mocks.deleteAsset.mockImplementation(async (_db, id: string) => {
    bytes.delete(id);
    await assets.deleteOne({ id });
  });
  mocks.prepareCutout.mockImplementation(async () => matte());
});

describe("local back-office preparation reuse", () => {
  it("blocks local preparation and old prepared cutouts until the catalog veto is explicitly cleared", async () => {
    const first = await prepare();
    const blocked = await updateProduct(db, first, { visualizationBlockedReason: "La photo comprend une plante non comprise dans les dimensions du pot." });
    expect(adminProductResponse(blocked).visualizationBlockedReason).toContain("plante");
    expect(productPreparationStatus(blocked).status).toBe("failed");
    await expect(prepare()).rejects.toMatchObject({ status: 422 });
    expect(mocks.prepareCutout).toHaveBeenCalledTimes(1);
    expect((await load()).productPreparation?.completed).toEqual(first.productPreparation?.completed);
    const edited = await updateProduct(db, await load(), { description: "Fiche commerciale" });
    expect(edited.visualizationBlockedReason).toBe(blocked.visualizationBlockedReason);
    expect((await setProductStatus(db, edited, "ready")).status).toBe("ready");
    await updateProduct(db, await load(), { visualizationBlockedReason: null });
    expect((await prepare()).cutoutAssetId).toBe(first.cutoutAssetId);
    expect(mocks.prepareCutout).toHaveBeenCalledTimes(1);
  });
  it("prepares once, keeps published status and timestamps on an identical replay", async () => {
    expect(productPreparationStatus(await load()).status).toBe("not-prepared");
    const first = await prepare();
    expect(first.status).toBe("draft");
    expect(first.spatialPreparation).toEqual(prepareProductGeometry(first));
    expect(adminProductResponse(first).preparation.status).toBe("ready");
    await products.updateOne({ id: first.id }, { $set: { status: "ready" } });
    const second = await prepare();
    expect(second.status).toBe("ready");
    expect(second.updatedAt).toEqual(first.updatedAt);
    expect(second.productPreparation).toEqual(first.productPreparation);
    expect(second.cutoutAssetId).toBe(first.cutoutAssetId);
    expect(mocks.prepareCutout).toHaveBeenCalledTimes(1);
    expect(mocks.storeAsset).toHaveBeenCalledTimes(1);
    expect(mocks.deleteAsset).not.toHaveBeenCalled();
    expect(assets.rows.every(asset => asset.visibility === "private")).toBe(true);
  });

  it("refreshes changed dimensions without cutting or storing the photo again", async () => {
    const first = await prepare();
    const edited = await updateProduct(db, first, { widthCm: 25 });
    expect(productPreparationStatus(edited).status).toBe("stale");
    const refreshed = await prepare();
    expect(refreshed.cutoutAssetId).toBe(first.cutoutAssetId);
    expect(refreshed.cutout).toEqual(first.cutout);
    expect(refreshed.spatialPreparation?.dimensions.widthCm).toBe(25);
    expect(refreshed.productPreparation?.completed?.geometryFingerprint).not.toBe(first.productPreparation?.completed?.geometryFingerprint);
    expect(productPreparationStatus(refreshed).status).toBe("ready");
    expect(mocks.prepareCutout).toHaveBeenCalledTimes(1);
    expect(mocks.storeAsset).toHaveBeenCalledTimes(1);
    expect(mocks.deleteAsset).not.toHaveBeenCalled();
  });

  it("does not invalidate photo preparation for a price/description edit", async () => {
    const first = await prepare();
    const edited = await updateProduct(db, first, { priceCents: 2400, description: "Nouveau texte" });
    expect(productPreparationStatus(edited).status).toBe("ready");
    expect((await prepare()).productPreparation).toEqual(first.productPreparation);
    expect(mocks.prepareCutout).toHaveBeenCalledTimes(1);
  });

  it("retains an earlier cutout and records the refusal when a local recheck loses the silhouette", async () => {
    const first = await prepare();
    await products.updateOne({ id: first.id }, { $set: {
      "productPreparation.completed.configuration": "admin-local-v2/cutout-v2/topology-v1",
    } });
    mocks.prepareCutout.mockResolvedValueOnce({ ...matte(), quality: { ...matte().quality, hollowed: true } });
    await expect(prepare()).rejects.toMatchObject({ status: 422 });
    const failed = await load();
    expect(failed.assetId).toBe(first.assetId);
    expect(failed.cutoutAssetId).toBe(first.cutoutAssetId);
    expect(failed.productPreparation?.completed?.cutoutSha256).toBe(first.productPreparation?.completed?.cutoutSha256);
    expect(productPreparationStatus(failed).status).toBe("failed");
    expect(bytes.has(first.cutoutAssetId!)).toBe(true);
    expect(mocks.storeAsset).toHaveBeenCalledTimes(1);
    expect(mocks.deleteAsset).not.toHaveBeenCalled();
  });

  it.each(["source bytes", "cutout bytes", "missing cutout", "configuration", "pre-topology configuration", "pre-hollowed-refusal configuration", "unknown metadata", "synthetic metadata", "modified metadata", "rejected metadata"])(
    "refuses reuse after %s changes", async change => {
      const first = await prepare();
      if (change === "source bytes") bytes.set("source-1", Buffer.from("replaced under same id"));
      if (change === "cutout bytes") bytes.set(first.cutoutAssetId!, Buffer.from("tampered cutout"));
      if (change === "missing cutout") bytes.delete(first.cutoutAssetId!);
      if (change === "configuration") await products.updateOne({ id: first.id }, { $set: { "productPreparation.completed.configuration": "outdated" } });
      if (change === "pre-topology configuration") await products.updateOne({ id: first.id }, { $set: { "productPreparation.completed.configuration": "admin-local-v1/cutout-v2" } });
      if (change === "pre-hollowed-refusal configuration") await products.updateOne({ id: first.id }, { $set: { "productPreparation.completed.configuration": "admin-local-v2/cutout-v2/topology-v1" } });
      if (change === "unknown metadata") await products.updateOne({ id: first.id }, { $unset: { cutout: "" } });
      if (change === "synthetic metadata") await products.updateOne({ id: first.id }, { $set: { "cutout.synthetic": true } });
      if (change === "modified metadata") await products.updateOne({ id: first.id }, { $set: { "cutout.widthPx": 400 } });
      if (change === "rejected metadata") await products.updateOne({ id: first.id }, { $set: { "cutout.verdict.usable": false } });
      const second = await prepare();
      expect(second.cutoutAssetId).not.toBe(first.cutoutAssetId);
      expect(mocks.prepareCutout).toHaveBeenCalledTimes(2);
      expect(mocks.storeAsset).toHaveBeenCalledTimes(2);
      expect(productPreparationStatus(second).status).toBe("ready");
    },
  );

  it("rejects another organization's source before processing bytes", async () => {
    await assets.updateOne({ id: "source-1" }, { $set: { organizationId: "other-org" } });
    await expect(prepare()).rejects.toMatchObject({ status: 404 });
    expect(mocks.prepareCutout).not.toHaveBeenCalled();
    expect(productPreparationStatus(await load()).status).toBe("failed");
    expect((await load()).productPreparation?.lease).toBeUndefined();
  });

  it("never reuses or deletes a cutout belonging to another organization", async () => {
    const first = await prepare();
    await assets.updateOne({ id: first.cutoutAssetId }, { $set: { organizationId: "other-org" } });
    const second = await prepare();
    expect(second.cutoutAssetId).not.toBe(first.cutoutAssetId);
    expect(mocks.prepareCutout).toHaveBeenCalledTimes(2);
    expect(mocks.deleteAsset).not.toHaveBeenCalled();
    expect(bytes.has(first.cutoutAssetId!)).toBe(true);
  });

  it("does not copy image preparation to a duplicated product", async () => {
    const copy = await duplicateProduct(db, await prepare());
    expect(copy.productPreparation).toBeUndefined();
    expect(copy.spatialPreparation).toBeUndefined();
    expect(productPreparationStatus(copy)).toMatchObject({ status: "missing-photo", preparedAt: null });
  });

  it("preserves replaced bytes for already admitted durable renders and retires public access", async () => {
    const first = await prepare();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60_000);
    await assets.updateOne({ id: first.cutoutAssetId }, { $set: { visibility: "published", expiresAt } });
    bytes.set("source-1", Buffer.from("replacement source"));
    const second = await prepare();
    expect(second.cutoutAssetId).not.toBe(first.cutoutAssetId);
    expect(bytes.get(first.cutoutAssetId!)).toEqual(matte().buffer);
    expect(await assets.findOne({ id: first.cutoutAssetId })).toMatchObject({ visibility: "private", expiresAt });
    expect(mocks.deleteAsset).not.toHaveBeenCalled();
  });

  it("publishes commercial listings while preserving stale or failed visualization preparation", async () => {
    const first = await prepare();
    const stale = await updateProduct(db, first, { widthCm: 24 });
    expect((await setProductStatus(db, stale, "ready")).status).toBe("ready");
    expect(productPreparationStatus(await load()).status).toBe("stale");
    expect((await setProductStatus(db, await prepare(), "ready")).status).toBe("ready");
    await products.updateOne({ id: first.id }, { $set: {
      "productPreparation.failure": { sourceAssetId: "source-1", detail: "Unusable", at: new Date() },
    } });
    expect((await setProductStatus(db, await load(), "ready")).status).toBe("ready");
    expect(productPreparationStatus(await load()).status).toBe("failed");
    await products.updateOne({ id: first.id }, { $unset: { productPreparation: "" } });
    expect((await setProductStatus(db, await load(), "ready")).status).toBe("ready");
  });

  it.each(["tracked", "legacy"])("refuses publication of a stale %s snapshot after front replacement", async kind => {
    await prepare();
    if (kind === "legacy") await products.updateOne({ id: "product-1" }, { $unset: { productPreparation: "" } });
    const snapshot = await load();
    await products.updateOne({ id: snapshot.id }, {
      $set: { assetId: "replacement-front", status: "processing" },
      $unset: { cutoutAssetId: "", cutout: "", productPreparation: "" },
    });
    await expect(setProductStatus(db, snapshot, "ready")).rejects.toMatchObject({ status: 409 });
    expect((await load()).status).toBe("processing");
    expect(assets.rows.every(asset => asset.visibility === "private")).toBe(true);
  });

  it.each(["lease", "dimensions"])("refuses publication after a concurrent %s change with unchanged updatedAt", async change => {
    const snapshot = await prepare();
    await products.updateOne({ id: snapshot.id }, { $set: change === "lease" ? {
      "productPreparation.lease": { token: "new-worker", sourceAssetId: "source-1", expiresAt: new Date(Date.now() + 60_000) },
    } : { widthCm: 200 } });
    await expect(setProductStatus(db, snapshot, "ready")).rejects.toMatchObject({ status: 409 });
    expect((await load()).status).toBe("draft");
    expect(assets.rows.every(asset => asset.visibility === "private")).toBe(true);
  });
});

describe("preparation concurrency and failures", () => {
  function pauseCutout() {
    let enter!: () => void;
    let resume!: () => void;
    const started = new Promise<void>(resolve => { enter = resolve; });
    const paused = new Promise<void>(resolve => { resume = resolve; });
    mocks.prepareCutout.mockImplementationOnce(async () => { enter(); await paused; return matte(); });
    return { started, resume };
  }

  it("does not commit a preparation when a catalog veto is added during processing", async () => {
    const pause = pauseCutout();
    const running = prepare();
    await pause.started;
    await updateProduct(db, await load(), { visualizationBlockedReason: "Photo à remplacer" });
    pause.resume();
    await expect(running).rejects.toMatchObject({ status: 422 });
    expect((await load()).cutoutAssetId).toBeUndefined();
    expect((await load()).visualizationBlockedReason).toBe("Photo à remplacer");
    expect(productPreparationStatus(await load()).status).toBe("failed");
    expect(mocks.deleteAsset).toHaveBeenCalledOnce();
  });

  it("admits only one simultaneous preparation", async () => {
    const pause = pauseCutout();
    const running = prepare();
    await pause.started;
    expect(productPreparationStatus(await load()).status).toBe("preparing");
    await expect(prepare()).rejects.toMatchObject({ status: 409 });
    pause.resume();
    expect(productPreparationStatus(await running).status).toBe("ready");
    expect(mocks.prepareCutout).toHaveBeenCalledTimes(1);
    expect((await load()).productPreparation?.lease).toBeUndefined();
  });

  it("uses dimensions changed during processing without repeating the cutout", async () => {
    const pause = pauseCutout();
    const running = prepare();
    await pause.started;
    await updateProduct(db, await load(), { heightCm: 42 });
    pause.resume();
    const result = await running;
    expect(result.heightCm).toBe(42);
    expect(result.spatialPreparation?.dimensions.heightCm).toBe(42);
    expect(productPreparationStatus(result).status).toBe("ready");
    expect(mocks.prepareCutout).toHaveBeenCalledTimes(1);
  });

  it("cannot commit old pixels after a front photo replacement", async () => {
    const pause = pauseCutout();
    const running = prepare();
    await pause.started;
    await products.updateOne({ id: "product-1" }, {
      $set: { assetId: "new-source" }, $unset: { productPreparation: "", cutoutAssetId: "", cutout: "" },
    });
    pause.resume();
    await expect(running).rejects.toMatchObject({ status: 409 });
    const current = await load();
    expect(current.assetId).toBe("new-source");
    expect(current.cutoutAssetId).toBeUndefined();
    expect(current.productPreparation).toBeUndefined();
    expect(mocks.deleteAsset).toHaveBeenCalledWith(db, "cutout-1");
  });

  it("fences an expired worker from another worker's lease and failure state", async () => {
    const pause = pauseCutout();
    const running = prepare();
    await pause.started;
    const replacement = { token: "another-worker", sourceAssetId: "source-1", expiresAt: new Date(Date.now() + 60_000) };
    await products.updateOne({ id: "product-1" }, { $set: { "productPreparation.lease": replacement } });
    pause.resume();
    await expect(running).rejects.toMatchObject({ status: 409 });
    expect((await load()).productPreparation).toEqual({ lease: replacement });
    expect(mocks.deleteAsset).toHaveBeenCalledWith(db, "cutout-1");
  });

  it("stores a useful failure and releases the lease when the photo cannot be separated", async () => {
    mocks.prepareCutout.mockResolvedValueOnce({ ...matte(), quality: { opaque: true } });
    await expect(prepare()).rejects.toMatchObject({ status: 422 });
    expect(mocks.storeAsset).not.toHaveBeenCalled();
    expect(productPreparationStatus(await load())).toMatchObject({ status: "failed", detail: expect.stringContaining("fond") });
    expect((await load()).productPreparation?.lease).toBeUndefined();
    expect(productPreparationStatus(await prepare()).status).toBe("ready");
  });

  it("shows failed when changed source bytes invalidate a previously completed preparation", async () => {
    await prepare();
    bytes.set("source-1", Buffer.from("changed source"));
    mocks.prepareCutout.mockResolvedValueOnce({ ...matte(), quality: { opaque: true } });
    await expect(prepare()).rejects.toMatchObject({ status: 422 });
    expect(productPreparationStatus(await load()).status).toBe("failed");
  });

  it("requires explicit restoration before preparing an archived product", async () => {
    await products.updateOne({ id: "product-1" }, { $set: { status: "archived" } });
    const before = await load();
    await expect(prepare()).rejects.toMatchObject({ status: 409 });
    expect(await load()).toEqual(before);
    expect(mocks.readAsset).not.toHaveBeenCalled();
    expect(mocks.prepareCutout).not.toHaveBeenCalled();
  });

  it("cannot restore a product archived while preparation is running", async () => {
    const pause = pauseCutout();
    const running = prepare();
    await pause.started;
    const archivedAt = new Date();
    await products.updateOne({ id: "product-1" }, { $set: { status: "archived", archivedAt } });
    pause.resume();
    await expect(running).rejects.toMatchObject({ status: 409 });
    const current = await load();
    expect(current.status).toBe("archived");
    expect(current.archivedAt).toEqual(archivedAt);
    expect(current.cutoutAssetId).toBeUndefined();
    expect(current.productPreparation).toEqual({});
    expect(mocks.deleteAsset).toHaveBeenCalledWith(db, "cutout-1");
  });

  it("fences even a dimension edit made in the same millisecond just before commit", async () => {
    const update = products.updateOne.bind(products);
    vi.spyOn(products, "updateOne").mockImplementation(async (filter, changes, options) => {
      if (changes.$set && "cutoutAssetId" in (changes.$set as Record<string, unknown>)) {
        // Preserve updatedAt deliberately: a timestamp alone is not a revision.
        await update({ id: "product-1" }, { $set: { widthCm: 99 } });
      }
      return update(filter, changes, options);
    });
    await expect(prepare()).rejects.toMatchObject({ status: 409 });
    const current = await load();
    expect(current.widthCm).toBe(99);
    expect(current.cutoutAssetId).toBeUndefined();
    expect(current.spatialPreparation).toBeUndefined();
    expect(mocks.deleteAsset).toHaveBeenCalledWith(db, "cutout-1");
  });
});
