import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { MongoClient, type Db } from "mongodb";
import sharp from "sharp";
vi.mock("server-only", () => ({}));
import { durableContext } from "../lib/server/durable-context";
import {
  assertDurableDatabase,
  claimRender,
  completeDurableRender,
  endDurableRender,
  prepareExecution,
  reserveDurableCredit,
  validateExecutionSources,
  workerFingerprint,
} from "../lib/server/durable-queue";
import { durableStep } from "../lib/server/durable-steps";
import { measureProviderCall, recordProviderUsage, renderUsageTotals, assertRenderBudget, RenderBudgetError } from "../lib/server/provider-usage";
import { reviewVisualRender } from "../lib/server/ai/visual-review";
import { SPATIAL_REVIEW_EXECUTION_POLICY as reviewPolicy } from "../lib/server/spatial-review-policy";
import { collections } from "../lib/server/mongodb";
import { storeAsset } from "../lib/server/assets";
import { createRender } from "../lib/server/rendering";
import { buildRetryInput } from "../lib/server/render-request";
import { serverConfig } from "../lib/server/config";
import { runWorkerOnce } from "../lib/server/render-worker";
import { releaseStaleHolds } from "../lib/server/credits";
import { cachedSpatialRoom, SpatialCacheBusyError } from "../lib/server/spatial-scene-cache";
import { globalRoom } from "./fixtures/spatial-room";
import { cachedSourceReview, SourceReviewBusyError } from "../lib/server/spatial-source-review";
import { savePlanarTexture, readVerifiedPlanarTexture } from "../lib/server/planar-texture";
import type { ProductDocument, RenderDocument, SceneDocument } from "../lib/server/types";

const uri = process.env.DURABLE_TEST_MONGODB_URI;
describe.skipIf(!uri)("real MongoDB replica-set invariants", () => {
  let client: MongoClient;
  let db: Db;
  let render: RenderDocument;
  let resultAssetId: string;
  const originalConfig = { ...serverConfig };
  it("persists texture corners and rejects a stale editor on real MongoDB", async () => {
    const image = await sharp({create:{width:300,height:400,channels:3,background:"red"}}).png().toBuffer();
    const asset = await storeAsset(db,{organizationId:"org",kind:"product",visibility:"organization",buffer:image,contentType:"image/png"});
    const product = {id:crypto.randomUUID(),organizationId:"org",objectType:"rug",placementType:"floor",widthCm:80,heightCm:1,depthCm:100,assetId:asset.id,updatedAt:new Date(1)} as ProductDocument;
    await collections(db).products.insertOne(product);
    const input={assetId:asset.id,corners:[{x:.1,y:.1},{x:.9,y:.1},{x:.9,y:.9},{x:.1,y:.9}]};
    const saved=await savePlanarTexture(db,product,input);
    expect((await readVerifiedPlanarTexture(db,saved)).buffer).toEqual(image);
    await expect(savePlanarTexture(db,product,input)).rejects.toThrow(/fiche a changé/);
    expect((await collections(db).products.findOne({id:product.id}))!.planarTexture).toEqual(saved.planarTexture);
  });
  it("shares source diagnostics between clients and retains a rejection", async () => {
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const input = { organizationId: "org", productFingerprint: crypto.randomUUID(), references: [{ view: "catalog", data: Buffer.from("source") }], expiresAt: new Date(Date.now() + 60000), model: "test" };
    const value = { references: [{ index: 0, sameProduct: true, singleUnambiguousProduct: true, readable: true, completeSilhouette: false, confidence: .9, reason: "Produit coupé" }] };
    const load = vi.fn(async () => { started(); await hold; return { value, durationMs: 1 }; });
    const owner = cachedSourceReview(db, input, load);
    await ready;
    try { await expect(cachedSourceReview(db, input, load)).rejects.toBeInstanceOf(SourceReviewBusyError); }
    finally { release(); }
    await owner;
    expect(await cachedSourceReview(db, input, load)).toEqual(value);
    expect(load).toHaveBeenCalledOnce();
  });
  it("shares a single room analysis across concurrent MongoDB clients", async () => {
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const input = { organizationId: "org", assetId: crypto.randomUUID(), room: Buffer.from("room"), expiresAt: new Date(Date.now() + 60000), model: "test" };
    const load = vi.fn(async () => { started(); await hold; return { value: globalRoom, usage: undefined, durationMs: 1 }; });
    const owner = cachedSpatialRoom(db, input, load);
    await ready;
    const others = await Promise.allSettled(Array.from({ length: 5 }, () => cachedSpatialRoom(db, input, load)));
    expect(others.every(result => result.status === "rejected" && result.reason instanceof SpatialCacheBusyError)).toBe(true);
    release();
    await owner;
    expect((await cachedSpatialRoom(db, input, load)).cached).toBe(true);
    expect(load).toHaveBeenCalledOnce();
  });
  afterEach(() => {
    Object.assign(serverConfig, originalConfig);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  beforeAll(async () => {
    client = await new MongoClient(uri!).connect();
    db = client.db(
      `lili_durable_test_${crypto.randomUUID().replaceAll("-", "")}`,
    );
    await db
      .collection("render_dispatch")
      .createIndex({ key: 1 }, { unique: true });
    await collections(db).creditTransactions.createIndex(
      { organizationId: 1, idempotencyKey: 1 },
      { unique: true },
    );
    // Same admission uniqueness constraint installed by database() in production.
    await collections(db).renders.createIndex(
      { organizationId: 1, idempotencyKey: 1 },
      { unique: true },
    );
    await assertDurableDatabase(db);
  });
  afterAll(async () => {
    if (db) await db.dropDatabase();
    if (client) await client.close();
  });
  beforeEach(async () => {
    for (const name of [
      "renders",
      "render_attempts",
      "wallets",
      "credit_transactions",
      "assets",
      "scenes",
    ])
      await db.collection(name).deleteMany({});
    const scene = {
      id: "scene",
      organizationId: "org",
      assetId: "scene-photo",
      status: "uploaded",
      expiresAt: new Date(Date.now() + 3600_000),
    } as SceneDocument;
    await collections(db).scenes.insertOne(scene);
    const image = await sharp({
      create: { width: 4, height: 4, channels: 4, background: "red" },
    })
      .png()
      .toBuffer();
    const asset = await storeAsset(db, {
      organizationId: "org",
      kind: "render",
      visibility: "organization",
      buffer: image,
      contentType: "image/png",
      expiresAt: scene.expiresAt,
    });
    resultAssetId = asset.id;
    render = {
      id: "r",
      organizationId: "org",
      sceneId: "scene",
      status: "queued",
      execution: prepareExecution(scene, []),
      createdAt: new Date(),
    } as RenderDocument;
    await collections(db).renders.insertOne(render);
    await collections(db).wallets.insertOne({
      organizationId: "org",
      balance: 10,
      reserved: 0,
      holds: [],
      processedKeys: [],
      updatedAt: new Date(),
    });
  });
  const withClaim = async (
    work: (claimed: RenderDocument) => Promise<void>,
  ) => {
    const claimed = await claimRender(db, "integration");
    expect(claimed).not.toBeNull();
    await durableContext.run(
      { render: claimed!, token: claimed!.execution!.token! },
      () => work(claimed!),
    );
  };
  it("recovers disjoint accounting writes from MongoDB after changing clients", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const faulty = (name: string, method: string) => new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "collection") return Reflect.get(target, property, receiver);
        return (collectionName: string) => new Proxy(target.collection(collectionName), {
          get(collection, key) {
            if (collectionName === name && key === method)
              return async () => { throw new Error("Injected accounting write failure"); };
            const value = Reflect.get(collection, key);
            return typeof value === "function" ? value.bind(collection) : value;
          },
        });
      },
    });
    const descriptor = { step: "spatial-generation", provider: "openai", model: "test", outcome: "succeeded" as const, estimatedCostUsd: 0.12, latencyMs: 1 };
    try {
      await recordProviderUsage(faulty("render_attempts", "insertOne"), render, descriptor);
      await recordProviderUsage(faulty("renders", "updateOne"), render, descriptor);
      await recordProviderUsage(db, render, descriptor);
      const otherClient = await new MongoClient(uri!).connect();
      try {
        const otherDb = otherClient.db(db.databaseName);
        expect(await renderUsageTotals(otherDb, render.id)).toEqual({ calls: 3, estimatedCostUsd: 0.36, unknownOutcomeCalls: 0 });
        vi.stubEnv("RENDER_MAX_COST_USD", "0.4");
        await expect(assertRenderBudget(otherDb, render.id, 0.12)).rejects.toBeInstanceOf(RenderBudgetError);
        expect((await collections(otherDb).renders.findOne({ id: render.id }))!.usageCallIds).toHaveLength(2);
        expect(await collections(otherDb).renderAttempts.countDocuments({ renderId: render.id })).toBe(2);
      } finally { await otherClient.close(); }
    } finally { warn.mockRestore(); }
  });
  it.each(["unavailable", "malformed"] as const)(
    "persists v11 review exhaustion across MongoDB leases (%s)",
    async (scenario) => {
      Object.assign(serverConfig, { aiMockMode: false, openaiApiKey: "fake-test-only", openaiMaxCostUsd: 20 });
      await collections(db).renders.updateOne({ id: "r" }, {
        $set: { "execution.configFingerprint": workerFingerprint() },
      });
      const fetchMock = vi.fn(async () => scenario === "unavailable"
        ? new Response("offline", { status: 503 }) : new Response("not json"));
      vi.stubGlobal("fetch", fetchMock);
      const stage = `spatial-review-test-${scenario}`;
      const image = { data: new Uint8Array([1, 2, 3]), mimeType: "image/png" as const };
      const check = (claimed: RenderDocument) => measureProviderCall(db, claimed, {
        step: stage, provider: "openai", model: "test", estimatedCostUsd: 0.03,
      }, () => reviewVisualRender({
        room: image, composition: image, generated: image,
        products: [{ id: "product", name: "Chair", image }], replacement: false,
        deadlineMs: claimed.execution!.deadlineAt.getTime(), executionPolicy: reviewPolicy.version,
      }), reviewPolicy.retry);
      await withClaim(async (claimed) => {
        await reserveDurableCredit(db, claimed);
        await expect(check(claimed)).rejects.toMatchObject({
          code: scenario === "unavailable" ? "retry" : "permanent",
        });
      });
      await collections(db).renders.updateOne({ id: "r" }, {
        $set: { "execution.leaseUntil": new Date(0) },
      });
      await withClaim(async (claimed) => {
        await reserveDurableCredit(db, claimed);
        await expect(check(claimed)).rejects.toMatchObject({ code: "permanent" });
        await expect(check(claimed)).rejects.toMatchObject({ code: "permanent" });
        await endDurableRender(db, claimed, "failed", "Review unavailable", "permanent", true);
      });
      const attempts = scenario === "unavailable" ? 2 : 1;
      expect(fetchMock).toHaveBeenCalledTimes(attempts);
      const saved = (await collections(db).renders.findOne({ id: "r" }))!;
      expect(saved.status).toBe("failed");
      expect(saved.resultAssetId).toBeUndefined();
      expect(saved.execution!.steps[`${stage}-1`]).toMatchObject({ status: "failed", attempts });
      const usage = await collections(db).renderAttempts.find({ renderId: "r", stage }).toArray();
      expect(usage).toHaveLength(attempts);
      expect(usage.every(row => row.usageOutcome === "unknown" && row.estimatedCostUsd === 0.03)).toBe(true);
      expect(await collections(db).wallets.findOne({ organizationId: "org" }))
        .toMatchObject({ balance: 10, reserved: 0 });
    },
  );
  const accepted = () => ({
    resultAssetId,
    qualityDecision: {
      version: "test",
      status: "simulated" as const,
      score: null,
      feedback: "Simulation",
      checks: [],
    },
  });

  it("eight competing dispatchers claim the job exactly once", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => claimRender(db, `worker-${i}`)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });
  it("freezes spatial admission and product dimensions without spending or requiring a cutout", async () => {
    vi.stubEnv("RENDER_EXECUTION_MODE", "durable");
    Object.assign(serverConfig, { spatialAdmissionMode: "internal-all", spatialOrganizationIds: ["org"], aiMockMode: false, openAIImageEnabled: true, openaiApiKey: "unused-test-key" });
    const productId = crypto.randomUUID();
    await collections(db).products.insertOne({ id: productId, organizationId: "org", assetId: resultAssetId, name: "Chair", objectType: "furniture", placementType: "floor", widthCm: 42, heightCm: 80, depthCm: 45, views: [] } as unknown as ProductDocument);
    await collections(db).scenes.updateOne({ id: "scene" }, { $set: { assetId: resultAssetId, widthPx: 600, heightPx: 400 } });
    const input = { engine: "spatial" as const, placement: { sceneId: "scene", productId, surfaceType: "floor" }, placementPoint: { x: 0.5, y: 0.8 }, idempotencyKey: "spatial-admission" };
    const admissions = await Promise.all(Array.from({ length: 8 }, () => createRender(db, "org", input)));
    const admitted = admissions[0]!;
    expect(new Set(admissions.map(item => item.id)).size).toBe(1);
    expect(await collections(db).renders.countDocuments({ organizationId: "org", idempotencyKey: input.idempotencyKey })).toBe(1);
    expect(await collections(db).renderAttempts.countDocuments({ renderId: admitted.id })).toBe(0);
    expect(admitted.status).toBe("queued"); expect(admitted.engine).toBe("spatial");
    const source = await collections(db).renders.findOne({ id: admitted.id });
    const retryKey = `retry:${admitted.id}:${crypto.randomUUID()}`;
    const retries = await Promise.all(Array.from({ length: 8 }, () => createRender(db, "org", buildRetryInput(source!, retryKey))));
    expect(new Set(retries.map(item => item.id)).size).toBe(1);
    expect(retries[0]!.id).not.toBe(admitted.id);
    expect(await collections(db).renders.countDocuments({ organizationId: "org", idempotencyKey: retryKey })).toBe(1);
    expect(await collections(db).renderAttempts.countDocuments({ renderId: retries[0]!.id })).toBe(0);
    await collections(db).products.updateOne({ id: productId }, { $set: { heightCm: 8 } });
    serverConfig.spatialOrganizationIds = [];
    const duplicate = await createRender(db, "org", input);
    expect(duplicate.id).toBe(admitted.id);
    const saved = await collections(db).renders.findOne({ id: admitted.id });
    expect(saved!.execution!.products[0]!.heightCm).toBe(80);
    expect(saved!.engineVersions!.prompt).toBe("spatial-v11");
    expect(saved!.engineVersions!.visionCostPolicy).toBe("astra-token-allowance-v1");
    expect(saved!.requestSnapshot!.input.engine).toBe("spatial");
    await expect(createRender(db, "org", { ...input, idempotencyKey: "after-disabled" })).rejects.toThrow(/internes/);
    expect((await collections(db).wallets.findOne({ organizationId: "org" }))!.balance).toBe(10);
  });
  it("freezes the selected rug texture and retains its source asset in a v10 admission", async () => {
    vi.stubEnv("RENDER_EXECUTION_MODE", "durable");
    Object.assign(serverConfig, { spatialAdmissionMode: "internal-all", spatialOrganizationIds: ["org"], aiMockMode: false, openAIImageEnabled: true, openaiApiKey: "unused-test-key" });
    const productId = crypto.randomUUID();
    const planarTexture = {
      version: 1 as const, assetId: resultAssetId, fingerprint: "a".repeat(64),
      widthPx: 600, heightPx: 400, productWidthCm: 120, productDepthCm: 160,
      confirmedAt: new Date().toISOString(),
      corners: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
    };
    await collections(db).products.insertOne({ id: productId, organizationId: "org", assetId: resultAssetId, name: "Rug", objectType: "rug", placementType: "floor", widthCm: 120, heightCm: 1, depthCm: 160, views: [], planarTexture } as unknown as ProductDocument);
    await collections(db).scenes.updateOne({ id: "scene" }, { $set: { assetId: resultAssetId, widthPx: 600, heightPx: 400 } });
    const admitted = await createRender(db, "org", { engine: "spatial", placement: { sceneId: "scene", productId, surfaceType: "floor" }, placementPoint: { x: 0.5, y: 0.8 }, idempotencyKey: "rug-admission" });
    await collections(db).products.updateOne({ id: productId }, { $unset: { planarTexture: "" }, $set: { widthCm: 130 } });
    const saved = await collections(db).renders.findOne({ id: admitted.id });
    expect(saved!.engineVersions!.prompt).toBe("spatial-v11");
    expect(saved!.execution!.products[0]!.planarTexture).toEqual(planarTexture);
    expect(saved!.execution!.products[0]!.widthCm).toBe(120);
    expect(saved!.execution!.sourceAssetIds).toContain(resultAssetId);
    expect((await collections(db).wallets.findOne({ organizationId: "org" }))!.balance).toBe(10);
  });
  it("freezes a restricted solid-base admission and its repair contract without spending", async () => {
    vi.stubEnv("RENDER_EXECUTION_MODE", "durable");
    Object.assign(serverConfig, { spatialAdmissionMode: "solid-base-only", spatialOrganizationIds: ["org"], aiMockMode: false, openAIImageEnabled: true, openaiApiKey: "unused-test-key", mattingUrl: "https://matting.example.test", mattingToken: "unused-local-only", mattingTimeoutMs: 60000 });
    const network = vi.fn(() => { throw new Error("Admission must not call a provider"); });
    vi.stubGlobal("fetch", network);
    const productId = crypto.randomUUID();
    await collections(db).products.insertOne({ id: productId, organizationId: "org", assetId: resultAssetId, name: "Basket", objectType: "other", placementType: "floor", widthCm: 32, heightCm: 32, depthCm: 33, views: [] } as unknown as ProductDocument);
    await collections(db).scenes.updateOne({ id: "scene" }, { $set: { assetId: resultAssetId, widthPx: 600, heightPx: 400 } });
    const input = { engine: "spatial" as const, placement: { sceneId: "scene", productId, surfaceType: "floor" }, placementPoint: { x: 0.5, y: 0.8 }, idempotencyKey: "restricted-admission" };
    await expect(createRender(db, "org", input)).rejects.toThrow(/uniquement les paniers/);
    const spatialMetadata = { measurementConvention: "Dimensions extérieures", dimensionSource: "catalog" as const, supports: ["floor" as const], characteristicParts: ["complete rim"], contactProfile: "solid-base" as const, volumeFamily: "basket" as const };
    await collections(db).products.updateOne({ id: productId }, { $set: { spatialMetadata } });
    const admitted = await createRender(db, "org", input);
    await collections(db).products.updateOne({ id: productId }, { $unset: { spatialMetadata: "" } });
    serverConfig.spatialOrganizationIds = [];
    const duplicate = await createRender(db, "org", input);
    expect(duplicate.id).toBe(admitted.id);
    const saved = await collections(db).renders.findOne({ id: admitted.id });
    expect(saved!.engineVersions).toMatchObject({ prompt: "spatial-v13", volumeIntegrationPolicy: "spatial-volume-local-matte-v1", volumeRepairPolicy: "spatial-volume-numeric-repair-v1" });
    expect(saved!.execution!.products[0]!.spatialMetadata).toEqual(spatialMetadata);
    expect(await collections(db).renderAttempts.countDocuments({ renderId: admitted.id })).toBe(0);
    expect(network).not.toHaveBeenCalled();
    expect((await collections(db).wallets.findOne({ organizationId: "org" }))!.balance).toBe(10);
  });
  it("cancel and completion racing yield either one debit or one refund", async () => {
    await withClaim(async (claimed) => {
      await reserveDurableCredit(db, claimed);
      await Promise.allSettled([
        completeDurableRender(db, claimed, accepted()),
        endDurableRender(db, claimed, "cancelled"),
      ]);
    });
    const final = await collections(db).renders.findOne({ id: "r" });
    const wallet = await collections(db).wallets.findOne({
      organizationId: "org",
    });
    expect(["cancelled", "succeeded"]).toContain(final!.status);
    expect(wallet!.balance).toBe(final!.status === "succeeded" ? 9 : 10);
    expect(wallet!.reserved).toBe(0);
    expect(
      await collections(db).creditTransactions.countDocuments({
        organizationId: "org",
      }),
    ).toBe(1);
  });
  it("transaction rollback prevents success when the result expired", async () => {
    await withClaim(async (claimed) => {
      await reserveDurableCredit(db, claimed);
      await collections(db).assets.updateOne(
        { id: resultAssetId },
        { $set: { expiresAt: new Date(0) } },
      );
      await expect(
        completeDurableRender(db, claimed, accepted()),
      ).rejects.toThrow(/expiré/);
      expect((await collections(db).renders.findOne({ id: "r" }))!.status).toBe(
        "processing",
      );
      expect(
        (await collections(db).wallets.findOne({ organizationId: "org" }))!
          .reserved,
      ).toBe(1);
    });
  });

  it("a reclaimed lease cannot deliver from its old worker", async () => {
    const first = (await claimRender(db, "old-worker"))!;
    await durableContext.run(
      { render: first, token: first.execution!.token! },
      () => reserveDurableCredit(db, first),
    );
    await collections(db).renders.updateOne(
      { id: first.id },
      { $set: { "execution.leaseUntil": new Date(0) } },
    );
    const second = (await claimRender(db, "new-worker"))!;
    await expect(
      durableContext.run(
        { render: first, token: first.execution!.token! },
        () => completeDurableRender(db, first, accepted()),
      ),
    ).rejects.toThrow(/bail/);
    await durableContext.run(
      { render: second, token: second.execution!.token! },
      () => completeDurableRender(db, second, accepted()),
    );
    expect(
      (await collections(db).wallets.findOne({ organizationId: "org" }))!
        .balance,
    ).toBe(9);
    expect(
      await collections(db).creditTransactions.countDocuments({
        organizationId: "org",
      }),
    ).toBe(1);
  });

  it("the legacy credit sweep does not refund an active durable hold", async () => {
    await withClaim(async (claimed) => {
      await reserveDurableCredit(db, claimed);
      await collections(db).wallets.updateOne(
        { organizationId: "org" },
        { $set: { "holds.0.reservedAt": new Date(Date.now() - 1800_000) } },
      );
      expect(await releaseStaleHolds(db)).toBe(0);
      expect(
        (await collections(db).wallets.findOne({ organizationId: "org" }))!
          .reserved,
      ).toBe(1);
    });
  });
  it.each(["maskRaw", "mask"] as const)(
    "restores lossless RGBA %s from private checkpoints",
    async (maskKey) => {
      await withClaim(async () => {
        const raw = Buffer.from([
          1, 2, 3, 0, 8, 9, 10, 128, 4, 5, 6, 255, 11, 12, 13, 255,
        ]);
        const create = vi
          .fn<
            () => Promise<{
              sceneWidth: number;
              sceneHeight: number;
              maskRaw?: Buffer;
              mask?: Buffer;
            }>
          >()
          .mockResolvedValue({ sceneWidth: 2, sceneHeight: 2, [maskKey]: raw });
        await durableStep(db, "composition", "analysis", create);
        const restored = await durableStep(
          db,
          "composition",
          "analysis",
          create,
        );
        expect(restored[maskKey]).toEqual(raw);
        expect(create).toHaveBeenCalledTimes(1);
      });
    },
  );
  it("refuses cross-session source images even inside the same shop", async () => {
    await collections(db).assets.insertOne({
      id: "scene-photo",
      organizationId: "org",
      kind: "scene",
      visibility: "private",
      ownerSessionId: "other-session",
      contentType: "image/png",
      size: 1,
      createdAt: new Date(),
    });
    await collections(db).scenes.updateOne(
      { id: "scene" },
      { $set: { publicSessionId: "visitor" } },
    );
    await expect(
      validateExecutionSources(db, { ...render, publicSessionId: "visitor" }),
    ).rejects.toThrow(/inaccessible/);
  });
  async function seedPipeline() {
    await collections(db).renders.deleteMany({});
    const expiresAt = new Date(Date.now() + 3600_000);
    const room = await sharp({
      create: { width: 400, height: 300, channels: 3, background: "#aabbaa" },
    })
      .webp({ lossless: true })
      .toBuffer();
    const product = await sharp({
      create: { width: 30, height: 60, channels: 4, background: "#cc4422" },
    })
      .png()
      .toBuffer();
    for (const [id, buffer, kind, contentType] of [
      ["scene-photo", room, "scene", "image/webp"],
      ["product-photo", product, "product", "image/png"],
      ["cutout", product, "cutout", "image/png"],
    ] as const)
      await storeAsset(
        db,
        {
          organizationId: "org",
          visibility: "organization",
          kind,
          buffer,
          contentType,
          expiresAt,
        },
        id,
      );
    await collections(db).scenes.updateOne(
      { id: "scene" },
      { $set: { widthPx: 400, heightPx: 300, analysis: {}, expiresAt } },
    );
    await db.collection("products").updateOne(
      { id: "p", organizationId: "org" },
      {
        $set: {
          id: "p",
          organizationId: "org",
          name: "Fixture",
          description: "Synthetic test",
          objectType: "vase",
          widthCm: 10,
          heightCm: 20,
          depthCm: 10,
          assetId: "product-photo",
          cutoutAssetId: "cutout",
          cutout: {
            source: "heuristic",
            synthetic: false,
            cutoutVersion: "test",
            widthPx: 30,
            heightPx: 60,
            warnings: [],
            baseRowFraction: 1,
          },
        },
      },
      { upsert: true },
    );
  }

  it.each(["simple_point", "standard"] as const)(
    "runs the simulated %s pipeline beyond five minutes with frozen sources",
    async (workflow) => {
      await seedPipeline();
      vi.stubEnv("RENDER_EXECUTION_MODE", "durable");
      try {
        const scheduleWake = vi.fn();
        const result = await createRender(
          db,
          "org",
          {
            workflow,
            idempotencyKey: "durable-full",
            placement: {
              sceneId: "scene",
              productId: "p",
              xNormalized: 0.5,
              yNormalized: 0.8,
              scale: 0.2,
              surfaceType: "table",
            },
            simplePlacements: [
              {
                productId: "p",
                placementPoint: { x: 0.5, y: 0.8 },
                dimensionPair: {
                  mode: "height_length",
                  heightCm: 20,
                  lengthCm: 10,
                },
                pixelsPerCm: 2,
                placementKind: "standing",
              },
            ],
          },
          undefined,
          scheduleWake,
        );
        expect(result.status).toBe("queued");
        expect(scheduleWake).toHaveBeenCalledOnce();
        expect(scheduleWake).toHaveBeenCalledWith(expect.any(Function));
        expect(
          await collections(db).renders.findOne({ id: result.id }),
        ).toMatchObject({
          status: "queued",
          creditCharged: false,
        });
        // Change the catalogue after admission. The worker must retain the frozen dimensions.
        await db
          .collection("products")
          .updateOne(
            { id: "p" },
            { $set: { heightCm: 9999, cutoutAssetId: "missing" } },
          );
        await collections(db).renders.updateOne(
          { id: result.id },
          { $set: { createdAt: new Date(Date.now() - 360_000) } },
        );
        expect(await runWorkerOnce(db, "full-pipeline")).toBe(true);
        const final = await collections(db).renders.findOne({ id: result.id });
        expect(
          final?.status,
          JSON.stringify({
            error: final?.error,
            execution: final?.execution?.lastError,
          }),
        ).toBe("succeeded");
        expect(final!.qualityDecision?.status).toBe("simulated");
        expect(final!.execution!.products[0]!.heightCm).toBe(20);
        expect(final!.latencyMs).toBeGreaterThan(300_000);
        expect(
          (await collections(db).wallets.findOne({ organizationId: "org" }))!
            .balance,
        ).toBe(9);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
  const standardInput = () => ({
    workflow: "standard" as const,
    idempotencyKey: crypto.randomUUID(),
    placement: {
      sceneId: "scene",
      productId: "p",
      xNormalized: 0.5,
      yNormalized: 0.8,
      scale: 0.2,
      surfaceType: "table",
    },
  });
  const goodReview = {
    accepted: true,
    score: 0.99,
    replacementComplete: true,
    scaleAndPerspectivePlausible: true,
    scaleCorrectionFactor: 1,
    photorealistic: true,
    duplicateProduct: false,
    artifactsPresent: false,
    productIdentityPreserved: true,
    backgroundPreserved: true,
    allProductsPresent: true,
    feedback: "Synthetic provider fixture",
  };
  async function fakeOpenAI(
    scenario: "qa" | "lost" | "rate" | "cancel" | "occupied" | "repairqa",
  ) {
    await seedPipeline();
    Object.assign(serverConfig, {
      aiMockMode: false,
      openAIImageEnabled: true,
      openaiApiKey: "fake-test-only",
      openaiMaxCostUsd: 20,
      googleApiKey: undefined,
    });
    vi.stubEnv("RENDER_EXECUTION_MODE", "durable");
    const counts = { images: 0, reviews: 0, analyses: 0 };
    const image = await sharp({
      create: { width: 400, height: 300, channels: 3, background: "#aabbcc" },
    })
      .webp()
      .toBuffer();
    const answer = (value: unknown) =>
      Response.json({
        output: [
          { content: [{ type: "output_text", text: JSON.stringify(value) }] },
        ],
      });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: RequestInit) => {
        if (init.body instanceof FormData) {
          counts.images++;
          if (scenario === "lost") throw new Error("lost image response");
          if (scenario === "rate" && counts.images === 1)
            return new Response("rate limited", { status: 429 });
          if (scenario === "cancel") {
            const current = await collections(db).renders.findOne({
              status: "processing",
            });
            await endDurableRender(db, current!, "cancelled");
          }
          return Response.json({
            data: [{ b64_json: image.toString("base64") }],
          });
        }
        const request = JSON.parse(String(init.body));
        const schema = request.text?.format?.name;
        if (schema === "scene_obstacle_inspection") {
          counts.analyses++;
          return answer({
            imageClear: true,
            clarityScore: 1,
            targetVisible: true,
            supportVisible: true,
            obstacleAtPoint: scenario === "occupied",
            obstacleName: "old vase",
            obstacleXMin: 0.3,
            obstacleYMin: 0.3,
            obstacleXMax: 0.7,
            obstacleYMax: 0.8,
            evidence: "fixture",
          });
        }
        if (schema === "cleaned_scene_placement") {
          counts.analyses++;
          return answer({
            feasible: true,
            imageClear: true,
            clarityScore: 1,
            errorCode: "none",
            xNormalized: 0.5,
            yNormalized: 0.8,
            scale: 0.2,
            rotationDegrees: 0,
            lightingDirection: "left",
            lightingTemperature: "neutral",
            confidence: 1,
            rationale: "fixture",
            fitXMin: 0.05,
            fitYMin: 0.05,
            fitXMax: 0.95,
            fitYMax: 0.95,
            surfaceXMin: 0.05,
            surfaceYMin: 0.05,
            surfaceXMax: 0.95,
            surfaceYMax: 0.95,
            apparentDistance: "medium",
            framing: "normal",
            occlusion: "none",
            perspectiveEvidence: "fixture",
          });
        }
        if (schema === "render_quality_review") {
          counts.reviews++;
          if (scenario === "repairqa" && counts.reviews === 1)
            return answer({
              ...goodReview,
              accepted: false,
              score: 0.4,
              photorealistic: false,
            });
          if (scenario === "repairqa" && counts.reviews === 2)
            return new Response("judge unavailable", { status: 503 });
          if (scenario === "qa" && counts.reviews === 1)
            return new Response("judge unavailable", { status: 503 });
          return answer(goodReview);
        }
        throw new Error("Unexpected provider request " + schema);
      }),
    );
    return counts;
  }
  it.each(["qa", "rate"] as const)(
    "standard OpenAI resumes after %s without repeating completed stages",
    async (scenario) => {
      const calls = await fakeOpenAI(scenario);
      const result = await createRender(db, "org", standardInput());
      await runWorkerOnce(db, "first");
      const interrupted = await collections(db).renders.findOne({
        id: result.id,
      });
      expect(interrupted?.status, interrupted?.error).toBe("queued");
      expect(calls.analyses).toBe(2);
      expect(calls.images).toBe(1);
      await collections(db).renders.updateOne(
        { id: result.id },
        {
          $set: {
            "execution.availableAt": new Date(0),
            createdAt: new Date(Date.now() - 360_000),
          },
        },
      );
      await runWorkerOnce(db, "resumed");
      const final = await collections(db).renders.findOne({ id: result.id });
      expect(final?.status, final?.error).toBe("succeeded");
      expect(calls.analyses).toBe(2);
      expect(calls.images).toBe(scenario === "qa" ? 1 : 2);
      expect(calls.reviews).toBe(scenario === "qa" ? 2 : 1);
      expect(
        (await collections(db).wallets.findOne({ organizationId: "org" }))!
          .balance,
      ).toBe(9);
    },
  );
  it.each(["lost", "cancel", "occupied"] as const)(
    "standard OpenAI stops safely on %s",
    async (scenario) => {
      const calls = await fakeOpenAI(scenario);
      const result = await createRender(db, "org", standardInput());
      await runWorkerOnce(db, "interrupted");
      const final = await collections(db).renders.findOne({ id: result.id });
      expect(final?.status, final?.error).toBe(
        scenario === "cancel" ? "cancelled" : "failed",
      );
      if (scenario === "lost")
        expect(final?.execution?.errorCode).toBe("provider_unknown");
      expect(await runWorkerOnce(db, "no-replay")).toBe(false);
      expect(calls.images).toBe(scenario === "occupied" ? 0 : 1);
      expect(calls.reviews).toBe(0);
      expect(
        (await collections(db).wallets.findOne({ organizationId: "org" }))!
          .balance,
      ).toBe(10);
    },
  );
  it("refuses an unconfirmed or mismatched replacement before queuing", async () => {
    await seedPipeline();
    vi.stubEnv("RENDER_EXECUTION_MODE", "durable");
    const input = {
      ...standardInput(),
      mode: "replace" as const,
      targetMaskId: "target",
      targetMaskAssetId: "cutout",
    };
    await expect(createRender(db, "org", input)).rejects.toThrow(/Confirmez/);
    await db.collection("segmentations").insertOne({
      id: "target",
      organizationId: "org",
      sceneId: "scene",
      status: "confirmed",
      maskAssetId: "other",
    });
    await expect(createRender(db, "org", input)).rejects.toThrow(/Confirmez/);
    expect(await collections(db).renders.countDocuments({})).toBe(0);
  });

  async function confirmedMask() {
    const mask = await sharp({
      create: { width: 400, height: 300, channels: 4, background: "white" },
    })
      .png()
      .toBuffer();
    await storeAsset(
      db,
      {
        organizationId: "org",
        kind: "render",
        visibility: "organization",
        buffer: mask,
        contentType: "image/png",
        expiresAt: new Date(Date.now() + 3600_000),
      },
      "target-mask",
    );
    await db.collection("segmentations").deleteMany({});
    await db.collection("segmentations").insertOne({
      id: "target",
      organizationId: "org",
      sceneId: "scene",
      status: "confirmed",
      maskAssetId: "target-mask",
      label: "confirmed vase",
      box: { xMin: 0.3, yMin: 0.3, xMax: 0.7, yMax: 0.8 },
    });
    return {
      ...standardInput(),
      mode: "replace" as const,
      targetMaskId: "target",
      targetMaskAssetId: "target-mask",
    };
  }
  it("reuses confirmed cleanup and insertion after QA outage with immutable mask metadata", async () => {
    const calls = await fakeOpenAI("qa");
    const input = await confirmedMask();
    const result = await createRender(db, "org", input);
    await db
      .collection("segmentations")
      .updateOne(
        { id: "target" },
        { $set: { maskAssetId: "missing", label: "changed" } },
      );
    await runWorkerOnce(db, "cleanup-first");
    const interrupted = await collections(db).renders.findOne({
      id: result.id,
    });
    expect(interrupted?.status, interrupted?.error).toBe("queued");
    expect(interrupted?.execution?.segmentation?.label).toBe("confirmed vase");
    expect(calls.images).toBe(2);
    await collections(db).renders.updateOne(
      { id: result.id },
      { $set: { "execution.availableAt": new Date(0) } },
    );
    await runWorkerOnce(db, "cleanup-resumed");
    const final = await collections(db).renders.findOne({ id: result.id });
    expect(final?.status, final?.error).toBe("succeeded");
    expect(calls.images).toBe(2);
    expect(calls.reviews).toBe(2);
    expect(final?.placement.operation).toBe("replace");
  });
  it("refuses an expired confirmed mask at the worker before spending", async () => {
    const calls = await fakeOpenAI("qa");
    const result = await createRender(db, "org", await confirmedMask());
    await collections(db).assets.updateOne(
      { id: "target-mask" },
      { $set: { expiresAt: new Date(0) } },
    );
    await runWorkerOnce(db, "expired-mask");
    const final = await collections(db).renders.findOne({ id: result.id });
    expect(final?.status).toBe("failed");
    expect(calls).toEqual({ images: 0, reviews: 0, analyses: 0 });
  });
  it.each(["qa", "lost", "rate"] as const)(
    "Google standard handles %s with queue-owned retries",
    async (scenario) => {
      await seedPipeline();
      Object.assign(serverConfig, {
        aiMockMode: false,
        googleApiKey: "fake-test-only",
        googleMaxRetries: 2,
      });
      vi.stubEnv("RENDER_EXECUTION_MODE", "durable");
      const counts = { images: 0, reviews: 0, analyses: 0 };
      const image = await sharp({
        create: { width: 400, height: 300, channels: 3, background: "#aabbcc" },
      })
        .webp()
        .toBuffer();
      const answer = (value: unknown) =>
        Response.json({
          candidates: [
            { content: { parts: [{ text: JSON.stringify(value) }] } },
          ],
        });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: unknown, init: RequestInit) => {
          const body = JSON.parse(String(init.body));
          if (body.generationConfig.responseModalities.includes("IMAGE")) {
            counts.images++;
            if (scenario === "lost") throw new Error("lost response");
            if (scenario === "rate" && counts.images === 1)
              return Response.json(
                { error: { message: "rate", status: "RESOURCE_EXHAUSTED" } },
                { status: 429 },
              );
            return Response.json({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        inlineData: {
                          mimeType: "image/webp",
                          data: image.toString("base64"),
                        },
                      },
                    ],
                  },
                },
              ],
            });
          }
          const prompt = body.contents[0].parts[0].text;
          if (prompt.startsWith("Analyze this interior")) {
            counts.analyses++;
            return answer({
              roomType: "interior",
              clarityScore: 1,
              depth: "medium",
              horizonY: 0.4,
              vanishingPoints: [],
              surfaces: [
                {
                  type: "table",
                  confidence: 1,
                  polygon: [
                    { x: 0.05, y: 0.05 },
                    { x: 0.95, y: 0.05 },
                    { x: 0.95, y: 0.95 },
                    { x: 0.05, y: 0.95 },
                  ],
                },
              ],
              lighting: {
                direction: "left",
                intensity: 1,
                colorTemperature: "neutral",
                softness: 0.5,
                timeOfDay: "day",
              },
              obstacles: [],
              scale: { status: "estimated", confidence: 0.8 },
            });
          }
          if (prompt.startsWith("Strict quality control")) {
            counts.reviews++;
            if (scenario === "qa" && counts.reviews === 1)
              return Response.json(
                { error: { message: "offline" } },
                { status: 503 },
              );
            return answer({
              accepted: true,
              overallScore: 0.99,
              scaleCorrectionFactor: 1,
              feedback: "fixture",
              checks: [
                "product_present",
                "no_duplicate",
                "old_target_removed",
                "background_preserved",
                "product_similarity",
                "aspect_ratio_plausible",
                "surface_contact",
                "perspective_consistent",
                "shadows_consistent",
                "no_melted_or_cut_parts",
                "calibration_respected",
              ].map((name) => ({ name, score: 1, reason: "fixture" })),
            });
          }
          throw new Error("Unexpected Google request");
        }),
      );
      const result = await createRender(db, "org", standardInput());
      await runWorkerOnce(db, "google-first");
      const interrupted = await collections(db).renders.findOne({
        id: result.id,
      });
      expect(interrupted?.status, interrupted?.error).toBe(
        scenario === "lost" ? "failed" : "queued",
      );
      expect(counts.images).toBe(1);
      if (scenario === "lost") {
        expect(interrupted?.execution?.errorCode).toBe("provider_unknown");
        expect(await runWorkerOnce(db, "google-no-replay")).toBe(false);
      } else {
        await collections(db).renders.updateOne(
          { id: result.id },
          { $set: { "execution.availableAt": new Date(0) } },
        );
        await runWorkerOnce(db, "google-resumed");
        const final = await collections(db).renders.findOne({ id: result.id });
        expect(final?.status, final?.error).toBe("succeeded");
        expect(counts.images).toBe(scenario === "qa" ? 1 : 2);
      }
      expect(counts.analyses).toBe(2);
    },
  );
  it("reviews an already-paid repair after the remaining time drops below the generation allowance", async () => {
    const calls = await fakeOpenAI("repairqa");
    const result = await createRender(db, "org", standardInput());
    await runWorkerOnce(db, "repair-first");
    const interrupted = await collections(db).renders.findOne({
      id: result.id,
    });
    expect(interrupted?.status, interrupted?.error).toBe("queued");
    expect(calls.images).toBe(2);
    await collections(db).renders.updateOne(
      { id: result.id },
      {
        $set: {
          "execution.availableAt": new Date(0),
          "execution.deadlineAt": new Date(Date.now() + 120_000),
        },
      },
    );
    await runWorkerOnce(db, "repair-resumed");
    const final = await collections(db).renders.findOne({ id: result.id });
    expect(final?.status, final?.error).toBe("succeeded");
    expect(calls.images).toBe(2);
    expect(calls.reviews).toBe(3);
  });
  it("yields to the next Vercel invocation without consuming a retry or reserving twice", async () => {
    await seedPipeline();
    vi.stubEnv("RENDER_EXECUTION_MODE", "durable");
    const result = await createRender(db, "org", standardInput());
    await runWorkerOnce(db, "vercel-slice", { yieldAfterMs: 0 });
    const queued = await collections(db).renders.findOne({ id: result.id });
    expect(queued?.status).toBe("queued");
    expect(queued?.execution?.attempts).toBe(0);
    expect(queued?.execution?.token).toBeUndefined();
    expect(
      (await collections(db).wallets.findOne({ organizationId: "org" }))!
        .reserved,
    ).toBe(1);
    await runWorkerOnce(db, "vercel-resumed");
    const final = await collections(db).renders.findOne({ id: result.id });
    expect(final?.status, final?.error).toBe("succeeded");
    const wallet = await collections(db).wallets.findOne({
      organizationId: "org",
    });
    expect(wallet!.balance).toBe(9);
    expect(wallet!.reserved).toBe(0);
  });
});
