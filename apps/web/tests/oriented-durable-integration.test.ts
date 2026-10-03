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
import { MyArchitectAIImageProvider } from "../lib/server/ai/myarchitectai";
import * as preparedMatte from "../lib/server/prepared-view-matte";
import { AdminProductError } from "../lib/server/admin-products";
import { queuePreparedView, retryPreparedViewMatte, runPreparedViewTask } from "../lib/server/prepared-view-tasks";
vi.mock("server-only", () => ({}));
import { collections } from "../lib/server/mongodb";
import { serverConfig } from "../lib/server/config";
import { createRender } from "../lib/server/rendering";
import {
  claimRender,
  completeDurableRender,
  reserveDurableCredit,
} from "../lib/server/durable-queue";
import { durableContext } from "../lib/server/durable-context";
import {
  orientedProviderCall,
  recordOrientedImageResponse,
  type OrientedCallDescriptor,
} from "../lib/server/oriented-provider-execution";
import {
  preparedCollections,
  revokePreparedView,
} from "../lib/server/prepared-views";
import { seedOrientedFixture } from "./helpers/oriented-fixture";
import type { RenderDocument } from "../lib/server/types";

const uri = process.env.DURABLE_TEST_MONGODB_URI;
describe.skipIf(!uri)(
  "oriented provider intentions and MongoDB transactions",
  () => {
    let client: MongoClient,
      db: Db,
      render: RenderDocument,
      fixture: Awaited<ReturnType<typeof seedOrientedFixture>>;
    const config = { ...serverConfig };
    beforeAll(async () => {
      client = await new MongoClient(uri!).connect();
      db = client.db(
        `lili_oriented_durable_${crypto.randomUUID().replaceAll("-", "")}`,
      );
    });
    afterAll(async () => {
      if (db) await db.dropDatabase();
      if (client) await client.close();
    });
    beforeEach(async () => {
      await db.dropDatabase();
      Object.assign(serverConfig, {
        aiMockMode: false,
        demoMode: false,
        openaiApiKey: "fixture-not-a-key",
        myArchitectAIApiKey: "fixture-not-a-key",
        cloudinaryUrl: undefined,
        cloudinaryCloudName: undefined,
        orientedOrganizationIds: ["org"],
        orientedProductIds: ["product"],
      });
      vi.stubEnv("RENDER_EXECUTION_MODE", "durable");
      vi.stubEnv("RENDER_MAX_COST_USD", "50");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("No network allowed in software fixture");
        }),
      );
      fixture = await seedOrientedFixture(db);
      serverConfig.orientedProductIds = [fixture.product.id];
      await createRender(db, "org", fixture.input);
      render = (await claimRender(db, "worker-a"))!;
      expect(render).not.toBeNull();
    });
    afterEach(() => {
      Object.assign(serverConfig, config);
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });
    const within = <T>(work: () => Promise<T>, job = render) =>
      durableContext.run({ render: job, token: job.execution!.token! }, work);
    const descriptor = (
      overrides: Partial<OrientedCallDescriptor> = {},
    ): OrientedCallDescriptor => ({
      key: "oriented-test-image",
      provider: "fixture",
      model: "fixture",
      policy: "image",
      allowanceUsd: 0.1,
      reserveAfterUsd: 0.2,
      deadlineMs: Date.now() + 60_000,
      ...overrides,
    });
    const result = {
      status: "succeeded",
      estimatedCostUsd: 0.04,
      usage: { providerOutcome: "succeeded" },
      fixture: true,
    };

    it("atomically admits one matte retry and reuses the paid image without changing its budget", async () => {
      vi.stubEnv("ORIENTED_PREPARATION_ENABLED", "true");
      vi.stubEnv("ORIENTED_PREPARATION_ORGANIZATION_IDS", "org");
      vi.stubEnv("ORIENTED_PREPARATION_PRODUCT_IDS", fixture.product.id);
      vi.stubEnv("ORIENTED_PREPARATION_MAX_COST_USD", "0.1");
      vi.stubEnv("ORIENTED_PREPARATION_PROVIDER_COST_USD", "0.03");
      const prepare = vi.spyOn(MyArchitectAIImageProvider.prototype, "prepareView").mockResolvedValue({
        provider: "myarchitectai", model: "fixture", requestId: "prepared-known-image", status: "succeeded",
        durationMs: 1, estimatedCostUsd: 0.03, images: [{ data: fixture.prepared, mimeType: "image/png" }],
        safety: { blocked: false }, attemptCount: 1, usage: { providerOutcome: "succeeded" },
      });
      const download = vi.spyOn(MyArchitectAIImageProvider.prototype, "downloadPreparedResponse");
      vi.spyOn(preparedMatte, "prepareViewMatte")
        .mockRejectedValueOnce(new AdminProductError("Synthetic matte refusal", 422))
        .mockResolvedValue({ image: fixture.prepared, alpha: fixture.mask, widthPx: 80, heightPx: 120,
          visibleBounds: { x: 0.25, y: 1 / 6, width: 0.5, height: 2 / 3 },
          anchor: { x: 0.5, y: 5 / 6, confidence: 0.9 }, warnings: [], maskSource: "heuristic", version: "fixture-retry-mask-v2" });
      const queued = await queuePreparedView(db, "org", fixture.product.id, { idempotencyKey: "prepare-image-once",
        preset: "top", variantId: null, expectedProductRevision: fixture.product.updatedAt.toISOString() });
      await runPreparedViewTask(db, queued.preparationId);
      const before = await preparedCollections(db).tasks.findOne({ id: queued.preparationId });
      const view = await preparedCollections(db).views.findOne({ id: queued.viewId });
      expect(before).toMatchObject({ state: "failed", failureStage: "matte", provider: { state: "succeeded", calls: 1, costUsd: 0.03 } });
      const budgetBefore = await db.collection("prepared_view_budgets").findOne({ _id: "org" as never });
      const request = { idempotencyKey: "retry-same-matte-request", expectedRevision: view!.revision,
        expectedProductRevision: fixture.product.updatedAt.toISOString() };
      const retries = await Promise.all([
        retryPreparedViewMatte(db, "org", fixture.product.id, queued.viewId, "admin:alice", request),
        retryPreparedViewMatte(db, "org", fixture.product.id, queued.viewId, "admin:alice", request),
      ]);
      expect(retries.map(item => item.reused).sort()).toEqual([false, true]);
      const processing = await Promise.all([runPreparedViewTask(db, queued.preparationId), runPreparedViewTask(db, queued.preparationId)]);
      expect(processing.filter(item => item.processed)).toHaveLength(1);
      const after = await preparedCollections(db).tasks.findOne({ id: queued.preparationId });
      expect(after!.state).toBe("needs_review");
      expect(after!.matteRetries).toHaveLength(1);
      expect(after!.provider).toEqual(before!.provider);
      expect(after!.checkpoint.rawSha256).toBe(before!.checkpoint.rawSha256);
      expect(await db.collection("prepared_view_budgets").findOne({ _id: "org" as never })).toEqual(budgetBefore);
      expect(await preparedCollections(db).views.findOne({ id: queued.viewId })).toMatchObject({ state: "needs_review",
        revision: view!.revision + 2, review: null, "versions": { mask: "fixture-retry-mask-v2" } });
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(download).not.toHaveBeenCalled();
      expect(await db.collection("prepared_matte_retry_requests").countDocuments({ organizationId: "org" })).toBe(1);
    });

    it("commits intention and provisional expense before the call, then replays only the checkpoint", async () => {
      const call = vi.fn(async () => {
        const intent = await collections(db).renderAttempts.findOne({
          renderId: render.id,
        });
        const charged = await collections(db).renders.findOne({
          id: render.id,
        });
        expect(intent).toMatchObject({
          usageOutcome: "unknown",
          estimatedCostUsd: 0.1,
          usage: { intentPersisted: true, provisional: true },
        });
        expect(charged!.usageTotals).toMatchObject({
          calls: 1,
          estimatedCostUsd: 0.1,
          unknownOutcomeCalls: 1,
        });
        return result;
      });
      await within(async () => {
        expect(
          await orientedProviderCall(db, render, descriptor(), call),
        ).toEqual(result);
        expect(
          await orientedProviderCall(db, render, descriptor(), call),
        ).toEqual(result);
      });
      expect(call).toHaveBeenCalledOnce();
      expect(
        (await collections(db).renders.findOne({ id: render.id }))!.usageTotals,
      ).toEqual({ calls: 1, estimatedCostUsd: 0.04, unknownOutcomeCalls: 0 });
    });
    it("keeps an unknown image cost and never reissues a lost response", async () => {
      const call = vi.fn(async () => {
        throw new Error("socket closed after upload");
      });
      const recover = vi.fn(async () => result);
      await within(async () => {
        await expect(
          orientedProviderCall(db, render, descriptor(), call),
        ).rejects.toMatchObject({ code: "provider_unknown" });
        await expect(
          orientedProviderCall(db, render, descriptor(), call, recover),
        ).rejects.toMatchObject({ code: "provider_unknown" });
        await expect(
          orientedProviderCall(db, render, descriptor(), call),
        ).rejects.toMatchObject({ code: "provider_unknown" });
      });
      expect(call).toHaveBeenCalledOnce();
      expect(recover).not.toHaveBeenCalled();
      expect(
        (await collections(db).renders.findOne({ id: render.id }))!.usageTotals,
      ).toEqual({ calls: 1, estimatedCostUsd: 0.1, unknownOutcomeCalls: 1 });
      expect(
        (await collections(db).renderAttempts.findOne({ renderId: render.id }))!
          .usageOutcome,
      ).toBe("unknown");
    });
    it("bounds billable vision retries to three distinct intentions", async () => {
      const call = vi.fn(async () => {
        throw Object.assign(new Error("temporary vision failure"), {
          retryable: true,
        });
      });
      const analysis = descriptor({
        key: "oriented-test-vision",
        policy: "analysis",
      });
      await within(async () => {
        for (let attempt = 0; attempt < 4; attempt++) {
          await db
            .collection("oriented_provider_gates")
            .updateMany({}, { $set: { nextStartAt: new Date(0) } });
          await expect(
            orientedProviderCall(db, render, analysis, call),
          ).rejects.toMatchObject({
            code: attempt < 2 ? "retry" : "permanent",
          });
        }
      });
      expect(call).toHaveBeenCalledTimes(3);
      const entries = await collections(db)
        .renderAttempts.find({ renderId: render.id })
        .toArray();
      expect(entries.map((entry) => entry.id).sort()).toEqual(
        [1, 2, 3].map(
          (attempt) => `${render.id}:oriented-test-vision:analysis-${attempt}`,
        ),
      );
      const stored = await collections(db).renders.findOne({ id: render.id });
      expect(stored!.usageTotals!.estimatedCostUsd).toBeCloseTo(0.3);
      expect(stored!.usageTotals!.unknownOutcomeCalls).toBe(3);
    });
    it("recovers a known paid response after checkpoint failure using its private reference only", async () => {
      const observation = {
        requestId: "known-response",
        estimatedCostUsd: 0.04,
        outcome: "succeeded" as const,
        outputReference: "https://fixture.invalid/private-expiring-output.png",
      };
      const faulty = new Proxy(db, {
        get(target, property) {
          if (property !== "collection") {
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return (name: string) =>
            new Proxy(target.collection(name), {
              get(collection, method) {
                if (name === "renders" && method === "updateOne")
                  return async (
                    filter: object,
                    update: { $set?: Record<string, unknown> },
                    options: object,
                  ) => {
                    const step = update.$set?.[
                      "execution.steps.oriented-test-image"
                    ] as { status?: string } | undefined;
                    if (step?.status === "completed")
                      throw new Error("Crash during completed checkpoint");
                    return collection.updateOne(filter, update, options);
                  };
                const value = Reflect.get(collection, method);
                return typeof value === "function"
                  ? value.bind(collection)
                  : value;
              },
            });
        },
      });
      const post = vi.fn(async () => {
        await recordOrientedImageResponse(
          db,
          render,
          "oriented-test-image",
          observation,
        );
        return result;
      });
      const download = vi.fn(async (value) => {
        expect(value).toEqual(observation);
        return result;
      });
      await within(async () => {
        await expect(
          orientedProviderCall(faulty, render, descriptor(), post, download),
        ).rejects.toThrow(/checkpoint/);
        expect(
          (await collections(db).renders.findOne({ id: render.id }))!.execution!
            .steps["oriented-test-image"]!.status,
        ).toBe("running");
        expect(
          await orientedProviderCall(db, render, descriptor(), post, download),
        ).toEqual(result);
        expect(
          await orientedProviderCall(db, render, descriptor(), post, download),
        ).toEqual(result);
      });
      expect(post).toHaveBeenCalledOnce();
      expect(download).toHaveBeenCalledOnce();
      const stored = await collections(db).renders.findOne({ id: render.id });
      expect(stored!.usageTotals).toEqual({
        calls: 1,
        estimatedCostUsd: 0.04,
        unknownOutcomeCalls: 0,
      });
      expect(
        (await collections(db).renderAttempts.findOne({ renderId: render.id }))!
          .usage,
      ).toMatchObject({ providerResponse: observation });
    });
    it("settles the provisional journal on recovery after response persistence but before reconciliation", async () => {
      const observation = {
        requestId: "known-before-crash",
        estimatedCostUsd: 0.04,
        outcome: "succeeded" as const,
        outputReference: "https://fixture.invalid/private-before-crash.png",
      };
      const faulty = new Proxy(db, {
        get(target, property) {
          if (property !== "collection") {
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return (name: string) =>
            new Proxy(target.collection(name), {
              get(collection, method) {
                if (name === "render_attempts" && method === "updateOne")
                  return async (
                    filter: Record<string, unknown>,
                    update: object,
                    options: object,
                  ) => {
                    if (filter["usage.provisional"] === true)
                      throw new Error("Crash before usage reconciliation");
                    return collection.updateOne(filter, update, options);
                  };
                const value = Reflect.get(collection, method);
                return typeof value === "function"
                  ? value.bind(collection)
                  : value;
              },
            });
        },
      });
      const post = vi.fn(async () => {
        await recordOrientedImageResponse(
          db,
          render,
          "oriented-test-image",
          observation,
        );
        return result;
      });
      const download = vi.fn(async () => result);
      await within(async () => {
        await expect(
          orientedProviderCall(faulty, render, descriptor(), post, download),
        ).rejects.toThrow(/reconciliation/);
        expect(
          (await collections(db).renderAttempts.findOne({
            renderId: render.id,
          }))!.usage,
        ).toMatchObject({ provisional: true, providerResponse: observation });
        expect(
          await orientedProviderCall(db, render, descriptor(), post, download),
        ).toEqual(result);
      });
      expect(post).toHaveBeenCalledOnce();
      expect(download).toHaveBeenCalledOnce();
      expect(
        (await collections(db).renderAttempts.findOne({
          renderId: render.id,
        }))!,
      ).toMatchObject({
        status: "succeeded",
        usageOutcome: "succeeded",
        estimatedCostUsd: 0.04,
        usage: { provisional: false },
      });
      expect(
        (await collections(db).renders.findOne({ id: render.id }))!.usageTotals,
      ).toEqual({ calls: 1, estimatedCostUsd: 0.04, unknownOutcomeCalls: 0 });
    });
    it("retains a known paid rejection and does not reinterpret it as an unknown generation", async () => {
      const rejected = {
        status: "failed",
        estimatedCostUsd: 0.03,
        usage: { providerOutcome: "rejected", reason: "wrong_ratio" },
      };
      const call = vi.fn(async () => rejected);
      await within(async () => {
        expect(
          await orientedProviderCall(db, render, descriptor(), call),
        ).toEqual(rejected);
        expect(
          await orientedProviderCall(db, render, descriptor(), call),
        ).toEqual(rejected);
      });
      expect(call).toHaveBeenCalledOnce();
      expect(
        (await collections(db).renders.findOne({ id: render.id }))!.usageTotals,
      ).toEqual({ calls: 1, estimatedCostUsd: 0.03, unknownOutcomeCalls: 0 });
    });
    it("coordinates provider starts across independent clients and does not bill a deferred worker", async () => {
      await createRender(db, "org", {
        ...fixture.input,
        idempotencyKey: "second-job",
      });
      const second = (await claimRender(db, "worker-b"))!;
      const other = await new MongoClient(uri!).connect();
      const otherDb = other.db(db.databaseName);
      let release!: () => void, entered!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const call = vi.fn(async () => {
        entered();
        await hold;
        return result;
      });
      const first = within(() =>
        orientedProviderCall(db, render, descriptor(), call),
      );
      await ready;
      const secondCall = vi.fn(async () => result);
      try {
        await expect(
          within(
            () =>
              orientedProviderCall(otherDb, second, descriptor(), secondCall),
            second,
          ),
        ).rejects.toMatchObject({ code: "retry" });
        expect(secondCall).not.toHaveBeenCalled();
        expect(
          await collections(otherDb).renderAttempts.countDocuments({
            renderId: second.id,
          }),
        ).toBe(0);
      } finally {
        release();
        await first;
        await other.close();
      }
      expect(call).toHaveBeenCalledOnce();
    });
    it("rolls back the intention when reserving its expense fails before dispatch", async () => {
      const faulty = new Proxy(db, {
        get(target, property) {
          if (property !== "collection") {
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return (name: string) =>
            new Proxy(target.collection(name), {
              get(collection, method) {
                if (name === "renders" && method === "updateOne")
                  return async (
                    filter: object,
                    update: { $inc?: Record<string, number> },
                    options: object,
                  ) => {
                    if (update.$inc?.["usageTotals.calls"])
                      throw new Error("Injected reservation failure");
                    return collection.updateOne(filter, update, options);
                  };
                const value = Reflect.get(collection, method);
                return typeof value === "function"
                  ? value.bind(collection)
                  : value;
              },
            });
        },
      });
      const call = vi.fn(async () => result);
      await expect(
        within(() => orientedProviderCall(faulty, render, descriptor(), call)),
      ).rejects.toThrow();
      expect(call).not.toHaveBeenCalled();
      expect(
        await collections(db).renderAttempts.countDocuments({
          renderId: render.id,
        }),
      ).toBe(0);
      expect(
        (await collections(db).renders.findOne({ id: render.id }))!.usageTotals
          ?.estimatedCostUsd ?? 0,
      ).toBe(0);
    });
    it("stops over-budget work before an intention or paid dispatch", async () => {
      const call = vi.fn(async () => result);
      await expect(
        within(() =>
          orientedProviderCall(
            db,
            render,
            descriptor({ allowanceUsd: 49, reserveAfterUsd: 2 }),
            call,
          ),
        ),
      ).rejects.toThrow(/budget|coût|dépense/i);
      expect(call).not.toHaveBeenCalled();
      expect(
        await collections(db).renderAttempts.countDocuments({
          renderId: render.id,
        }),
      ).toBe(0);
    });
    it("reconciles a completed expense after lease loss without allowing the old worker to save or deliver", async () => {
      const call = vi.fn(async () => {
        await recordOrientedImageResponse(db, render, "oriented-test-image", {
          requestId: "lease-loss-response",
          estimatedCostUsd: 0.04,
          outcome: "succeeded",
          outputReference: "https://fixture.invalid/private-lease-loss.png",
        });
        await collections(db).renders.updateOne(
          { id: render.id },
          { $set: { "execution.token": "worker-b-took-over" } },
        );
        return result;
      });
      await expect(
        within(() => orientedProviderCall(db, render, descriptor(), call)),
      ).rejects.toMatchObject({ code: "lease_lost" });
      const stored = await collections(db).renders.findOne({ id: render.id });
      expect(stored!.usageTotals).toEqual({
        calls: 1,
        estimatedCostUsd: 0.04,
        unknownOutcomeCalls: 0,
      });
      expect(stored!.execution!.steps["oriented-test-image"]!.status).toBe(
        "running",
      );
      expect(stored!.status).toBe("processing");
      expect(stored!.creditCharged).toBe(false);
      const recover = vi.fn(async () => {
        await collections(db).renders.updateOne(
          { id: render.id },
          { $set: { "execution.token": "worker-c-took-over" } },
        );
        return result;
      });
      await expect(
        within(
          () => orientedProviderCall(db, stored!, descriptor(), call, recover),
          stored!,
        ),
      ).rejects.toMatchObject({ code: "lease_lost" });
      expect(call).toHaveBeenCalledOnce();
      expect(recover).toHaveBeenCalledOnce();
      const afterRecovery = await collections(db).renders.findOne({
        id: render.id,
      });
      expect(
        afterRecovery!.execution!.steps["oriented-test-image"]!.status,
      ).toBe("running");
      expect(afterRecovery!.usageTotals).toEqual({
        calls: 1,
        estimatedCostUsd: 0.04,
        unknownOutcomeCalls: 0,
      });
      expect(
        (await collections(db).renderAttempts.findOne({ renderId: render.id }))!
          .usage?.provisional,
      ).toBe(false);
    });
    it.each(["identity_incident", "superseded"] as const)(
      "settles snapshot revocation %s and credits in the same transaction",
      async (kind) => {
        await within(() => reserveDurableCredit(db, render));
        await revokePreparedView(
          db,
          "org",
          fixture.product.id,
          fixture.view.id,
          "fixture-reviewer",
          { expectedRevision: 1, reason: "fixture revocation", kind },
        );
        const snapshot = render.execution!.preparedViews![0]!;
        const update: Partial<RenderDocument> = {
          resultAssetId: fixture.scene.assetId,
          qualityDecision: {
            version: "oriented-quality-v1",
            status: "accepted",
            score: 1,
            feedback: "Synthetic acceptance",
            checks: [],
          },
          orientedEvidence: {
            version: "oriented-v1",
            selectedViewId: snapshot.view.id,
            snapshotFingerprint: snapshot.snapshotFingerprint,
            origin: "generated",
            metricVerified: false,
            limitations: ["fixture"],
            plan: { fixture: true },
          },
        };
        if (kind === "identity_incident") {
          await expect(
            within(() => completeDurableRender(db, render, update)),
          ).rejects.toThrow(/incident/);
          expect(
            await collections(db).creditTransactions.countDocuments({
              type: "render_capture",
            }),
          ).toBe(0);
          expect(
            (await collections(db).renders.findOne({ id: render.id }))!.status,
          ).toBe("processing");
        } else {
          const outcomes = await Promise.allSettled([
            within(() => completeDurableRender(db, render, update)),
            within(() => completeDurableRender(db, render, update)),
          ]);
          expect(
            outcomes.filter((outcome) => outcome.status === "fulfilled"),
          ).toHaveLength(1);
          expect(
            outcomes.filter((outcome) => outcome.status === "rejected"),
          ).toHaveLength(1);
          expect(
            await collections(db).creditTransactions.countDocuments({
              type: "render_capture",
            }),
          ).toBe(1);
          expect(
            (await collections(db).wallets.findOne({ organizationId: "org" }))!
              .reserved,
          ).toBe(0);
          expect(
            (await preparedCollections(db).views.findOne({
              id: fixture.view.id,
            }))!.state,
          ).toBe("revoked");
        }
      },
    );
  },
);
