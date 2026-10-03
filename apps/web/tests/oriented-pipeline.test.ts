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
const routed = vi.hoisted(() => ({ db: null as Db | null }));
vi.mock("../lib/server/mongodb", async (original) => ({
  ...(await original<object>()),
  database: async () => routed.db,
}));
import { collections } from "../lib/server/mongodb";
import { serverConfig } from "../lib/server/config";
import { createSession, type Tenant } from "../lib/server/auth";
import { dispatchApi } from "../lib/server/api";
import { createRender } from "../lib/server/rendering";
import { runOrientedRender } from "../lib/server/oriented-rendering";
import { claimRender, reserveDurableCredit } from "../lib/server/durable-queue";
import { durableContext } from "../lib/server/durable-context";
import { MyArchitectAIImageProvider } from "../lib/server/ai/myarchitectai";
import * as sceneVision from "../lib/server/spatial-scene-cache";
import * as visualReview from "../lib/server/ai/oriented-review";
import { readAsset } from "../lib/server/assets";
import { preparedCollections } from "../lib/server/prepared-views";
import { globalRoom } from "./fixtures/spatial-room";
import { seedOrientedFixture } from "./helpers/oriented-fixture";
import type { OrientedVisualReview } from "../lib/server/oriented-quality";

const uri = process.env.DURABLE_TEST_MONGODB_URI;
describe.skipIf(!uri)(
  "oriented pipeline with real storage and synthetic providers",
  () => {
    let client: MongoClient,
      db: Db,
      fixture: Awaited<ReturnType<typeof seedOrientedFixture>>;
    const config = { ...serverConfig };
    beforeAll(async () => {
      client = await new MongoClient(uri!).connect();
      db = client.db(
        `lili_oriented_pipeline_${crypto.randomUUID().replaceAll("-", "")}`,
      );
      routed.db = db;
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
      const unthrottle = () =>
        db
          .collection("oriented_provider_gates")
          .updateMany({}, { $set: { nextStartAt: new Date(0) } });
      vi.spyOn(sceneVision, "analyzeSpatialRoom").mockImplementation(
        async () => {
          await unthrottle();
          return { value: globalRoom, usage: undefined, durationMs: 1 };
        },
      );
      vi.spyOn(
        MyArchitectAIImageProvider.prototype,
        "harmonize",
      ).mockImplementation(async (input) => {
        await unthrottle();
        await input.onProviderResponse?.({
          requestId: "fixture-response",
          estimatedCostUsd: 0.03,
          outcome: "succeeded",
          outputReference: "https://fixture.invalid/private-response.png",
        });
        return {
          provider: "myarchitectai",
          model: "edit-by-prompt",
          requestId: "fixture-response",
          status: "succeeded",
          durationMs: 1,
          estimatedCostUsd: 0.03,
          images: [
            {
              data: new Uint8Array(input.composition.data),
              mimeType: "image/png",
            },
          ],
          safety: { blocked: false },
          attemptCount: 1,
          usage: { providerOutcome: "succeeded" },
        };
      });
      vi.spyOn(MyArchitectAIImageProvider.prototype, "edit").mockImplementation(
        async () => {
          throw new Error("Legacy composition must not run");
        },
      );
      vi.spyOn(visualReview, "reviewOrientedCandidate").mockImplementation(
        async (input) => {
          await unthrottle();
          const criteria = Object.fromEntries(
            [
              "identity",
              "angle",
              "geometry",
              "contact",
              "shadow",
              "background",
            ].map((key) => [
              key,
              {
                status: "pass",
                observations: [
                  "Synthetic software test; not visual qualification",
                ],
              },
            ]),
          ) as OrientedVisualReview["criteria"];
          return {
            availability: "available",
            kind: "automated",
            reviewer: "fixture",
            criteria,
            evidence: input.evidence,
          };
        },
      );
    });
    afterEach(() => {
      Object.assign(serverConfig, config);
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });
    const request = async (
      tenant?: Tenant,
      method = "POST",
      path = ["renders"],
      body: unknown = fixture.input,
    ) => {
      const token = tenant ? (await createSession(tenant)).token : undefined;
      return dispatchApi(
        new Request(`http://fixture/v1/${path.join("/")}`, {
          method,
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
        }),
        path,
      );
    };
    const owner: Tenant = {
      organizationId: "org",
      userId: "fixture-owner",
      role: "owner",
    };
    const execute = async () => {
      const claimed = await claimRender(db, "fixture-worker");
      expect(claimed).not.toBeNull();
      await durableContext.run(
        { render: claimed!, token: claimed!.execution!.token! },
        async () => {
          await reserveDurableCredit(db, claimed!);
          await runOrientedRender(
            db,
            claimed!,
            claimed!.execution!.scene,
            claimed!.execution!.products[0]!,
            fixture.input,
          );
        },
      );
      return collections(db).renders.findOne({ id: claimed!.id });
    };
    it("rejects unauthenticated, public, viewer and cross-tenant admission through the API", async () => {
      expect((await request()).status).toBe(401);
      for (const restriction of [
        { role: "viewer" as const },
        { role: "guest" as const },
        { publicSessionId: "visitor" },
        { organizationId: "other" },
      ])
        expect((await request({ ...owner, ...restriction })).status).toBe(403);
      expect(await collections(db).renders.countDocuments()).toBe(0);
      const admitted = await request(owner);
      expect(admitted.status).toBe(201);
      const id = (await admitted.json()).id as string;
      expect(
        (await request({ ...owner, role: "viewer" }, "GET", ["renders", id]))
          .status,
      ).toBe(403);
      expect(
        (
          await request({ ...owner, organizationId: "other" }, "GET", [
            "renders",
            id,
          ])
        ).status,
      ).toBe(404);
    });
    it("freezes approved assets atomically under concurrent admission without retaining the frontal cutout", async () => {
      const admissions = await Promise.all(
        Array.from({ length: 5 }, () => createRender(db, "org", fixture.input)),
      );
      expect(new Set(admissions.map((r) => r.id)).size).toBe(1);
      const render = await collections(db).renders.findOne({
        id: admissions[0]!.id,
      });
      expect(render!.execution!.preparedViews).toHaveLength(1);
      expect(render!.execution!.sourceAssetIds).toEqual(
        expect.arrayContaining([
          fixture.view.image!.assetId,
          fixture.view.alpha!.assetId,
          fixture.product.assetId,
          fixture.scene.assetId,
        ]),
      );
      expect(render!.execution!.sourceAssetIds).not.toContain(
        fixture.oldCutoutId,
      );
      await preparedCollections(db).views.updateOne(
        { id: fixture.view.id },
        {
          $set: {
            state: "revoked",
            revocation: {
              reason: "replacement",
              kind: "superseded",
              actorId: "fixture",
              revokedAt: new Date().toISOString(),
            },
          },
          $inc: { revision: 1 },
        },
      );
      expect(
        (await collections(db).renders.findOne({ id: render!.id }))!.execution!
          .preparedViews![0]!.view.state,
      ).toBe("approved");
      await expect(
        createRender(db, "org", {
          ...fixture.input,
          idempotencyKey: "after-revoke",
        }),
      ).rejects.toThrow(/vue approuvée/);
      expect(
        vi.mocked(MyArchitectAIImageProvider.prototype.harmonize),
      ).not.toHaveBeenCalled();
    });
    it("runs selection, true layers, both reviews and transactional delivery with the selected pixels", async () => {
      await createRender(db, "org", fixture.input);
      const completed = await execute();
      expect(completed).toMatchObject({
        status: "succeeded",
        creditCharged: true,
        engine: "oriented",
        qualityDecision: { status: "accepted" },
      });
      expect(completed!.orientedEvidence!.selectedViewId).toBe(fixture.view.id);
      expect(
        vi.mocked(MyArchitectAIImageProvider.prototype.harmonize),
      ).toHaveBeenCalledOnce();
      expect(
        vi.mocked(MyArchitectAIImageProvider.prototype.edit),
      ).not.toHaveBeenCalled();
      const request = vi.mocked(MyArchitectAIImageProvider.prototype.harmonize)
        .mock.calls[0]![0];
      expect(request).not.toHaveProperty("reference");
      expect(request).not.toHaveProperty("productCutout");
      const reviews = vi
        .mocked(visualReview.reviewOrientedCandidate)
        .mock.calls.map((call) => call[0]);
      expect(reviews.map((review) => review.stage)).toEqual(["raw", "final"]);
      expect(
        reviews.every(
          (review) => review.originals[0]?.assetId === fixture.product.assetId,
        ),
      ).toBe(true);
      const output = await readAsset(db, completed!.resultAssetId!);
      expect(output).not.toBeNull();
      const pixels = await sharp(output!.buffer).removeAlpha().raw().toBuffer();
      const productPixel = (285 * 600 + 300) * 3;
      expect(pixels[productPixel]).toBeGreaterThan(70);
      expect(pixels[productPixel + 2]).toBeLessThan(80);
      expect(pixels.subarray(0, 3)).toEqual(Buffer.from([180, 165, 145]));
      const wallet = await collections(db).wallets.findOne({
        organizationId: "org",
      });
      expect(wallet).toMatchObject({ balance: 9, reserved: 0, holds: [] });
      expect(
        await collections(db).creditTransactions.countDocuments({
          type: "render_capture",
        }),
      ).toBe(1);
      expect(
        await collections(db).renderAttempts.countDocuments({
          renderId: completed!.id,
        }),
      ).toBe(4);
      expect(fetch).not.toHaveBeenCalled();
    });
    it("rejects provider identity failure before restoration or final review, retaining paid usage", async () => {
      await createRender(db, "org", fixture.input);
      const original = vi
        .mocked(visualReview.reviewOrientedCandidate)
        .getMockImplementation()!;
      vi.mocked(visualReview.reviewOrientedCandidate).mockImplementation(
        async (input) => {
          const review = await original(input);
          review.criteria.identity = {
            status: "fail",
            observations: ["Wrong distinctive motif"],
          };
          return review;
        },
      );
      await expect(execute()).rejects.toThrow();
      expect(
        vi
          .mocked(visualReview.reviewOrientedCandidate)
          .mock.calls.map((c) => c[0].stage),
      ).toEqual(["raw"]);
      const render = await collections(db).renders.findOne({});
      expect(render!.qualityDecision?.status).toBe("rejected");
      expect(render!.resultAssetId).toBeUndefined();
      expect(
        render!.execution!.steps["oriented-restoration-0"],
      ).toBeUndefined();
      expect(render!.usageTotals!.estimatedCostUsd).toBeGreaterThanOrEqual(
        0.03,
      );
      expect(render!.creditCharged).toBe(false);
    });
    it("resumes failed downloads from the private reference without sending the image again", async () => {
      await createRender(db, "org", fixture.input);
      const original = vi
        .mocked(MyArchitectAIImageProvider.prototype.harmonize)
        .getMockImplementation()!;
      vi.mocked(
        MyArchitectAIImageProvider.prototype.harmonize,
      ).mockImplementation(async (input) => {
        const image = await original(input);
        return {
          ...image,
          status: "failed",
          images: [],
          error: {
            code: "image_download_failed",
            message: "Temporary download failure",
            retryable: true,
          },
          usage: { providerOutcome: "succeeded" },
        };
      });
      const download = vi
        .spyOn(
          MyArchitectAIImageProvider.prototype,
          "downloadHarmonizationResponse",
        )
        .mockImplementation(async (input) => ({
          provider: "myarchitectai",
          model: "edit-by-prompt",
          requestId: input.observation.requestId,
          status: "succeeded",
          durationMs: 1,
          estimatedCostUsd: input.observation.estimatedCostUsd,
          images: [{ data: input.composition.data, mimeType: "image/png" }],
          safety: { blocked: false },
          attemptCount: 0,
          usage: { providerOutcome: "succeeded" },
        }));
      download.mockResolvedValueOnce({
        provider: "myarchitectai",
        model: "edit-by-prompt",
        requestId: "fixture-response",
        status: "failed",
        durationMs: 1,
        estimatedCostUsd: 0.03,
        images: [],
        safety: { blocked: false },
        attemptCount: 0,
        usage: { providerOutcome: "succeeded" },
        error: {
          code: "image_download_failed",
          message: "Retry download",
          retryable: true,
        },
      });
      await expect(execute()).rejects.toMatchObject({ code: "retry" });
      const job = (await collections(db).renders.findOne({}))!;
      await durableContext.run(
        { render: job, token: job.execution!.token! },
        () =>
          runOrientedRender(
            db,
            job,
            job.execution!.scene,
            job.execution!.products[0]!,
            fixture.input,
          ),
      );
      expect(
        vi.mocked(MyArchitectAIImageProvider.prototype.harmonize),
      ).toHaveBeenCalledOnce();
      expect(download).toHaveBeenCalledTimes(2);
      expect(
        download.mock.calls.every(
          (call) =>
            call[0].observation.outputReference ===
            "https://fixture.invalid/private-response.png",
        ),
      ).toBe(true);
      expect(
        (await collections(db).renders.findOne({ id: job.id }))!.status,
      ).toBe("succeeded");
      expect(
        await collections(db).renderAttempts.countDocuments({
          renderId: job.id,
          provider: "myarchitectai",
        }),
      ).toBe(1);
    });
    it("never completes when the independent reviewer is unavailable", async () => {
      await createRender(db, "org", fixture.input);
      vi.mocked(visualReview.reviewOrientedCandidate).mockRejectedValue(
        Object.assign(new Error("Reviewer unavailable"), {
          providerCalled: false,
          retryable: false,
          status: 503,
        }),
      );
      await expect(execute()).rejects.toThrow(/Reviewer unavailable/);
      const stored = await collections(db).renders.findOne({});
      expect(stored!.status).not.toBe("succeeded");
      expect(stored!.creditCharged).toBe(false);
      expect(stored!.resultAssetId).toBeUndefined();
    });
  },
);
