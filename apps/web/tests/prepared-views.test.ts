import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "mongodb";
import { preparedProductViewSchema, prepareViewRequestSchema, reviewPreparedViewRequestSchema, retryPreparedViewMatteRequestSchema } from "@lili/types";
import { mongoStore } from "./helpers/mongo-store";

const mocks = vi.hoisted(() => ({ readAsset: vi.fn(), storeAsset: vi.fn(), findProduct: vi.fn(),
  prepareView: vi.fn(), downloadPreparedResponse: vi.fn(), prepareViewMatte: vi.fn(), acquireSlot: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/assets", () => ({ readAsset: mocks.readAsset, storeAsset: mocks.storeAsset }));
vi.mock("../lib/server/admin-products", () => ({
  findProduct: mocks.findProduct,
  AdminProductError: class extends Error { constructor(message: string, readonly status = 422) { super(message); } },
}));
vi.mock("../lib/server/ai/myarchitectai", () => ({
  MYARCHITECTAI_CONFIGURATION_VERSION: "test-provider-v1",
  MyArchitectAIImageProvider: class { isAvailable() { return true; } prepareView = mocks.prepareView; downloadPreparedResponse = mocks.downloadPreparedResponse; },
}));
vi.mock("../lib/server/prepared-view-matte", () => ({ PREPARED_MATTE_VERSION: "test-matte-v1", prepareViewMatte: mocks.prepareViewMatte }));
vi.mock("../lib/server/oriented-provider-execution", () => ({ acquireOrientedProviderSlot: mocks.acquireSlot }));
vi.mock("../lib/server/durable-queue", () => ({ transaction: async (_db: Db, fn: (session: unknown) => Promise<unknown>) => fn({}) }));

import { admitPreparedViews, assertSnapshotDeliverable, listPreparedViews, preparedHash, preparedSources,
  reviewPreparedView, revokePreparedView } from "../lib/server/prepared-views";
import { queuePreparedView, runPreparedViewTask, retryPreparedViewMatte, preparedMatteRetryAvailability, type PreparedViewTask } from "../lib/server/prepared-view-tasks";
import { assetRequiredByPreparedWork, retirePreparedProduct } from "../lib/server/prepared-view-retention";
import type { ProductDocument } from "../lib/server/types";
import { AdminProductError } from "../lib/server/admin-products";
import { serverConfig } from "../lib/server/config";

type Store = ReturnType<typeof mongoStore>;
let stores: Map<string, Store>;
let bytes: Map<string, { asset: Record<string, unknown>; buffer: Buffer }>;
let product: ProductDocument;
const store = (name: string) => {
  if (!stores.has(name)) stores.set(name, mongoStore());
  return stores.get(name)!;
};
const db = { collection: (name: string) => ({ ...store(name), createIndex: vi.fn(async () => "index") }) } as unknown as Db;
const req = (preset = "front", idempotencyKey = "request-key-1") => ({ preset, idempotencyKey, variantId: null,
  expectedProductRevision: product.updatedAt.toISOString() });
const review = (revision: number, decision = "approved") => ({ expectedRevision: revision, decision,
  criteria: { identity: "pass", silhouette: "pass", color: "pass", pattern: "pass", alpha: "pass", contact: "pass" },
  coverage: { azimuthMinDeg: -10, azimuthMaxDeg: 10, elevationMinDeg: 0, elevationMaxDeg: 15 },
  estimatedOrientation: { azimuthDeg: 0, elevationDeg: 5, rollDeg: 0 },
  physicalHeightSegment: { bottom: { x: 0.5, y: 0.98 }, top: { x: 0.5, y: 0.2 } },
  limits: ["Aperçu interne uniquement"], unknownFaces: ["Face arrière non photographiée"],
});
async function prepared() {
  const task = await queuePreparedView(db, "org-1", "product-1", req());
  await runPreparedViewTask(db, task.preparationId);
  return (await listPreparedViews(db, "org-1", "product-1"))[0]!;
}
async function approved() {
  const view = await prepared();
  return reviewPreparedView(db, "org-1", "product-1", view.id, "admin:alice", review(view.revision));
}

beforeEach(() => {
  vi.clearAllMocks();
  stores = new Map(); bytes = new Map();
  vi.stubEnv("ORIENTED_PREPARATION_ENABLED", "true");
  vi.stubEnv("ORIENTED_PREPARATION_ORGANIZATION_IDS", "org-1");
  vi.stubEnv("ORIENTED_PREPARATION_PRODUCT_IDS", "product-1");
  vi.stubEnv("ORIENTED_PREPARATION_MAX_COST_USD", "0.1");
  vi.stubEnv("ORIENTED_PREPARATION_PROVIDER_COST_USD", "0.03");
  product = { id: "product-1", organizationId: "org-1", name: "Vase", description: "", sku: null,
    widthCm: 20, heightCm: 30, depthCm: 20, material: "ceramic", placementType: "table", generationInstructions: "",
    lightingProfile: {}, buyUrl: null, status: "ready", assetId: "photo", views: [], createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01") };
  store("products").rows.push(product as unknown as Record<string, unknown>);
  bytes.set("photo", { asset: { id: "photo", organizationId: "org-1", kind: "product", visibility: "published", contentType: "image/webp" }, buffer: Buffer.from("authentic photo") });
  mocks.findProduct.mockImplementation(async (_db, org, id) => {
    if (org !== product.organizationId || id !== product.id) throw new Error("Produit introuvable");
    return structuredClone(product);
  });
  mocks.readAsset.mockImplementation(async (_db, id) => bytes.get(id) ?? null);
  mocks.storeAsset.mockImplementation(async (_db, input, id) => {
    bytes.set(id, { asset: { id, organizationId: input.organizationId, kind: input.kind,
      contentType: input.contentType, visibility: "private" }, buffer: input.buffer });
    return bytes.get(id)!.asset;
  });
  mocks.prepareViewMatte.mockResolvedValue({ image: Buffer.from("cutout pixels"), alpha: Buffer.from("alpha bytes"),
    widthPx: 100, heightPx: 200, visibleBounds: { x: 0, y: 0, width: 1, height: 1 },
    anchor: { x: 0.5, y: 0.98, confidence: 0.9 }, version: "test-matte-v1" });
  mocks.acquireSlot.mockResolvedValue(vi.fn(async () => undefined));
  mocks.prepareView.mockResolvedValue({ status: "succeeded", estimatedCostUsd: 0.03,
    images: [{ data: Buffer.from("generated view"), mimeType: "image/webp" }], usage: { providerOutcome: "succeeded" } });
});

describe("private prepared-view contracts and admission", () => {
  it("rejects browser-provided approvals and unknown schema versions", async () => {
    expect(prepareViewRequestSchema.safeParse({ ...req(), state: "approved" }).success).toBe(false);
    const view = await prepared();
    expect(preparedProductViewSchema.safeParse({ ...view, schemaVersion: 2 }).success).toBe(false);
    expect(reviewPreparedViewRequestSchema.safeParse({ ...review(2), actorId: "someone", kind: "human" }).success).toBe(false);
  });
  it("keeps candidate private, separate from catalogue photographs, and unavailable before review", async () => {
    const view = await prepared();
    expect(view.state).toBe("needs_review");
    expect(product.views).toEqual([]);
    expect(bytes.get(view.image!.assetId)!.asset.visibility).toBe("private");
    expect(view.orientation.estimated).toBeNull();
    expect(view.physicalHeightSegment).toBeNull();
    await expect(admitPreparedViews(db, "org-1", product)).rejects.toThrow("Aucune vue");
  });
  it("requires human review with every criterion, contact and physical segment passing", async () => {
    const view = await prepared();
    await expect(reviewPreparedView(db, "org-1", product.id, view.id, "agent:qa", review(view.revision), "agent")).rejects.toThrow("humaine");
    await expect(reviewPreparedView(db, "org-1", product.id, view.id, "alice", { ...review(view.revision), physicalHeightSegment: null })).rejects.toThrow("hauteur");
    await expect(reviewPreparedView(db, "org-1", product.id, view.id, "alice", { ...review(view.revision), criteria: { ...review(1).criteria, pattern: "fail" } })).rejects.toThrow("complète");
  });
  it("allows agent observations without disguising them as human approval", async () => {
    const view = await prepared();
    const updated = await reviewPreparedView(db, "org-1", product.id, view.id, "agent:qa", review(view.revision, "needs_review"), "agent");
    expect(updated.review?.kind).toBe("agent");
    await expect(admitPreparedViews(db, "org-1", product)).rejects.toThrow();
  });
  it("preserves product veto at preparation, review, admission and delivery", async () => {
    await approved();
    const [snapshot] = await admitPreparedViews(db, "org-1", product);
    product.visualizationBlockedReason = "Motif commercial non vérifié";
    await expect(queuePreparedView(db, "org-1", product.id, req())).rejects.toThrow("désactivée");
    await expect(admitPreparedViews(db, "org-1", product)).rejects.toThrow("désactivée");
    await expect(assertSnapshotDeliverable(db, snapshot!)).rejects.toThrow("désactivée");
  });
  it("retains prior review evidence when a view is reviewed again", async () => {
    const first = await approved();
    const second = await reviewPreparedView(db, "org-1", product.id, first.id, "admin:bob", review(first.revision));
    expect(second.reviewHistory?.map(r => r.actorId)).toEqual(["admin:alice", "admin:bob"]);
    expect(second.review?.actorId).toBe("admin:bob");
  });
  it("retires generated candidates using the old azimuth prompt convention", async () => {
    const view = await approved();
    await store("prepared_product_views").updateOne({ id: view.id }, { $set: {
      origin: "generated", "versions.prompt": "prepared-view-v1.0.0", "versions.preparation": "prepared-view-v1",
    } });
    const stale = (await listPreparedViews(db, "org-1", product.id))[0]!;
    expect(stale.state).toBe("stale");
    await expect(reviewPreparedView(db, "org-1", product.id, view.id, "alice", review(stale.revision))).rejects.toThrow("obsolète");
    await expect(admitPreparedViews(db, "org-1", product)).rejects.toThrow("Aucune vue");
  });
  it("separates source and dimension fingerprints and requires geometry reapproval", async () => {
    const view = await approved();
    const before = await preparedSources(db, product, null);
    product.heightCm = 40;
    const after = await preparedSources(db, product, null);
    expect(after.sourceFingerprint).toBe(before.sourceFingerprint);
    expect(after.geometryFingerprint).not.toBe(before.geometryFingerprint);
    await expect(admitPreparedViews(db, "org-1", product)).rejects.toThrow("Aucune vue");
    const stale = (await listPreparedViews(db, "org-1", product.id))[0]!;
    expect(stale.state).toBe("stale");
    expect(stale.reviewHistory?.length).toBe(1);
    await reviewPreparedView(db, "org-1", product.id, view.id, "alice", review(stale.revision));
    expect(await admitPreparedViews(db, "org-1", product)).toHaveLength(1);
    expect(mocks.prepareView).not.toHaveBeenCalled();
  });
  it("refuses modified or expired bytes and cross-organization admission", async () => {
    const view = await approved();
    await expect(admitPreparedViews(db, "org-other", product)).rejects.toThrow("introuvable");
    bytes.get(view.alpha!.assetId)!.buffer = Buffer.from("tampered");
    await expect(admitPreparedViews(db, "org-1", product)).rejects.toThrow("a changé");
    await expect(listPreparedViews(db, "org-other", product.id)).rejects.toThrow();
  });
  it("revokes future admissions and identity incidents block admitted deliveries", async () => {
    const view = await approved();
    const [snapshot] = await admitPreparedViews(db, "org-1", product);
    await revokePreparedView(db, "org-1", product.id, view.id, "admin:alice", { expectedRevision: view.revision, reason: "Mauvais motif", kind: "identity_incident" });
    await expect(admitPreparedViews(db, "org-1", product)).rejects.toThrow("Aucune vue");
    await expect(assertSnapshotDeliverable(db, snapshot!)).rejects.toThrow("identité");
    expect(await assetRequiredByPreparedWork(db, view.alpha!.assetId)).toBe(true);
  });
  it("preserves a superseded snapshot and fences both product and view in delivery transaction", async () => {
    const view = await approved();
    const [snapshot] = await admitPreparedViews(db, "org-1", product);
    await revokePreparedView(db, "org-1", product.id, view.id, "alice", { expectedRevision: view.revision, reason: "Nouvelle version", kind: "superseded" });
    await assertSnapshotDeliverable(db, snapshot!, { session: {} as never });
    expect(store("prepared_product_views").rows[0]!.deliveryFence).toBe(1);
    expect(store("products").rows[0]!.orientedDeliveryFence).toBe(1);
    expect((await listPreparedViews(db, "org-1", product.id))[0]).not.toHaveProperty("deliveryFence");
  });
  it("rejects stale concurrent review revisions", async () => {
    const view = await prepared();
    const results = await Promise.allSettled([
      reviewPreparedView(db, "org-1", product.id, view.id, "alice", review(view.revision)),
      reviewPreparedView(db, "org-1", product.id, view.id, "bob", review(view.revision)),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  });
});

describe("durable catalogue preparation", () => {
  it("checks product archive inside the final publication transaction", async () => {
    const task = await queuePreparedView(db, "org-1", product.id, req());
    const matte = await mocks.prepareViewMatte();
    mocks.prepareViewMatte.mockImplementationOnce(async () => { product.status = "archived"; return matte; });
    await runPreparedViewTask(db, task.preparationId);
    expect(store("prepared_view_tasks").rows[0]!.state).toBe("failed");
    expect(store("prepared_product_views").rows[0]!.state).toBe("failed");
    expect(store("prepared_product_views").rows[0]!.image).toBeNull();
  });
  it("recovers admission interrupted after task persistence but before view insertion", async () => {
    const task = await queuePreparedView(db, "org-1", product.id, req());
    store("prepared_product_views").rows.splice(0);
    await runPreparedViewTask(db, task.preparationId);
    expect((await listPreparedViews(db, "org-1", product.id))[0]!.state).toBe("needs_review");
    expect(mocks.prepareView).not.toHaveBeenCalled();
  });
  it("deduplicates simultaneous requests and leases exactly one worker", async () => {
    const [one, two] = await Promise.all([queuePreparedView(db, "org-1", product.id, req("top")), queuePreparedView(db, "org-1", product.id, req("top", "request-key-2"))]);
    expect(one.preparationId).toBe(two.preparationId);
    const results = await Promise.all([runPreparedViewTask(db, one.preparationId), runPreparedViewTask(db, one.preparationId)]);
    expect(results.filter(r => r.processed)).toHaveLength(1);
    expect(mocks.prepareView).toHaveBeenCalledTimes(1);
    expect(store("prepared_view_tasks").rows).toHaveLength(1);
    expect(store("renders").rows).toHaveLength(0);
    expect(store("wallets").rows).toHaveLength(0);
  });
  it("reuses approved prepared views without provider calls or local mask work", async () => {
    const view = await approved();
    const reused = await queuePreparedView(db, "org-1", product.id, req("front", "new-key-123"));
    expect(reused.viewId).toBe(view.id);
    await runPreparedViewTask(db, reused.preparationId);
    expect(mocks.prepareView).not.toHaveBeenCalled();
    expect(mocks.prepareViewMatte).toHaveBeenCalledTimes(1);
  });
  it("rejects reused idempotency keys with a different requested orientation", async () => {
    await queuePreparedView(db, "org-1", product.id, req("front"));
    await expect(queuePreparedView(db, "org-1", product.id, req("top"))).rejects.toThrow("autre préparation");
  });
  it("retains idempotency bindings for alias requests which reuse an existing task", async () => {
    await queuePreparedView(db, "org-1", product.id, req("front", "original-key"));
    await queuePreparedView(db, "org-1", product.id, req("front", "alias-key-1"));
    await expect(queuePreparedView(db, "org-1", product.id, req("top", "alias-key-1"))).rejects.toThrow("autre préparation");
  });
  it("blocks generation before sending when the preparation allowance is missing", async () => {
    vi.stubEnv("ORIENTED_PREPARATION_MAX_COST_USD", "0");
    await expect(queuePreparedView(db, "org-1", product.id, req("top"))).rejects.toThrow("budget");
    expect(mocks.prepareView).not.toHaveBeenCalled();
  });
  it("enforces the preparation budget across separate tasks in the same organization", async () => {
    vi.stubEnv("ORIENTED_PREPARATION_MAX_COST_USD", "0.04");
    const first = await queuePreparedView(db, "org-1", product.id, req("top"));
    await runPreparedViewTask(db, first.preparationId);
    const second = await queuePreparedView(db, "org-1", product.id, req("three_quarter", "request-two"));
    await runPreparedViewTask(db, second.preparationId);
    expect(mocks.prepareView).toHaveBeenCalledTimes(1);
    expect(store("prepared_view_budgets").rows[0]!.accountedUsd).toBe(0.03);
    expect(store("prepared_view_tasks").rows[1]!.failure).toContain("Budget total");
  });
  it("an expired worker cannot overwrite a candidate claimed by a new worker", async () => {
    const task = await queuePreparedView(db, "org-1", product.id, req());
    mocks.prepareViewMatte.mockImplementationOnce(async () => {
      await store("prepared_view_tasks").updateOne({ id: task.preparationId }, { $set: { "lease.token": "new-worker" } });
      await store("prepared_product_views").updateOne({ id: task.viewId }, { $set: { preparationLeaseToken: "new-worker" } });
      throw new Error("Old worker lost its lease");
    });
    await runPreparedViewTask(db, task.preparationId);
    expect(store("prepared_product_views").rows[0]!.state).toBe("preparing");
    expect(store("prepared_view_tasks").rows[0]!.state).toBe("preparing");
  });
  it("an old worker delayed while reading sources cannot steal the current view lease", async () => {
    const task = await queuePreparedView(db, "org-1", product.id, req());
    const read = mocks.readAsset.getMockImplementation()!;
    const matte = await mocks.prepareViewMatte();
    let reachedMatte!: () => void, releaseMatte!: () => void;
    const entered = new Promise<void>(resolve => { reachedMatte = resolve; });
    const resume = new Promise<void>(resolve => { releaseMatte = resolve; });
    let newWorker: ReturnType<typeof runPreparedViewTask> | undefined;
    mocks.prepareViewMatte.mockImplementationOnce(async () => { reachedMatte(); await resume; return matte; });
    let delayed = false;
    mocks.readAsset.mockImplementation(async (database, id) => {
      if (id === "photo" && !delayed) {
        delayed = true;
        await store("prepared_view_tasks").updateOne({ id: task.preparationId }, { $set: { "lease.expiresAt": new Date(0) } });
        newWorker = runPreparedViewTask(db, task.preparationId);
        await entered;
      }
      return read(database, id);
    });
    await runPreparedViewTask(db, task.preparationId);
    const currentTask = await store("prepared_view_tasks").findOne({ id: task.preparationId }) as unknown as PreparedViewTask;
    expect(store("prepared_product_views").rows[0]!.preparationLeaseToken).toBe(currentTask.lease!.token);
    releaseMatte();
    await newWorker;
    expect((await listPreparedViews(db, "org-1", product.id))[0]!.state).toBe("needs_review");
  });
  it("retains unknown provider issue and never replays it after lease expiry", async () => {
    const task = await queuePreparedView(db, "org-1", product.id, req("top"));
    await store("prepared_view_tasks").updateOne({ id: task.preparationId }, { $set: { state: "preparing", "provider.state": "sent", "provider.calls": 1,
      "provider.reservedUsd": 0.03, lease: { token: "dead", expiresAt: new Date(0) } } });
    await runPreparedViewTask(db, task.preparationId);
    expect(store("prepared_view_tasks").rows[0]!.state).toBe("unknown");
    await runPreparedViewTask(db, task.preparationId);
    expect(mocks.prepareView).not.toHaveBeenCalled();
    expect(await assetRequiredByPreparedWork(db, "photo")).toBe(true);
  });
  it("recovers a stored generation after a crash without another paid call", async () => {
    const task = await queuePreparedView(db, "org-1", product.id, req("top"));
    const record = store("prepared_view_tasks").rows[0]!;
    const checkpoint = record.checkpoint as { rawAssetId: string };
    bytes.set(checkpoint.rawAssetId, { asset: { id: checkpoint.rawAssetId, organizationId: "org-1", kind: "product_view", visibility: "private" }, buffer: Buffer.from("paid response") });
    await store("prepared_view_tasks").updateOne({ id: task.preparationId }, { $set: { state: "preparing", "provider.state": "succeeded", "provider.calls": 1, "provider.costUsd": 0.03,
      lease: { token: "dead", expiresAt: new Date(0) } } });
    await runPreparedViewTask(db, task.preparationId);
    const view = (await listPreparedViews(db, "org-1", product.id))[0]!;
    expect(view.state).toBe("needs_review");
    expect(view.origin).toBe("generated");
    expect(view.versions.mask).toBe("test-matte-v1");
    expect(view.preparation.costUsd).toBe(0.03);
    expect(mocks.prepareView).not.toHaveBeenCalled();
    expect(view.image!.sha256).toBe(preparedHash(Buffer.from("cutout pixels")));
  });
  it("recovers a private provider reference using download only", async () => {
    const task = await queuePreparedView(db, "org-1", product.id, req("top"));
    await store("prepared_view_tasks").updateOne({ id: task.preparationId }, { $set: { state: "preparing", "provider.state": "succeeded", "provider.calls": 1, "provider.costUsd": 0.03,
      "provider.observation": { requestId: "received", estimatedCostUsd: 0.03, outcome: "succeeded", outputReference: "https://private.invalid/received" },
      lease: { token: "dead", expiresAt: new Date(0) } } });
    mocks.downloadPreparedResponse.mockResolvedValue({ status: "succeeded", images: [{ data: Buffer.from("downloaded"), mimeType: "image/webp" }] });
    await runPreparedViewTask(db, task.preparationId);
    expect(mocks.downloadPreparedResponse).toHaveBeenCalledTimes(1);
    expect(mocks.prepareView).not.toHaveBeenCalled();
  });
  it("keeps provider spend after a mask failure and does not retry the generation", async () => {
    const task = await queuePreparedView(db, "org-1", product.id, req("top"));
    mocks.prepareViewMatte.mockRejectedValue(new Error("storage temporarily down"));
    await runPreparedViewTask(db, task.preparationId);
    mocks.prepareViewMatte.mockResolvedValueOnce({ image: Buffer.from("cutout pixels"), alpha: Buffer.from("alpha bytes"), widthPx: 100, heightPx: 200,
      visibleBounds: { x: 0, y: 0, width: 1, height: 1 }, anchor: { x: 0.5, y: 0.98, confidence: 0.9 }, version: "test-matte-v1" });
    await runPreparedViewTask(db, task.preparationId);
    expect(mocks.prepareView).toHaveBeenCalledTimes(1);
    expect((await listPreparedViews(db, "org-1", product.id))[0]!.preparation.costUsd).toBe(0.03);
  });
  it("an old worker finishing a slow cutout upload cannot overwrite the current worker's output", async () => {
    const task = await queuePreparedView(db, "org-1", product.id, req());
    const matte = await mocks.prepareViewMatte();
    mocks.prepareViewMatte.mockResolvedValueOnce({ ...matte, image: Buffer.from("old worker pixels") })
      .mockResolvedValueOnce({ ...matte, image: Buffer.from("new worker pixels") });
    const save = mocks.storeAsset.getMockImplementation()!;
    let oldImageId: string | undefined;
    mocks.storeAsset.mockImplementation(async (database, input, id) => {
      if (input.kind === "cutout" && !oldImageId) {
        oldImageId = id;
        await store("prepared_view_tasks").updateOne({ id: task.preparationId }, { $set: { "lease.expiresAt": new Date(0) } });
        await runPreparedViewTask(db, task.preparationId);
      }
      return save(database, input, id);
    });
    await runPreparedViewTask(db, task.preparationId);
    const view = (await listPreparedViews(db, "org-1", product.id))[0]!;
    expect(view.state).toBe("needs_review");
    expect(view.image!.assetId).not.toBe(oldImageId);
    expect(bytes.get(view.image!.assetId)!.buffer).toEqual(Buffer.from("new worker pixels"));
    expect(view.image!.sha256).toBe(preparedHash(bytes.get(view.image!.assetId)!.buffer));
    expect((await store("prepared_view_tasks").findOne({ id: task.preparationId }))!.checkpoint).toMatchObject({ imageAssetId: view.image!.assetId });
    expect(await assetRequiredByPreparedWork(db, oldImageId!)).toBe(true);
  });
  it("an old worker finishing a slow raw upload cannot replace the current raw checkpoint", async () => {
    const task = await queuePreparedView(db, "org-1", product.id, req());
    const save = mocks.storeAsset.getMockImplementation()!;
    let oldRawId: string | undefined;
    mocks.storeAsset.mockImplementation(async (database, input, id) => {
      if (input.kind === "product_view" && !oldRawId) {
        oldRawId = id;
        await store("prepared_view_tasks").updateOne({ id: task.preparationId }, { $set: { "lease.expiresAt": new Date(0) } });
        await runPreparedViewTask(db, task.preparationId);
      }
      return save(database, input, id);
    });
    await runPreparedViewTask(db, task.preparationId);
    const saved = await store("prepared_view_tasks").findOne({ id: task.preparationId }) as unknown as PreparedViewTask;
    expect(saved.state).toBe("needs_review");
    expect(saved.checkpoint.rawAssetId).not.toBe(oldRawId);
    expect(saved.checkpoint.rawSha256).toBe(preparedHash(bytes.get(saved.checkpoint.rawAssetId)!.buffer));
    expect(saved.stagedAssetIds).toContain(oldRawId);
    expect(mocks.prepareView).not.toHaveBeenCalled();
  });
});

describe("explicit matte recovery from a known saved image", () => {
  async function failedMatte(preset = "top") {
    const queued = await queuePreparedView(db, "org-1", product.id, req(preset));
    mocks.prepareViewMatte.mockRejectedValueOnce(new AdminProductError("Détourage incertain", 422));
    await runPreparedViewTask(db, queued.preparationId);
    const task = await store("prepared_view_tasks").findOne({ id: queued.preparationId }) as unknown as PreparedViewTask;
    const view = (await listPreparedViews(db, "org-1", product.id))[0]!;
    expect(task.state).toBe("failed");
    expect(task.failureStage).toBe("matte");
    return { task, view, request: { idempotencyKey: "retry-matte-1", expectedRevision: view.revision,
      expectedProductRevision: product.updatedAt.toISOString() } };
  }
  it("requires a strict request and refuses caller-selected raw assets or provider states", () => {
    expect(retryPreparedViewMatteRequestSchema.safeParse({ idempotencyKey: "retry-key", expectedRevision: 1,
      expectedProductRevision: product.updatedAt.toISOString(), rawAssetId: "untrusted" }).success).toBe(false);
  });
  it("retries a terminal matte refusal after configuration changes while preserving image cost, raw bytes and provenance", async () => {
    const { task, view, request } = await failedMatte();
    const providerBefore = structuredClone(task.provider);
    const ledgerBefore = structuredClone(store("prepared_view_budgets").rows);
    const originalMattingUrl = serverConfig.mattingUrl;
    serverConfig.mattingUrl = "http://127.0.0.1:9876";
    try {
      expect(await preparedMatteRetryAvailability(db, task)).toEqual({ eligible: true, reason: null });
      expect(await assetRequiredByPreparedWork(db, task.checkpoint.rawAssetId)).toBe(true);
      const queued = await retryPreparedViewMatte(db, "org-1", product.id, view.id, "admin:alice", request);
      expect(queued).toMatchObject({ preparationId: task.id, viewId: view.id, state: "queued", reused: false, providerOutcome: "succeeded" });
      const retryTask = await store("prepared_view_tasks").findOne({ id: task.id });
      expect(retryTask!.provider).toEqual(providerBefore);
      expect(retryTask!.configurationFingerprint).not.toBe(task.configurationFingerprint);
      expect(retryTask!.matteRetries).toEqual([expect.objectContaining({ actorId: "admin:alice", previousFailure: "Détourage incertain",
        previousConfigurationFingerprint: task.configurationFingerprint, requestedMaskVersion: "test-matte-v1" })]);
      mocks.prepareViewMatte.mockResolvedValueOnce({ image: Buffer.from("recovered cutout"), alpha: Buffer.from("recovered alpha"),
        widthPx: 100, heightPx: 200, visibleBounds: { x: 0, y: 0, width: 1, height: 1 },
        anchor: { x: 0.5, y: 0.98, confidence: 0.9 }, version: "test-matte-v2/model-frozen" });
      await runPreparedViewTask(db, task.id);
      const recovered = (await listPreparedViews(db, "org-1", product.id))[0]!;
      expect(recovered).toMatchObject({ state: "needs_review", revision: view.revision + 2,
        preparation: { taskId: task.id, costUsd: 0.03 }, versions: { mask: "test-matte-v2/model-frozen" } });
      expect(recovered.versions.prompt).toBe(view.versions.prompt);
      expect(recovered.origin).toBe("generated");
      expect(recovered.review).toBeNull();
      expect(mocks.prepareView).toHaveBeenCalledTimes(1);
      expect(mocks.downloadPreparedResponse).not.toHaveBeenCalled();
      expect(store("prepared_view_budgets").rows).toEqual(ledgerBefore);
      expect(bytes.get(task.checkpoint.rawAssetId)!.buffer).toEqual(Buffer.from("generated view"));
      expect(await retryPreparedViewMatte(db, "org-1", product.id, view.id, "admin:alice", request)).toMatchObject({ state: "needs_review", reused: true });
    } finally { serverConfig.mattingUrl = originalMattingUrl; }
  });
  it("also resumes photographed sources without image-provider work", async () => {
    const { task, view, request } = await failedMatte("front");
    await retryPreparedViewMatte(db, "org-1", product.id, view.id, "admin:alice", request);
    await runPreparedViewTask(db, task.id);
    expect((await listPreparedViews(db, "org-1", product.id))[0]!.state).toBe("needs_review");
    expect(mocks.prepareView).not.toHaveBeenCalled();
    expect(mocks.downloadPreparedResponse).not.toHaveBeenCalled();
    expect(store("prepared_view_budgets").rows).toHaveLength(0);
  });
  it("deduplicates retries, checks revision and never requeues an accepted request", async () => {
    const { task, view, request } = await failedMatte();
    const attempts = await Promise.allSettled([
      retryPreparedViewMatte(db, "org-1", product.id, view.id, "admin:alice", request),
      retryPreparedViewMatte(db, "org-1", product.id, view.id, "admin:bob", { ...request, idempotencyKey: "retry-matte-2" }),
    ]);
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect((await store("prepared_view_tasks").findOne({ id: task.id }))!.matteRetries).toHaveLength(1);
    expect(await retryPreparedViewMatte(db, "org-1", product.id, view.id, "admin:alice", request)).toMatchObject({ reused: true });
    await expect(retryPreparedViewMatte(db, "org-1", product.id, view.id, "admin:alice", { ...request, expectedRevision: request.expectedRevision + 1 })).rejects.toThrow("autre reprise");
    expect(mocks.prepareView).toHaveBeenCalledTimes(1);
  });
  it("refuses unknown image outcomes, old failures without stage evidence, changed sources and cross-organization access", async () => {
    const { task, view, request } = await failedMatte();
    await expect(retryPreparedViewMatte(db, "org-other", product.id, view.id, "admin:alice", request)).rejects.toThrow("introuvable");
    await store("prepared_view_tasks").updateOne({ id: task.id }, { $set: { "provider.state": "unknown" } });
    await expect(retryPreparedViewMatte(db, "org-1", product.id, view.id, "admin:alice", request)).rejects.toThrow("issue fournisseur");
    await store("prepared_view_tasks").updateOne({ id: task.id }, { $set: { "provider.state": "succeeded" }, $unset: { failureStage: "" } });
    await expect(retryPreparedViewMatte(db, "org-1", product.id, view.id, "admin:alice", request)).rejects.toThrow("identifié");
    await store("prepared_view_tasks").updateOne({ id: task.id }, { $set: { failureStage: "matte" } });
    bytes.get("photo")!.buffer = Buffer.from("changed photo");
    await expect(retryPreparedViewMatte(db, "org-1", product.id, view.id, "admin:alice", request)).rejects.toThrow("photographies");
  });
  it.each(["missing", "modified", "expired", "foreign"])("refuses %s raw evidence before enqueueing", async defect => {
    const { task, view, request } = await failedMatte();
    const raw = bytes.get(task.checkpoint.rawAssetId)!;
    if (defect === "missing") bytes.delete(task.checkpoint.rawAssetId);
    if (defect === "modified") raw.buffer = Buffer.from("changed");
    if (defect === "expired") raw.asset.expiresAt = new Date(0);
    if (defect === "foreign") raw.asset.organizationId = "org-other";
    expect((await preparedMatteRetryAvailability(db, task)).eligible).toBe(false);
    await expect(retryPreparedViewMatte(db, "org-1", product.id, view.id, "admin:alice", request)).rejects.toThrow("image brute");
    expect((await store("prepared_view_tasks").findOne({ id: task.id }))!.state).toBe("failed");
    expect(mocks.prepareView).toHaveBeenCalledTimes(1);
  });
  it("fails safely when saved bytes disappear between retry admission and worker execution", async () => {
    const { task, view, request } = await failedMatte();
    await retryPreparedViewMatte(db, "org-1", product.id, view.id, "admin:alice", request);
    bytes.delete(task.checkpoint.rawAssetId);
    await runPreparedViewTask(db, task.id);
    expect((await store("prepared_view_tasks").findOne({ id: task.id }))!.state).toBe("failed");
    expect(mocks.prepareView).toHaveBeenCalledTimes(1);
    expect(mocks.downloadPreparedResponse).not.toHaveBeenCalled();
    expect(mocks.prepareViewMatte).toHaveBeenCalledTimes(1);
  });
  it("releases a failed matte raw pin when its product is retired", async () => {
    const { task, view, request } = await failedMatte();
    expect(await assetRequiredByPreparedWork(db, task.checkpoint.rawAssetId)).toBe(true);
    await retirePreparedProduct(db, "org-1", product.id, new Date(Date.now() + 60_000));
    expect(await assetRequiredByPreparedWork(db, task.checkpoint.rawAssetId)).toBe(false);
    expect(await assetRequiredByPreparedWork(db, task.sourceAssetId)).toBe(false);
    await expect(retryPreparedViewMatte(db, "org-1", product.id, view.id, "admin:alice", request)).rejects.toThrow("retirée");
  });
});
