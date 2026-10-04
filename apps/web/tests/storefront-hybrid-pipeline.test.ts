import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { Db } from "mongodb";
import type { RenderDocument } from "../lib/server/types";
import type { RenderInput } from "../lib/server/render-request";
import { documentStore } from "./helpers/render-store";

const mocks = vi.hoisted(() => ({
  collections: vi.fn(),
  read: vi.fn(),
  store: vi.fn(),
  capture: vi.fn(),
  reserve: vi.fn(),
  release: vi.fn(),
  edit: vi.fn(),
  storefrontPreflight: vi.fn(),
  config: {
    aiMockMode: false,
    openaiApiKey: "test-only",
    openaiVisionModel: "test-vision",
    openaiModel: "test-image",
    storefrontImageModel: "test-repair-image",
    openaiBaseUrl: "https://invalid.test/v1",
    openaiQuality: "high",
    openaiMaxCostUsd: 1,
    openAIImageEnabled: true,
    googleApiKey: undefined as string | undefined,
    simplePointImageProvider: "openai" as "openai" | "myarchitectai",
    myArchitectAIApiKey: "test-myarchitectai",
    myArchitectAIEditCostUsd: 0.03,
  },
}));
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/config", () => ({
  serverConfig: mocks.config,
  paidImageProviderConfigured: () => !mocks.config.aiMockMode,
}));
vi.mock("../lib/server/mongodb", () => ({ collections: mocks.collections }));
vi.mock("../lib/server/assets", () => ({
  readAsset: mocks.read,
  storeAsset: mocks.store,
  assetUrl: (id?: string) => (id ? `/api/assets/${id}` : null),
  privateVisibility: (publicSessionId?: string) =>
    publicSessionId ? { ownerSessionId: publicSessionId } : "organization",
}));
vi.mock("../lib/server/credits", () => ({
  captureCredit: mocks.capture,
  reserveCredit: mocks.reserve,
  releaseCredit: mocks.release,
}));
vi.mock("../lib/server/scale-estimation", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/server/scale-estimation")>(),
  SCALE_ESTIMATION_VERSION: "scale-test",
  getOrEstimateSceneScale: vi.fn(async () => ({
    spans: [0, 1, 2].map(() => ({
      pixelsPerCm: 2.5,
      scaleSource: "vision",
      confidence: "high",
    })),
    lighting: null,
  })),
}));
vi.mock("../lib/server/ai/storefront-scene-preflight", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/server/ai/storefront-scene-preflight")>(),
  inspectStorefrontScene: mocks.storefrontPreflight,
}));
vi.mock("../lib/server/durable-steps", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/server/durable-steps")>();
  return { ...original, durableStep: vi.fn(original.durableStep) };
});
vi.mock("../lib/server/ai", () => ({
  selectEditingProvider: vi.fn((
    _mode: string,
    _quality: string,
    preferred?: string,
    frozenModel?: string,
  ) => {
    if (
      !preferred &&
      mocks.config.simplePointImageProvider === "myarchitectai" &&
      !mocks.config.openAIImageEnabled &&
      !mocks.config.googleApiKey
    ) {
      throw new Error("No default image provider is configured.");
    }
    return {
      route: { provider: preferred ?? "openai", degradedMode: false },
      provider: {
        model: preferred === "myarchitectai" ? "edit-by-prompt" : frozenModel ?? "test-image",
        edit: mocks.edit,
      },
    };
  }),
  selectSceneAnalysisProvider: vi.fn(),
  inspectImagesWithGoogle: vi.fn(),
}));
import { createRender } from "../lib/server/rendering";
import { renderResponse } from "../lib/server/serializers";
import { selectEditingProvider } from "../lib/server/ai";
import { stopRender } from "../lib/server/render-lifecycle";
import { markPoints } from "../lib/server/scale-estimation";
import { durableStep } from "../lib/server/durable-steps";

const db = {} as Db;
let renders: ReturnType<typeof documentStore>;
let attempts: ReturnType<typeof documentStore>;
let scenes: ReturnType<typeof documentStore>;
let products: ReturnType<typeof documentStore>;
let request: RenderInput;
let reviewPayload: Record<string, unknown>;
let preflightRejected: boolean;
let remainingRepairableFailures: number;
let qualityUnavailable: boolean;
let cancelAt: "preflight" | "quality" | null;
let reviewCalls: number;
let inspectionFailure: boolean;
let obstacle: boolean;
type ReviewRequest = {
  text?: { format?: { schema?: { properties?: Record<string, unknown> } } };
  input: Array<{
    content: Array<{ type: string; image_url?: string; text?: string }>;
  }>;
};

const passed = () => ({
  passed: true,
  score: 0.95,
  reason: "Conforme aux références.",
});

function structuredReview(
  body: ReviewRequest,
  stage: "preflight" | "final",
): Record<string, unknown> {
  const text = body.input[1]!.content[0]!.text!;
  const placementData = JSON.parse(
    text.split("Placement data: ")[1]!.split("\nAdditional scene evidence")[0]!,
  ) as Array<{ id: string; expectedBox: Record<string, number> }>;
  const common = {
    accepted: true,
    score: 0.95,
    confidence: 0.95,
    feedback: "Conforme.",
    products: placementData.map(({ id, expectedBox }) => ({
      id,
      confidence: 0.95,
      ...(stage === "final"
        ? { observedBox: expectedBox, foregroundOccluded: false }
        : {}),
      checks: Object.fromEntries(
        (stage === "final"
          ? [
              "present",
              "identity",
              "position",
              "scale",
              "perspective",
              "contact",
              "edges",
              "lightingAndShadows",
              "occlusion",
              "noDuplicate",
            ]
          : [
              "supportVisible",
              "placementFeasible",
              "scalePlausible",
              "sourceIdentityPreserved",
              "sourceCutoutComplete",
            ]
        ).map((key) => [key, passed()]),
      ),
    })),
  };
  if (stage === "preflight") {
    return {
      ...common,
      photoUsable: preflightRejected
        ? {
            passed: false,
            score: 0.3,
            reason: "Photo trop floue pour vérifier le support.",
          }
        : passed(),
    };
  }
  if (remainingRepairableFailures > 0) {
    remainingRepairableFailures--;
    common.products[0]!.checks.edges = {
      passed: false,
      score: 0.4,
      reason: "Corriger le halo blanc autour du vase sans déplacer le produit.",
    };
  }
  if (reviewPayload.identityFailure)
    common.products[0]!.checks.identity!.passed = false;
  const final: Record<string, unknown> = {
    ...common,
    backgroundPreserved: passed(),
    replacementComplete: passed(),
    noUnrequestedProducts: passed(),
  };
  if (reviewPayload.missingCheck) delete final.backgroundPreserved;
  return final;
}

function structuredStorefrontReview(body: ReviewRequest) {
  const placementData = JSON.parse(body.input[1]!.content[0]!.text!
    .split("Placement contracts: ")[1]!.split(". User-measured height")[0]!) as Array<{
      id: string; expectedBox: Record<string, number>; placementPoint: { x: number; y: number };
    }>;
  const review = {
    accepted: true, score: 0.95, confidence: 0.95, feedback: "Conforme.",
    photoUsable: passed(), backgroundPreserved: passed(), noUnrequestedProducts: passed(),
    products: placementData.map(({ id, expectedBox, placementPoint }) => ({
      id, confidence: 0.95, observedBox: expectedBox, observedContact: placementPoint, foregroundOccluded: false,
      checks: {
        ...Object.fromEntries(["present", "identity", "position", "scale", "perspective", "contact", "edges",
          "occlusion", "noDuplicate", "gravity", "silhouetteComplete", "photographicCoherence", "supportIntegration"]
          .map(key => [key, passed()])),
        referenceScale: null,
      } as Record<string, ReturnType<typeof passed> | null>,
    })),
  };
  if (remainingRepairableFailures > 0) {
    remainingRepairableFailures--;
    review.products[0]!.checks.perspective = { passed: false, score: 0.4, reason: "La vue du produit ne correspond pas à la caméra de la pièce." };
  }
  if (reviewPayload.identityFailure) review.products[0]!.checks.identity!.passed = false;
  if (reviewPayload.duplicateFailure) review.products[0]!.checks.noDuplicate!.passed = false;
  if (typeof reviewPayload.contactShiftY === "number") {
    const product = review.products[0]!;
    product.observedContact = { ...product.observedContact, y: product.observedContact.y + reviewPayload.contactShiftY };
    product.observedBox = { ...product.observedBox,
      yMin: product.observedBox.yMin! + reviewPayload.contactShiftY,
      yMax: product.observedBox.yMax! + reviewPayload.contactShiftY };
  }
  if (typeof reviewPayload.gateFailure === "string")
    review.products[0]!.checks[reviewPayload.gateFailure] = { passed: false, score: 0.4, reason: "Le contrôle final constate un défaut réel." };
  return { ...review, ...(body.text?.format?.schema?.properties?.replacementComplete ? { replacementComplete: reviewPayload.replacementFailure
    ? { passed: false, score: 0.4, reason: "Une partie de l’ancien objet est encore visible." } : passed() } : {}) };
}

beforeEach(async () => {
  vi.mocked(durableStep).mockClear();
  vi.mocked(selectEditingProvider).mockClear();
  mocks.config.openaiApiKey = "test-only";
  mocks.config.openAIImageEnabled = true;
  mocks.config.googleApiKey = undefined;
  mocks.config.simplePointImageProvider = "openai";
  mocks.config.storefrontImageModel = "test-repair-image";
  mocks.storefrontPreflight.mockReset().mockResolvedValue({
    spans: [{ pixelsPerCm: 2.5, scaleSource: "vision", confidence: "high" }],
    inspections: [{ imageClear: true, clarityScore: 1, targetVisible: true, supportVisible: true,
      obstacleAtPoint: false, obstacleName: null, obstacleBox: null, evidence: "clear" }],
    poses: [{ cameraElevationDegrees: 30, cameraRollDegrees: 0, evidence: "clear" }],
    widthPixelsPerCm: [2.5],
  });
  renders = documentStore();
  attempts = documentStore();
  products = documentStore();
  scenes = documentStore();
  mocks.collections.mockReturnValue({
    renders,
    products,
    scenes,
    renderAttempts: attempts,
  });
  mocks.capture.mockReset().mockResolvedValue(true);
  mocks.reserve.mockReset().mockResolvedValue("reserved");
  mocks.release.mockReset().mockResolvedValue(true);
  mocks.edit.mockReset().mockImplementation(async (input) => ({
    provider: input.operation === "oriented_harmonization" ? "myarchitectai" : "openai",
    model:
      input.operation === "oriented_harmonization"
        ? "edit-by-prompt"
        : "test-image",
    status: "succeeded",
    durationMs: 1,
    estimatedCostUsd: 0.1,
    attemptCount: 1,
    images: [{ data: input.composition, mimeType: "image/webp" }],
    safety: { blocked: false },
  }));
  const sceneBuffer = await sharp({
    create: { width: 400, height: 300, channels: 3, background: "#dddddd" },
  })
    .webp()
    .toBuffer();
  const productBuffer = await sharp({
    create: { width: 32, height: 64, channels: 4, background: "#aa6633" },
  })
    .png()
    .toBuffer();
  // Original bytes differ from the cutout: assertions detect the wrong reference.
  const originalBuffer = await sharp({
    create: { width: 64, height: 80, channels: 3, background: "#aaaa33" },
  })
    .png()
    .toBuffer();
  mocks.read.mockImplementation(async (_db, id: string) => ({
    asset: { id, contentType: id === "room" ? "image/webp" : "image/png" },
    buffer:
      id === "room"
        ? sceneBuffer
        : id.startsWith("original")
          ? originalBuffer
          : productBuffer,
  }));
  mocks.store.mockReset().mockImplementation(async (_db, input) => ({
    id: crypto.randomUUID(),
    ...input,
  }));
  await scenes.insertOne({
    id: "scene",
    organizationId: "org",
    publicSessionId: "guest:visitor-1",
    assetId: "room",
    widthPx: 400,
    heightPx: 300,
    // The real retention is hours, and a render is refused on a scene with
    // less than the route's own 300 s ahead of it.
    expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
  });
  for (let i = 0; i < 3; i++)
    await products.insertOne({
      id: `p${i}`,
      organizationId: "org",
      name: `Product ${i}`,
      assetId: `original-${i}`,
      cutoutAssetId: `cutout-${i}`,
      // PRO-008: a render refuses a cutout whose provenance is unknown, so a
      // fixture must carry the provenance a real prepare would write.
      cutout: {
        widthPx: 32,
        heightPx: 64,
        baseRowFraction: 1,
        source: "heuristic",
        synthetic: false,
        shadowRemoved: false,
        warnings: [],
        cutoutVersion: "cutout-v1",
      },
      objectType: "vase",
      widthCm: 10,
      heightCm: 20,
      depthCm: 10,
      placementType: "table",
      material: "ceramic",
      description: "vase",
    });
  request = {
    workflow: "simple_point",
    idempotencyKey: crypto.randomUUID(),
    placement: { sceneId: "scene", productId: "p0" },
    simplePlacements: [0, 1, 2].map((i) => ({
      productId: `p${i}`,
      placementPoint: { x: 0.2 + i * 0.3, y: 0.8 },
      dimensionPair: { mode: "height_length", heightCm: 20, lengthCm: 10 },
      placementKind: "standing",
    })),
  };
  reviewPayload = {};
  preflightRejected = false;
  remainingRepairableFailures = 0;
  qualityUnavailable = false;
  cancelAt = null;
  reviewCalls = 0;
  inspectionFailure = false;
  obstacle = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init: RequestInit) => {
      if (init.body instanceof FormData)
        return new Response("cleanup unavailable", { status: 502 });
      const payload = JSON.parse(String(init.body));
      if (payload.text?.format?.name === "scene_obstacle_inspection") {
        if (inspectionFailure) throw new Error("offline");
        return Response.json({
          output: [
            {
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    imageClear: true,
                    clarityScore: 1,
                    targetVisible: true,
                    supportVisible: true,
                    obstacleAtPoint: obstacle,
                    obstacleName: "old vase",
                    obstacleXMin: 0,
                    obstacleYMin: 0,
                    obstacleXMax: 1,
                    obstacleYMax: 1,
                    evidence: "clear",
                  }),
                },
              ],
            },
          ],
        });
      }
      if (payload.text?.format?.name === "storefront_room_integration_review") {
        reviewCalls++;
        if (qualityUnavailable) return new Response("offline", { status: 503 });
        if (cancelAt === "quality") await stopRender(db, renders.rows[0] as unknown as RenderDocument, "cancel");
        if (reviewPayload.advanceClockMs && reviewCalls === 1)
          vi.setSystemTime(Date.now() + Number(reviewPayload.advanceClockMs));
        if (reviewPayload.overrunFinalReview && reviewCalls === 2)
          vi.setSystemTime(Date.now() + 180_000);
        if (reviewPayload.exhaustBudget && reviewCalls === 1)
          vi.stubEnv("RENDER_MAX_COST_USD", "0.01");
        return Response.json({ status: "completed", output: [{ type: "message", status: "completed",
          content: [{ type: "output_text", text: JSON.stringify(structuredStorefrontReview(payload)) }] }] });
      }
      const stage =
        payload.text?.format?.name === "placement_preflight"
          ? "preflight"
          : "final";
      if (
        stage === "final" &&
        payload.text?.format?.name !== "render_visual_review"
      )
        throw new Error("Unexpected network request");
      if (stage === "final") {
        reviewCalls++;
        if (qualityUnavailable) return new Response("offline", { status: 503 });
      }
      if (cancelAt === stage || (cancelAt === "quality" && stage === "final")) {
        await stopRender(
          db,
          renders.rows[0] as unknown as RenderDocument,
          "cancel",
        );
      }
      return Response.json({
        status: "completed",
        output: [
          {
            type: "message",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: JSON.stringify(structuredReview(payload, stage)),
              },
            ],
          },
        ],
      });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function runHybridVersion(version: "v1" | "v2" | "v3" | "v4" | "v5" | "v6" | "v9" | "v10") {
  const insert = renders.insertOne;
  renders.insertOne = async row => {
    const prompt = version === "v10" ? "storefront-myarchitect-replacement-v10" : `storefront-myarchitect-room-${version}`;
    (row.engineVersions as NonNullable<RenderDocument["engineVersions"]>).prompt = prompt;
    row.promptVersion = prompt;
    return insert(row);
  };
  try { return await createRender(db, "org", structuredClone(request), "storefront:visitor-1"); }
  finally { renders.insertOne = insert; }
}

describe("historical hybrid v1 rendering", () => {
  it("retains its original image checkpoint and MyArchitectAI request instead of starting a new Responses pose", async () => {
    mocks.config.simplePointImageProvider = "myarchitectai";
    request.simplePlacements = request.simplePlacements!.slice(0, 1);
    await scenes.updateOne({ id: "scene" }, { $set: { publicSessionId: "storefront:visitor-1" } });
    mocks.edit.mockImplementation(async input => ({ provider: "myarchitectai", model: "edit-by-prompt", status: "succeeded",
      durationMs: 1, estimatedCostUsd: 0.03, attemptCount: 1, images: [{ data: input.composition, mimeType: "image/webp" }], safety: { blocked: false } }));
    const result = await runHybridVersion("v1");
    expect(result.status).toBe("succeeded");
    expect(mocks.edit).toHaveBeenCalledOnce();
    expect(mocks.edit.mock.calls[0]![0]).toMatchObject({ operation: "storefront_integration", idempotencyKey: `${request.idempotencyKey}:storefront-perspective` });
    expect(mocks.edit.mock.calls[0]![0].generateProductView).toBeUndefined();
    expect(vi.mocked(durableStep).mock.calls.map(call => call[1])).toContain("storefront-perspective-image");
    expect(vi.mocked(durableStep).mock.calls.map(call => call[1])).not.toContain("pose-responses-v3");
    expect(renders.rows[0]).toMatchObject({ engineVersions: { prompt: "storefront-myarchitect-room-v1" } });
    expect(mocks.capture).toHaveBeenCalledOnce();
  });
});

describe.each(["v2", "v3"] as const)("public hybrid %s replacement with one bounded OpenAI repair", version => {
  beforeEach(async () => {
    mocks.config.simplePointImageProvider = "myarchitectai";
    request.simplePlacements = request.simplePlacements!.slice(0, 1);
    request.replaceExisting = true;
    mocks.storefrontPreflight.mockResolvedValue({
      spans: [{ pixelsPerCm: 2.5, scaleSource: "vision", confidence: "high" }],
      inspections: [{ imageClear: true, clarityScore: 1, targetVisible: true, supportVisible: true,
        obstacleAtPoint: true, obstacleName: "Ancien vase", obstacleBox: { xMin: 0.15, yMin: 0.65, xMax: 0.25, yMax: 0.85 }, evidence: "clear" }],
      poses: [{ cameraElevationDegrees: 30, cameraRollDegrees: 0, evidence: "clear" }], widthPixelsPerCm: [2.5],
    });
    await scenes.updateOne({ id: "scene" }, { $set: { publicSessionId: "storefront:visitor-1" } });
    mocks.edit.mockImplementation(async (input) => ({
      provider: input.operation === "storefront_integration" ? "myarchitectai" : "openai",
      model: input.operation === "storefront_integration" ? "edit-by-prompt" : "test-repair-image",
      status: "succeeded", durationMs: 1, estimatedCostUsd: 0.1, attemptCount: 1,
      images: [{ data: input.composition, mimeType: "image/webp" }], safety: { blocked: false },
    }));
  });

  const run = () => runHybridVersion(version);

  it("uses MyArchitectAI composition only, then one original-reference OpenAI repair and strict second review", async () => {
    remainingRepairableFailures = 1;
    const result = await run();
    expect(result.status).toBe("succeeded");
    expect(mocks.edit).toHaveBeenCalledTimes(2);
    const [primary, repair] = mocks.edit.mock.calls.map(call => call[0]);
    expect(primary.operation).toBe("storefront_integration");
    expect(primary.references.map((reference: { role: string }) => reference.role)).toEqual(["composition"]);
    expect(primary.prompt).toContain("The product is already present in this photograph");
    expect(repair.operation).toBeUndefined();
    const repairReference = repair.references.find((reference: { role: string }) => reference.role === "product_front");
    const original = await mocks.read(db, "original-0");
    expect(Buffer.from(repairReference.data).equals(original.buffer)).toBe(true);
    expect(repair.prompt).toContain("ORIGINAL room and catalogue");
    expect(repair.prompt).toContain("perspective");
    expect(Buffer.from(repair.composition).equals(Buffer.from(primary.composition))).toBe(false);
    expect(repair.idempotencyKey).toBe(`${request.idempotencyKey}:room-repair-${version}`);
    expect(reviewCalls).toBe(2);
    expect(renders.rows[0]).toMatchObject({
      status: "succeeded", provider: "openai", model: "test-repair-image", attemptCount: 2,
      qualityDecision: { status: "accepted" }, engineVersions: { repairImageModel: "test-repair-image" },
    });
    expect(mocks.reserve).toHaveBeenCalledOnce();
    expect(mocks.capture).toHaveBeenCalledOnce();
    expect(mocks.release).not.toHaveBeenCalled();
    const again = await run();
    expect(again.id).toBe(result.id);
    expect(mocks.edit).toHaveBeenCalledTimes(2);
    expect(mocks.reserve).toHaveBeenCalledOnce();
    expect(mocks.capture).toHaveBeenCalledOnce();
  });

  it("delivers an accepted MyArchitectAI candidate without another image call", async () => {
    const result = await run();
    expect(result.status).toBe("succeeded");
    expect(mocks.edit).toHaveBeenCalledOnce();
    expect(reviewCalls).toBe(1);
    expect(mocks.capture).toHaveBeenCalledOnce();
  });

  it("uses the admitted repair model even if provider configuration changes during the first call", async () => {
    remainingRepairableFailures = 1;
    const edit = mocks.edit.getMockImplementation()!;
    mocks.edit.mockImplementation(async (input) => {
      if (input.operation === "storefront_integration") mocks.config.storefrontImageModel = "changed-after-admission";
      return edit(input);
    });
    await run();
    expect(selectEditingProvider).toHaveBeenCalledWith("insert", "final", "openai", "test-repair-image");
    expect(renders.rows[0]).toMatchObject({ engineVersions: { repairImageModel: "test-repair-image" } });
  });

  it("does not start OpenAI image repair with fewer than 75 seconds left", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    remainingRepairableFailures = 1;
    reviewPayload.advanceClockMs = 110_000;
    await expect(run()).rejects.toThrow();
    expect(mocks.edit).toHaveBeenCalledOnce();
    expect(reviewCalls).toBe(1);
    expect(renders.rows[0]).toMatchObject({ status: "failed", creditCharged: false });
    expect(renders.rows[0]!.resultAssetId).toBeUndefined();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("stops after a second visual rejection without weakening checks or charging the customer", async () => {
    remainingRepairableFailures = 10;
    await expect(run()).rejects.toThrow();
    expect(mocks.edit).toHaveBeenCalledTimes(2);
    expect(reviewCalls).toBe(2);
    expect(renders.rows[0]).toMatchObject({ status: "failed", qualityDecision: { status: "rejected" }, creditCharged: false });
    expect(renders.rows[0]).toMatchObject({ provider: "openai", model: "test-repair-image", modelChain: [
      { provider: "myarchitectai", model: "edit-by-prompt", role: "perspective_edit" },
      { provider: "openai", model: "test-repair-image", role: "perspective_repair" },
    ] });
    expect(renders.rows[0]!.resultAssetId).toBeUndefined();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("rejects surviving fragments of a confirmed replacement after the only permitted repair", async () => {
    reviewPayload.replacementFailure = true;
    await expect(run()).rejects.toThrow();
    expect(mocks.edit).toHaveBeenCalledTimes(2);
    expect(reviewCalls).toBe(2);
    expect(renders.rows[0]).toMatchObject({ status: "failed", qualityDecision: { status: "rejected" }, creditCharged: false });
    expect(renders.rows[0]!.resultAssetId).toBeUndefined();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("does not substitute another image request for an unavailable quality review", async () => {
    qualityUnavailable = true;
    await expect(run()).rejects.toThrow();
    expect(mocks.edit).toHaveBeenCalledOnce();
    expect(reviewCalls).toBe(1);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("honors cancellation during the first quality review before any repair image", async () => {
    remainingRepairableFailures = 1;
    cancelAt = "quality";
    await expect(run()).rejects.toThrow();
    expect(mocks.edit).toHaveBeenCalledOnce();
    expect(renders.rows[0]!.status).toBe("cancelled");
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("does not start another image after an uncertain paid MyArchitectAI response", async () => {
    mocks.edit.mockResolvedValueOnce({
      provider: "myarchitectai", model: "edit-by-prompt", status: "failed", durationMs: 1,
      estimatedCostUsd: 0.03, attemptCount: 1, images: [], safety: { blocked: false },
      error: { code: "timeout", message: "Réponse perdue", retryable: true },
    });
    await expect(run()).rejects.toThrow();
    expect(mocks.edit).toHaveBeenCalledOnce();
    expect(reviewCalls).toBe(0);
    expect(attempts.rows.some(row => row.provider === "myarchitectai" && row.usageOutcome === "unknown")).toBe(true);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("rejects a paid repair when the render spending budget is exhausted", async () => {
    remainingRepairableFailures = 1;
    // Exhaust the allowance after the first QA has been admitted, so this
    // specifically exercises the repair's guard before a second image call.
    reviewPayload.exhaustBudget = true;
    await expect(run()).rejects.toThrow(/Budget/);
    expect(mocks.edit).toHaveBeenCalledOnce();
    expect(reviewCalls).toBe(1);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("never captures a credit or publishes a result after the three-minute deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    remainingRepairableFailures = 1;
    reviewPayload.overrunFinalReview = true;
    await expect(run()).rejects.toThrow(/délai|minutes/);
    expect(mocks.edit).toHaveBeenCalledTimes(2);
    expect(reviewCalls).toBe(2);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(renders.rows[0]!.resultAssetId).toBeUndefined();
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});

describe.each(["v2", "v3"] as const)("public hybrid %s camera-first insertion", version => {
  let pose: Buffer;
  beforeEach(async () => {
    mocks.config.simplePointImageProvider = "myarchitectai";
    request.simplePlacements = request.simplePlacements!.slice(0, 1);
    await scenes.updateOne({ id: "scene" }, { $set: { publicSessionId: "storefront:visitor-1" } });
    pose = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect x="20" y="25" width="20" height="35" fill="#2850a0"/><rect x="27" y="17" width="6" height="8" fill="#1e3c78"/></svg>')).png().toBuffer();
    mocks.edit.mockImplementation(async (input) => ({
      provider: input.productIsolation ? "openai" : "myarchitectai",
      model: input.productIsolation ? "test-repair-image" : "edit-by-prompt",
      status: "succeeded", durationMs: 1, estimatedCostUsd: 0.1, attemptCount: 1,
      images: [{ data: input.productIsolation ? pose : input.composition, mimeType: input.productIsolation ? "image/png" : "image/webp" }],
      safety: { blocked: false },
    }));
  });
  const run = () => runHybridVersion(version);

  it("keeps image provider metadata empty when scene preflight rejects before any image call", async () => {
    const preflight = await mocks.storefrontPreflight();
    preflight.inspections[0] = { ...preflight.inspections[0], imageClear: false, clarityScore: 0.1 };
    mocks.storefrontPreflight.mockResolvedValue(preflight);
    await expect(run()).rejects.toThrow();
    expect(mocks.edit).not.toHaveBeenCalled();
    expect(renders.rows[0]).toMatchObject({ status: "failed", provider: null, model: null, modelChain: [] });
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("generates one complete RGBA pose from the full room camera, then harmonizes once and reviews once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = Date.now();
    const result = await run();
    expect(result.status).toBe("succeeded");
    expect(mocks.edit).toHaveBeenCalledTimes(2);
    const [poseInput, lightInput] = mocks.edit.mock.calls.map(call => call[0]);
    expect(poseInput).toMatchObject({ productIsolation: true, productIsolationCameraFirst: true, quality: "high", size: "1024x1024",
      idempotencyKey: `${request.idempotencyKey}:${version === "v3" ? "pose-responses-v3" : "pose-v2"}` });
    expect(poseInput.generateProductView === true).toBe(version === "v3");
    expect(poseInput.references.map((ref: { role: string }) => ref.role)).toEqual(["spatial_guide", "room_original", "product_front"]);
    expect(poseInput.deadlineMs).toBe(startedAt + (version === "v3" ? 180_000 : 130_000));
    expect(await sharp(Buffer.from(poseInput.references[0].data)).metadata()).toMatchObject({ width: 400, height: 300 });
    expect(await sharp(Buffer.from(poseInput.references[1].data)).metadata()).toMatchObject({ width: 400, height: 300 });
    expect(Buffer.from(poseInput.references[2].data)).toEqual((await mocks.read(db, "original-0")).buffer);
    expect(lightInput).toMatchObject({ operation: "storefront_integration", idempotencyKey: `${request.idempotencyKey}:harmonize-${version}` });
    expect(lightInput.deadlineMs).toBe(startedAt + 60_000);
    expect(lightInput.productIsolation).toBeUndefined();
    expect(lightInput.references.map((ref: { role: string }) => ref.role)).toEqual(["composition"]);
    expect(await sharp(Buffer.from(lightInput.composition)).metadata()).toMatchObject({ hasAlpha: false });
    expect(lightInput.prompt).toContain("The product is already present");
    expect(reviewCalls).toBe(1);
    expect(renders.rows[0]).toMatchObject({ provider: "myarchitectai", model: "edit-by-prompt", attemptCount: 2,
      engineVersions: { prompt: `storefront-myarchitect-room-${version}`, repairImageModel: "test-repair-image" }, qualityDecision: { status: "accepted" },
      modelChain: [{ provider: "openai", role: "isolated_product_pose" }, { provider: "myarchitectai", role: "contact_lighting" },
        { provider: "openai", role: "reference_scale_and_realism_review" }] });
    expect(mocks.reserve).toHaveBeenCalledOnce();
    expect(mocks.capture).toHaveBeenCalledOnce();
    const steps = vi.mocked(durableStep).mock.calls.map(call => ({ key: call[1], policy: call[2] }));
    expect(steps).toContainEqual({ key: version === "v3" ? "pose-responses-v3" : "pose-v2", policy: "image" });
    expect(steps).toContainEqual({ key: `harmonize-${version}`, policy: "image" });
    expect(steps).toContainEqual({ key: `review-${version}`, policy: "analysis" });
    const replay = await run();
    expect(replay.id).toBe(result.id);
    expect(mocks.edit).toHaveBeenCalledTimes(2);
    expect(mocks.capture).toHaveBeenCalledOnce();
  });

  it("keeps the admitted pose model when configuration changes during scene analysis", async () => {
    const preflight = mocks.storefrontPreflight.getMockImplementation()!;
    mocks.storefrontPreflight.mockImplementation(async (...args) => {
      mocks.config.storefrontImageModel = "changed-after-admission";
      return preflight(...args);
    });
    await run();
    expect(selectEditingProvider).toHaveBeenCalledWith("insert", "final", "openai", "test-repair-image");
    expect(renders.rows[0]).toMatchObject({ engineVersions: { repairImageModel: "test-repair-image" } });
  });

  it("uses full-room location markers without prescribing a cylinder, box or catalogue silhouette to the pose model", async () => {
    await run();
    const poseInput = mocks.edit.mock.calls[0]![0];
    const guide = Buffer.from(poseInput.references.find((reference: { role: string }) => reference.role === "spatial_guide").data);
    const originalRoom = (await mocks.read(db, "room")).buffer;
    const expected = await markPoints(originalRoom, request.simplePlacements!.map(placement => placement.placementPoint), 400, 300);
    expect(guide).toEqual(expected);
    expect(guide.equals(originalRoom)).toBe(false);
    const pixels = await sharp(guide).removeAlpha().raw().toBuffer();
    let redMarkerPixels = 0, blueVolumePixels = 0;
    for (let i = 0; i < pixels.length; i += 3) {
      if (pixels[i]! > pixels[i + 1]! + 30 && pixels[i]! > pixels[i + 2]! + 30) redMarkerPixels++;
      if (pixels[i + 2]! > pixels[i]! + 30) blueVolumePixels++;
    }
    expect(redMarkerPixels).toBeGreaterThan(100);
    expect(blueVolumePixels).toBe(0);
    const roomReference = Buffer.from(poseInput.references.find((reference: { role: string }) => reference.role === "room_original").data);
    expect(await sharp(roomReference).removeAlpha().raw().toBuffer()).toEqual(await sharp(originalRoom).removeAlpha().raw().toBuffer());
    expect(Buffer.from(poseInput.references.find((reference: { role: string }) => reference.role === "product_front").data))
      .toEqual((await mocks.read(db, "original-0")).buffer);
    expect(poseInput.prompt).toContain("ONLY of numbered location markers");
    expect(poseInput.prompt).toContain("There is no prescribed cylinder, box or product silhouette to copy");
  });

  it("does not start the lighting image after cancellation during pose generation", async () => {
    const edit = mocks.edit.getMockImplementation()!;
    mocks.edit.mockImplementation(async input => {
      const output = await edit(input);
      if (input.productIsolation) await stopRender(db, renders.rows[0] as unknown as RenderDocument, "cancel");
      return output;
    });
    await expect(run()).rejects.toThrow();
    expect(mocks.edit).toHaveBeenCalledOnce();
    expect(reviewCalls).toBe(0);
    expect(renders.rows[0]!.status).toBe("cancelled");
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("refuses to alter an existing object without the customer's replacement confirmation", async () => {
    const preflight = await mocks.storefrontPreflight();
    preflight.inspections[0] = { ...preflight.inspections[0], obstacleAtPoint: true, obstacleName: "Ancien vase",
      obstacleBox: { xMin: 0.15, yMin: 0.65, xMax: 0.25, yMax: 0.85 } };
    mocks.storefrontPreflight.mockResolvedValue(preflight);
    await expect(run()).rejects.toThrow();
    expect(mocks.edit).not.toHaveBeenCalled();
    expect(reviewCalls).toBe(0);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("keeps the entire tall generated view and apparent base when its bounds exceed the original volume estimate", async () => {
    pose = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="160"><rect x="25" y="20" width="20" height="120" fill="#2850a0"/></svg>')).png().toBuffer();
    const result = await run();
    const render = renders.rows[0] as unknown as RenderDocument;
    const window = (render.placement as { roomEdit: { window: { left: number; top: number; width: number; height: number } } }).roomEdit.window;
    const storedAssets = await Promise.all(mocks.store.mock.results.map(result => result.value));
    const finalAsset = storedAssets.find(asset => `/api/assets/${asset.id}` === result.resultUrl);
    expect(result.status).toBe("succeeded");
    expect(finalAsset).toBeDefined();
    const output = await sharp(finalAsset.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const points: Array<{ x: number; y: number }> = [];
    for (let y = 0; y < output.info.height; y++) for (let x = 0; x < output.info.width; x++) {
      const i = (y * output.info.width + x) * 3;
      if (output.data[i + 2]! > output.data[i]! * 2) points.push({ x, y });
    }
    expect(Math.min(...points.map(point => point.y))).toBe(91);
    expect(Math.max(...points.map(point => point.y))).toBe(240);
    expect(Math.max(...points.map(point => point.x)) - Math.min(...points.map(point => point.x)) + 1).toBe(25);
    expect(window.top).toBeLessThanOrEqual(91);
    expect(window.top + window.height).toBeGreaterThan(240);
  });

  it.each(["opaque", "clipped", "detached"])("rejects an invalid %s pose before MyArchitectAI or QA", async invalid => {
    pose = invalid === "opaque" ? await sharp({ create: { width: 80, height: 80, channels: 3, background: "red" } }).png().toBuffer()
      : await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect x="${invalid === "clipped" ? 0 : 20}" y="20" width="20" height="40" fill="red"/>${invalid === "detached" ? '<rect x="65" y="10" width="4" height="4" fill="green"/>' : ''}</svg>`)).png().toBuffer();
    await expect(run()).rejects.toThrow(/incomplète/);
    expect(mocks.edit).toHaveBeenCalledOnce();
    expect(reviewCalls).toBe(0);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it.each(["perspective", "identity", "unavailable"])("rejects final %s failure without a third image, retry or customer debit", async failure => {
    if (failure === "perspective") remainingRepairableFailures = 10;
    if (failure === "identity") reviewPayload.identityFailure = true;
    if (failure === "unavailable") qualityUnavailable = true;
    await expect(run()).rejects.toThrow();
    expect(mocks.edit).toHaveBeenCalledTimes(2);
    expect(reviewCalls).toBe(1);
    expect(renders.rows[0]!.resultAssetId).toBeUndefined();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it.each(["identity", "duplicate"])("does not deliver a bounded RGB candidate that fails the final %s gate", async failure => {
    const edit = mocks.edit.getMockImplementation()!;
    mocks.edit.mockImplementation(async input => {
      const result = await edit(input);
      if (input.productIsolation) return result;
      const metadata = await sharp(Buffer.from(input.composition)).metadata();
      const changed = await sharp({ create: { width: metadata.width!, height: metadata.height!, channels: 3, background: "#00ff00" } }).png().toBuffer();
      return { ...result, images: [{ data: changed, mimeType: "image/png" }] };
    });
    reviewPayload[failure === "identity" ? "identityFailure" : "duplicateFailure"] = true;
    await expect(run()).rejects.toThrow();
    expect(mocks.edit).toHaveBeenCalledTimes(2);
    expect(reviewCalls).toBe(1);
    expect(renders.rows[0]).toMatchObject({ status: "failed", qualityDecision: { status: "rejected" }, creditCharged: false });
    expect(renders.rows[0]!.resultAssetId).toBeUndefined();
    const storedAssets = await Promise.all(mocks.store.mock.results.map(result => result.value));
    const candidate = storedAssets.find(asset => asset.id === renders.rows[0]!.compositeAssetId);
    expect(candidate.visibility).toEqual({ ownerSessionId: "storefront:visitor-1" });
    const rgb = await sharp(candidate.buffer).removeAlpha().raw().toBuffer();
    let editedProductPixels = 0;
    for (let i = 0; i < rgb.length; i += 3) if (rgb[i + 1]! > rgb[i]! + 100 && rgb[i + 1]! > rgb[i + 2]! + 100) editedProductPixels++;
    expect(editedProductPixels).toBeGreaterThan(100);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("does not follow an uncertain paid pose response with MyArchitectAI", async () => {
    mocks.edit.mockResolvedValueOnce({ provider: "openai", model: "test-repair-image", status: "failed", durationMs: 1,
      estimatedCostUsd: 0.1, attemptCount: 1, images: [], safety: { blocked: false },
      error: { code: "timeout", message: "Réponse perdue", retryable: true } });
    await expect(run()).rejects.toThrow();
    expect(mocks.edit).toHaveBeenCalledOnce();
    expect(reviewCalls).toBe(0);
    expect(attempts.rows.some(row => row.provider === "openai" && row.usageOutcome === "unknown")).toBe(true);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("does not repeat either image after an uncertain lighting response", async () => {
    const edit = mocks.edit.getMockImplementation()!;
    mocks.edit.mockImplementation(async input => input.productIsolation ? edit(input) : {
      provider: "myarchitectai", model: "edit-by-prompt", status: "failed", durationMs: 1,
      estimatedCostUsd: 0.03, attemptCount: 1, images: [], safety: { blocked: false },
      error: { code: "timeout", message: "Réponse perdue", retryable: true },
    });
    await expect(run()).rejects.toThrow();
    expect(mocks.edit).toHaveBeenCalledTimes(2);
    expect(reviewCalls).toBe(0);
    expect(attempts.rows.some(row => row.provider === "myarchitectai" && row.usageOutcome === "unknown")).toBe(true);
    expect(renders.rows[0]!.resultAssetId).toBeUndefined();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("never publishes or charges an insertion accepted after the three-minute deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    reviewPayload.advanceClockMs = 180_000;
    await expect(run()).rejects.toThrow(/délai|minutes/);
    expect(mocks.edit).toHaveBeenCalledTimes(2);
    expect(reviewCalls).toBe(1);
    expect(renders.rows[0]!.resultAssetId).toBeUndefined();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("checks the total pose, contact and review budget before the first paid image", async () => {
    mocks.config.storefrontImageModel = "gpt-image-2.5-sunburst-2026-09-08";
    vi.stubEnv("RENDER_MAX_COST_USD", "0.4");
    await expect(run()).rejects.toThrow(/Budget/);
    expect(mocks.edit).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });
});

describe.each(["v4", "v5", "v6"] as const)("public hybrid %s local opaque refinement selected before either paid image", version => {
  let myArchitectImage: Buffer;
  let pose: Buffer;
  beforeEach(async () => {
    mocks.config.simplePointImageProvider = "myarchitectai";
    request.simplePlacements = request.simplePlacements!.slice(0, 1);
    request.simplePlacements[0]!.dimensionPair = { mode: "height_length", heightCm: 14, lengthCm: 14 };
    await products.updateOne({ id: "p0" }, { $set: { heightCm: 14, widthCm: 14, depthCm: 14 } });
    await scenes.updateOne({ id: "scene" }, { $set: { publicSessionId: "storefront:visitor-1" } });
    pose = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect x="20" y="25" width="20" height="35" fill="#2850a0"/><rect x="27" y="17" width="6" height="8" fill="#1e3c78"/></svg>')).png().toBuffer();
    mocks.edit.mockImplementation(async input => {
      const openai = input.productIsolation || input.storefrontRoomRefinement;
      let image = input.composition;
      if (input.productIsolation) image = pose;
      else if (!openai) {
        // A distinct provider output proves that OpenAI receives the generated
        // room, not a newly composed cutout or the original scene.
        const size = await sharp(Buffer.from(input.composition)).metadata();
        myArchitectImage = await sharp({ create: { width: size.width!, height: size.height!, channels: 3, background: "#426586" } }).webp({ lossless: true }).toBuffer();
        image = myArchitectImage;
      }
      return { provider: openai ? "openai" : "myarchitectai", model: openai ? "test-repair-image" : "edit-by-prompt",
        status: "succeeded", durationMs: 1, estimatedCostUsd: openai ? 0.1 : 0.03, attemptCount: 1,
        images: [{ data: image, mimeType: input.productIsolation ? "image/png" : "image/webp" }], safety: { blocked: false } };
    });
  });
  const run = () => runHybridVersion(version);
  async function setDimensions(width: number, height: number, depth = 1) {
    request.simplePlacements![0]!.dimensionPair = { mode: "height_length", heightCm: height, lengthCm: width };
    await products.updateOne({ id: "p0" }, { $set: { widthCm: width, heightCm: height, depthCm: depth } });
  }
  async function setObstacle() {
    const preflight = await mocks.storefrontPreflight.getMockImplementation()!();
    preflight.inspections[0] = { ...preflight.inspections[0], obstacleAtPoint: true, obstacleName: "Ancien vase",
      obstacleBox: { xMin: 0.15, yMin: 0.65, xMax: 0.25, yMax: 0.85 } };
    mocks.storefrontPreflight.mockResolvedValue(preflight);
  }

  it("feeds the real MyArchitect image into one masked OpenAI edit, then performs the sole strict final review", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const started = Date.now();
    const edit = mocks.edit.getMockImplementation()!;
    mocks.edit.mockImplementation(async input => {
      expect(reviewCalls).toBe(0);
      expect(mocks.storefrontPreflight).toHaveBeenCalled();
      return edit(input);
    });
    const result = await run();
    expect(result.status).toBe("succeeded");
    expect(mocks.edit).toHaveBeenCalledTimes(2);
    const [draft, refinement] = mocks.edit.mock.calls.map(call => call[0]);
    expect(draft).toMatchObject({ operation: "storefront_integration", idempotencyKey: `${request.idempotencyKey}:room-image-${version}` });
    expect(draft.productIsolation).toBeUndefined();
    expect(draft.generateProductView).toBeUndefined();
    expect(draft.references.map((ref: { role: string }) => ref.role)).toEqual(["composition"]);
    expect(draft.deadlineMs).toBe(started + 60_000);
    expect(refinement).toMatchObject({ storefrontRoomRefinement: true, quality: "high", size: "1536x1024",
      idempotencyKey: `${request.idempotencyKey}:room-refine-${version}` });
    expect(refinement.productIsolation).toBeUndefined();
    expect(refinement.generateProductView).toBeUndefined();
    expect(refinement.deadlineMs).toBe(started + 180_000);
    const refs = refinement.references;
    expect(refs.map((ref: { role: string }) => ref.role)).toEqual(version === "v6"
      ? ["composition", "product_front", "placement_guide", "spatial_guide"] : ["composition", "product_front", "spatial_guide"]);
    expect(refinement.storefrontRoomRefinementContactGuide === true).toBe(version === "v6");
    expect(refs[0].mimeType).toBe("image/png");
    expect(await sharp(Buffer.from(refs[0].data)).removeAlpha().raw().toBuffer())
      .toEqual(await sharp(myArchitectImage).removeAlpha().raw().toBuffer());
    expect(Buffer.from(refs[1].data)).toEqual((await mocks.read(db, "original-0")).buffer);
    expect(await sharp(Buffer.from(refs.at(-1).data)).metadata()).toMatchObject({ width: 400, height: 300 });
    const base = await sharp(Buffer.from(refs[0].data)).metadata();
    if (version === "v6") {
      expect(refs[2].mimeType).toBe("image/png");
      expect(await sharp(Buffer.from(refs[2].data)).metadata()).toMatchObject({ format: "png", width: base.width, height: base.height });
      expect(Buffer.from(refs[2].data).equals(Buffer.from(refs[0].data))).toBe(false);
    }
    expect(await sharp(Buffer.from(refinement.targetMask.data)).metadata()).toMatchObject({ format: "png", width: base.width, height: base.height });
    expect(reviewCalls).toBe(1);
    expect(renders.rows[0]).toMatchObject({ provider: "openai", model: "test-repair-image", attemptCount: 2,
      modelChain: [{ provider: "myarchitectai", role: "perspective_edit" }, { provider: "openai", role: "room_refinement" },
        { provider: "openai", role: "reference_scale_and_realism_review" }], qualityDecision: { status: "accepted" } });
    const steps = vi.mocked(durableStep).mock.calls.map(call => call[1]);
    expect(steps).toEqual(expect.arrayContaining([`preflight-${version}`, `room-image-${version}`, `room-refine-${version}`, `preview-${version}`, `review-${version}`]));
    expect(steps).not.toContain(`room-repair-${version}`);
    expect(steps).not.toContain(`pose-responses-${version}`);
    expect(mocks.storefrontPreflight.mock.calls[0]![0].deadlineMs).toBe(started + (version !== "v4" ? 35_000 : 25_000));
    expect(mocks.storefrontPreflight.mock.calls[0]![0].timeoutMs).toBe(version !== "v4" ? 35_000 : undefined);
    expect(mocks.capture).toHaveBeenCalledOnce();
    const replay = await run();
    expect(replay.id).toBe(result.id);
    expect(mocks.edit).toHaveBeenCalledTimes(2);
    expect(mocks.capture).toHaveBeenCalledOnce();
  });

  it.each([[25.2, 20, true], [25.6, 20, false], [30, 14, false], [10, 30, false]])(
    "requires both projected axes below 64px before choosing local refinement (%i×%i cm)", async (width, height, local) => {
      await setDimensions(width, height);
      await run();
      const [first, second] = mocks.edit.mock.calls.map(call => call[0]);
      expect(first.productIsolation === true).toBe(!local);
      expect(second.storefrontRoomRefinement === true).toBe(local);
      expect(first.generateProductView === true).toBe(!local);
      expect(reviewCalls).toBe(1);
      expect(mocks.edit).toHaveBeenCalledTimes(2);
      if (!local) {
        const keys = vi.mocked(durableStep).mock.calls.map(call => call[1]);
        expect(keys).toEqual(expect.arrayContaining([`pose-responses-${version}`, `harmonize-${version}`]));
        expect(keys).not.toContain(`room-refine-${version}`);
      }
    },
  );

  it("applies the versioned image frame and scales every pixel contract exactly once when MyArchitect returns a larger raster", async () => {
    const edit = mocks.edit.getMockImplementation()!;
    mocks.edit.mockImplementation(async input => {
      const result = await edit(input);
      if (input.storefrontRoomRefinement) return result;
      const source = await sharp(Buffer.from(result.images[0].data)).metadata();
      myArchitectImage = await sharp(Buffer.from(result.images[0].data)).resize({ width: source.width! * 4, kernel: "nearest" }).webp({ lossless: true }).toBuffer();
      return { ...result, images: [{ data: myArchitectImage, mimeType: "image/webp" }] };
    });
    await run();
    const [draft, refinement] = mocks.edit.mock.calls.map(call => call[0]);
    const oldFrame = await sharp(Buffer.from(draft.composition)).metadata();
    const image = refinement.references[0];
    const actual = await sharp(Buffer.from(image.data)).metadata();
    const scale = version !== "v4" ? 4 : 1;
    expect(actual).toMatchObject({ format: "png", width: oldFrame.width! * scale, height: oldFrame.height! * scale });
    expect(await sharp(Buffer.from(refinement.targetMask.data)).metadata()).toMatchObject({ format: "png", width: actual.width, height: actual.height });
    const mask = await sharp(Buffer.from(refinement.targetMask.data)).ensureAlpha().extractChannel(3).raw().toBuffer();
    expect(new Set(mask)).toEqual(new Set([0, 255]));
    if (version !== "v4") {
      expect(await sharp(Buffer.from(image.data)).removeAlpha().raw().toBuffer())
        .toEqual(await sharp(myArchitectImage).removeAlpha().raw().toBuffer());
      const initialContract = JSON.parse(draft.prompt.split("scale proportionally if output size differs): ")[1].split("}.\n")[0] + "}");
      const nativeContract = JSON.parse(refinement.prompt.split("NATIVE IMAGE1 CONTRACT: ")[1].split(". All contactPixel")[0]);
      expect(nativeContract.frame).toEqual({ width: actual.width, height: actual.height });
      expect(nativeContract.sourcePixelsToCanvasScale).toBe(4);
      expect(nativeContract.contactPixel).toEqual({ x: initialContract.contactPixel.x * 4, y: initialContract.contactPixel.y * 4 });
      expect(nativeContract.physicalWidthPx).toBe(initialContract.physicalWidthPx * 4);
      expect(nativeContract.physicalHeightPx).toBe(initialContract.physicalHeightPx * 4);
      expect(nativeContract.originalFrame).toEqual({ width: 400, height: 300 });
      const normalized = JSON.parse(refinement.prompt.split("NORMALIZED PLACEMENT IN IMAGE1 (fractions of canvas width/height): ")[1].split("}. ")[0] + "}");
      expect(normalized.contact.x).toBeCloseTo(initialContract.contactPixel.x / oldFrame.width!);
      expect(normalized.contact.y).toBeCloseTo(initialContract.contactPixel.y / oldFrame.height!);
      expect(normalized.productWidth).toBeCloseTo(initialContract.physicalWidthPx / oldFrame.width!);
      expect(refinement.prompt).toContain(version === "v6" ? "sole output canvas" : "sole output-canvas authority");
    } else {
      expect(refinement.prompt).toContain("INPUT FRAME AND PLACEMENT CONTRACT:");
      expect(refinement.prompt).not.toContain("NATIVE IMAGE1 CONTRACT:");
    }
  });

  it("does not choose replacement merely because the user enabled it when the target is empty", async () => {
    await setDimensions(30, 30);
    request.replaceExisting = true;
    await run();
    expect(mocks.edit.mock.calls[0]![0].generateProductView).toBe(true);
    expect(mocks.edit.mock.calls[1]![0].storefrontRoomRefinement).toBeUndefined();
  });

  if (version !== "v4") it("retains the fractional 30.8px grenade width when mapping the real local frame into a 1024px provider image", async () => {
    const room = await sharp({ create: { width: 736, height: 736, channels: 3, background: "#dddddd" } }).webp({ lossless: true }).toBuffer();
    const read = mocks.read.getMockImplementation()!;
    mocks.read.mockImplementation(async (...args) => args[1] === "room" ? { asset: { id: "room", contentType: "image/webp" }, buffer: room } : read(...args));
    await scenes.updateOne({ id: "scene" }, { $set: { widthPx: 736, heightPx: 736 } });
    request.simplePlacements![0]!.placementPoint = { x: 574 / 736, y: 456 / 736 };
    const evidence = await mocks.storefrontPreflight.getMockImplementation()!();
    mocks.storefrontPreflight.mockResolvedValue({ ...evidence,
      spans: [{ pixelsPerCm: 1.8, scaleSource: "vision", confidence: "high" }], widthPixelsPerCm: [2.2],
      poses: [{ cameraElevationDegrees: 48, cameraRollDegrees: 3, evidence: "visible support" }],
    });
    const native = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#426586" } }).webp({ lossless: true }).toBuffer();
    const edit = mocks.edit.getMockImplementation()!;
    mocks.edit.mockImplementation(async input => {
      const result = await edit(input);
      return input.storefrontRoomRefinement ? result : { ...result, images: [{ data: native, mimeType: "image/webp" }] };
    });
    await run();
    const [draft, refinement] = mocks.edit.mock.calls.map(call => call[0]);
    const sourceFrame = await sharp(Buffer.from(draft.composition)).metadata();
    expect(sourceFrame.width).toBe(sourceFrame.height);
    const scale = 1024 / sourceFrame.width!;
    const nativeContract = JSON.parse(refinement.prompt.split("NATIVE IMAGE1 CONTRACT: ")[1].split(". All contactPixel")[0]);
    expect(nativeContract.frame).toEqual({ width: 1024, height: 1024 });
    expect(nativeContract.sourcePixelsToCanvasScale).toBe(scale);
    expect(nativeContract.physicalWidthPx).toBeCloseTo(30.8 * scale, 10);
    expect(nativeContract.physicalWidthPx).not.toBeCloseTo(31 * scale, 2);
    const point = nativeContract.contactPixel;
    expect(point.x).toBeCloseTo((574 - nativeContract.window.left) * scale + nativeContract.padding.x, 9);
    expect(point.y).toBeCloseTo((456 - nativeContract.window.top) * scale + nativeContract.padding.y, 9);
    expect(await sharp(Buffer.from(refinement.references[0].data)).metadata()).toMatchObject({ format: "png", width: 1024, height: 1024 });
    expect(await sharp(Buffer.from(refinement.targetMask.data)).metadata()).toMatchObject({ format: "png", width: 1024, height: 1024 });
    const sentPixels = await sharp(Buffer.from(refinement.references[0].data)).removeAlpha().raw().toBuffer();
    const nativePixels = await sharp(native).removeAlpha().raw().toBuffer();
    expect(sentPixels.equals(nativePixels)).toBe(true);
    if (version === "v6") {
      const guide = refinement.references.find((item: { role: string }) => item.role === "placement_guide");
      const pixels = await sharp(Buffer.from(guide.data)).removeAlpha().raw().toBuffer();
      const sample = (x: number, y: number) => [...pixels.subarray((Math.round(y) * 1024 + Math.round(x)) * 3, (Math.round(y) * 1024 + Math.round(x)) * 3 + 3)];
      const red = sample(point.x, point.y);
      expect(red[0]).toBeGreaterThan(180);
      expect(red[1]).toBeLessThan(80);
      expect(red[2]).toBeLessThan(90);
      for (const x of [point.x - nativeContract.physicalWidthPx / 2, point.x + nativeContract.physicalWidthPx / 2]) {
        const blue = sample(x, point.y);
        expect(blue[0]).toBeLessThan(70);
        expect(blue[2]).toBeGreaterThan(150);
      }
    }
  });

  it("uses the admitted OpenAI model even if configuration changes during MyArchitectAI", async () => {
    const edit = mocks.edit.getMockImplementation()!;
    mocks.edit.mockImplementation(async input => {
      const result = await edit(input);
      if (!input.storefrontRoomRefinement) mocks.config.storefrontImageModel = "changed-after-first-image";
      return result;
    });
    await run();
    expect(selectEditingProvider).toHaveBeenCalledWith("insert", "final", "openai", "test-repair-image");
    expect(renders.rows[0]).toMatchObject({ engineVersions: { repairImageModel: "test-repair-image" } });
  });

  it("routes a confirmed detected replacement through local editing even for a large product", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const started = Date.now();
    await setDimensions(30, 30);
    request.replaceExisting = true;
    await setObstacle();
    await run();
    expect(mocks.storefrontPreflight.mock.calls[0]![0].deadlineMs).toBe(started + (version === "v6" ? 45_000 : version === "v5" ? 35_000 : 25_000));
    expect(mocks.storefrontPreflight.mock.calls[0]![0].timeoutMs).toBe(version === "v6" ? 45_000 : version === "v5" ? 35_000 : undefined);
    expect(mocks.edit.mock.calls[0]![0].productIsolation).toBeUndefined();
    expect(mocks.edit.mock.calls[1]![0].storefrontRoomRefinement).toBe(true);
    expect(reviewCalls).toBe(1);
    expect(mocks.capture).toHaveBeenCalledOnce();
  });

  it("rejects an unconfirmed obstacle before either image provider runs", async () => {
    await setObstacle();
    await expect(run()).rejects.toThrow();
    expect(mocks.edit).not.toHaveBeenCalled();
    expect(reviewCalls).toBe(0);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it.each(["perspective", "contact", "supportIntegration", "identity", "position", "noDuplicate"])(
    "withholds a final %s failure without a third image, weakened quality gate or credit capture", async gate => {
      reviewPayload.gateFailure = gate;
      await expect(run()).rejects.toThrow();
      expect(mocks.edit).toHaveBeenCalledTimes(2);
      expect(reviewCalls).toBe(1);
      expect(renders.rows[0]).toMatchObject({ provider: "openai", model: "test-repair-image", qualityDecision: { status: "rejected" } });
      expect(renders.rows[0]!.resultAssetId).toBeUndefined();
      expect(mocks.capture).not.toHaveBeenCalled();
      expect(mocks.release).toHaveBeenCalledOnce();
    },
  );

  it("rejects a physical base shifted by ten room pixels even if all visual scores pass", async () => {
    reviewPayload.contactShiftY = 10 / 300;
    await expect(run()).rejects.toThrow();
    expect(mocks.edit).toHaveBeenCalledTimes(2);
    expect(reviewCalls).toBe(1);
    expect(renders.rows[0]!.qualityDecision).toMatchObject({ status: "rejected" });
    expect(renders.rows[0]!.resultAssetId).toBeUndefined();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("rejects visible remnants of the confirmed old object after the only final review", async () => {
    request.replaceExisting = true;
    await setObstacle();
    reviewPayload.replacementFailure = true;
    await expect(run()).rejects.toThrow();
    expect(mocks.edit).toHaveBeenCalledTimes(2);
    expect(reviewCalls).toBe(1);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(renders.rows[0]!.resultAssetId).toBeUndefined();
  });

  it.each(["myarchitectai", "openai"])("does not replay an uncertain %s result or switch back to alpha generation", async provider => {
    const edit = mocks.edit.getMockImplementation()!;
    mocks.edit.mockImplementation(async input => (input.storefrontRoomRefinement ? "openai" : "myarchitectai") !== provider ? edit(input) : ({
      provider, model: provider === "openai" ? "test-repair-image" : "edit-by-prompt", status: "failed", durationMs: 1,
      estimatedCostUsd: provider === "openai" ? 1 : 0.03, attemptCount: 1, images: [], safety: { blocked: false },
      error: { code: "timeout", message: "Réponse perdue", retryable: true },
    }));
    await expect(run()).rejects.toThrow();
    expect(mocks.edit).toHaveBeenCalledTimes(provider === "myarchitectai" ? 1 : 2);
    expect(reviewCalls).toBe(0);
    expect(mocks.edit.mock.calls.some(call => call[0].productIsolation)).toBe(false);
    expect(attempts.rows.some(row => row.provider === provider && row.usageOutcome === "unknown")).toBe(true);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it.each(["myarchitectai", "openai"])("does not repeat a throttled %s image even when its adapter marks it retryable", async provider => {
    const edit = mocks.edit.getMockImplementation()!;
    mocks.edit.mockImplementation(async input => (input.storefrontRoomRefinement ? "openai" : "myarchitectai") !== provider ? edit(input) : ({
      provider, model: provider === "openai" ? "test-repair-image" : "edit-by-prompt", status: "failed", durationMs: 1,
      estimatedCostUsd: 0, attemptCount: 1, images: [], safety: { blocked: false },
      error: { code: "http_429", message: "Service temporairement saturé", retryable: true },
    }));
    await expect(run()).rejects.toThrow();
    expect(mocks.edit).toHaveBeenCalledTimes(provider === "myarchitectai" ? 1 : 2);
    expect(reviewCalls).toBe(0);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("rechecks the remaining spending allowance before OpenAI when the first provider consumed it", async () => {
    const edit = mocks.edit.getMockImplementation()!;
    mocks.edit.mockImplementation(async input => {
      const result = await edit(input);
      if (!input.storefrontRoomRefinement) vi.stubEnv("RENDER_MAX_COST_USD", "0.02");
      return result;
    });
    await expect(run()).rejects.toThrow(/Budget/);
    expect(mocks.edit).toHaveBeenCalledOnce();
    expect(reviewCalls).toBe(0);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("does not spend the second image after cancellation during MyArchitectAI", async () => {
    const edit = mocks.edit.getMockImplementation()!;
    mocks.edit.mockImplementation(async input => {
      const result = await edit(input);
      await stopRender(db, renders.rows[0] as unknown as RenderDocument, "cancel");
      return result;
    });
    await expect(run()).rejects.toThrow();
    expect(mocks.edit).toHaveBeenCalledOnce();
    expect(reviewCalls).toBe(0);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("reserves both images and strict final QA before paying MyArchitectAI", async () => {
    mocks.config.storefrontImageModel = "gpt-image-2.5-sunburst-2026-09-08";
    vi.stubEnv("RENDER_MAX_COST_USD", "0.5");
    await expect(run()).rejects.toThrow(/Budget/);
    expect(mocks.edit).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("never publishes or captures a credit for a review completed after 180 seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    reviewPayload.advanceClockMs = 180_000;
    await expect(run()).rejects.toThrow(/délai|minutes/);
    expect(mocks.edit).toHaveBeenCalledTimes(2);
    expect(reviewCalls).toBe(1);
    expect(renders.rows[0]!.resultAssetId).toBeUndefined();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});

describe("simple render orchestration with offline providers — MyArchitectAI routing", () => {
it("keeps MyArchitectAI behind visual admission before reserving or spending", async () => {
    mocks.config.simplePointImageProvider = "myarchitectai";
    mocks.config.openaiApiKey = "";
    request.simplePlacements = request.simplePlacements!.slice(0, 1);
    await expect(createRender(db, "org", request)).rejects.toThrow(
      /contrôle visuel/,
    );
    expect(renders.rows).toHaveLength(0);
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.edit).not.toHaveBeenCalled();
  });
it("routes multiple objects to OpenAI before admission when MyArchitectAI handles single products", async () => {
    mocks.config.simplePointImageProvider = "myarchitectai";
    await createRender(db, "org", request);
    expect(renders.rows[0]).toMatchObject({
      status: "succeeded",
      provider: "openai",
      engineVersions: { editProvider: "openai", editModel: "test-image" },
    });
    expect(mocks.edit).toHaveBeenCalledOnce();
    expect(mocks.edit.mock.calls[0]![0].operation).toBeUndefined();
    expect(mocks.edit.mock.calls[0]![0].references.length).toBeGreaterThan(2);
  });
it("accounts each target inspection before another object can spend the remaining budget", async () => {
    vi.stubEnv("RENDER_MAX_COST_USD", "0.035");
    try {
      await expect(createRender(db, "org", request)).rejects.toThrow(/Budget du rendu/);
      const inspections = vi.mocked(fetch).mock.calls.filter(([, init]) =>
        JSON.parse(String(init?.body)).text?.format?.name === "scene_obstacle_inspection",
      );
      expect(inspections).toHaveLength(1);
      expect(attempts.rows.filter((row) => row.stage === "inspecting_target")).toHaveLength(1);
      expect(mocks.edit).not.toHaveBeenCalled();
      expect(mocks.capture).not.toHaveBeenCalled();
      expect(mocks.release).toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
it("refuses multiple objects before reservation when their OpenAI image service is disabled", async () => {
    mocks.config.simplePointImageProvider = "myarchitectai";
    mocks.config.openAIImageEnabled = false;
    await expect(createRender(db, "org", request)).rejects.toThrow(
      /OpenAI.*pas activé/,
    );
    expect(renders.rows).toHaveLength(0);
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.edit).not.toHaveBeenCalled();
  });
it("uses MyArchitectAI for a single product and still requires the visual review", async () => {
    mocks.config.simplePointImageProvider = "myarchitectai";
    request.simplePlacements = request.simplePlacements!.slice(0, 1);
    await createRender(db, "org", request);
    expect(mocks.edit).toHaveBeenCalledOnce();
    const imageRequest = mocks.edit.mock.calls[0]![0];
    expect(imageRequest.operation).toBe("oriented_harmonization");
    expect(imageRequest.references.map((reference: { role: string }) => reference.role)).toEqual(["composition"]);
    expect(imageRequest.prompt).not.toMatch(/image\s*(?:2|two)/i);
    expect(reviewCalls).toBeGreaterThan(0);
    expect(renders.rows[0]).toMatchObject({
      status: "succeeded",
      provider: "myarchitectai",
      engineVersions: {
        editProvider: "myarchitectai",
        editModel: "edit-by-prompt",
        visionModel: "test-vision",
        prompt: "simple-myarchitectai-harmonization-v1",
      },
    });
    expect(mocks.capture).toHaveBeenCalledOnce();
  });
it("rejects a MyArchitectAI candidate when the identity review fails", async () => {
    mocks.config.simplePointImageProvider = "myarchitectai";
    request.simplePlacements = request.simplePlacements!.slice(0, 1);
    reviewPayload.identityFailure = true;
    await expect(createRender(db, "org", request)).rejects.toThrow();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalled();
  });
it("settles a failed MyArchitectAI render with only OpenAI vision enabled", async () => {
    mocks.config.simplePointImageProvider = "myarchitectai";
    mocks.config.openAIImageEnabled = false;
    request.simplePlacements = request.simplePlacements!.slice(0, 1);
    expect(() => selectEditingProvider("insert", "final")).toThrow(
      /No default image provider/,
    );
    mocks.edit.mockResolvedValueOnce({
      provider: "myarchitectai",
      model: "edit-by-prompt",
      status: "failed",
      durationMs: 1,
      estimatedCostUsd: 0,
      attemptCount: 1,
      images: [],
      error: {
        code: "provider_error",
        message: "MyArchitectAI test refusal",
        retryable: false,
      },
      safety: { blocked: false },
    });

    await expect(createRender(db, "org", request)).rejects.toThrow(
      "MyArchitectAI test refusal",
    );
    expect(renders.rows[0]).toMatchObject({
      status: "failed",
      pipelineState: "failed",
      error: "MyArchitectAI test refusal",
      creditCharged: false,
    });
    expect(attempts.rows.find((row) => row.stage === "failed")).toMatchObject({
      provider: "myarchitectai",
      model: "edit-by-prompt",
    });
    expect(mocks.reserve).toHaveBeenCalledOnce();
    expect(mocks.edit).toHaveBeenCalledOnce();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});


describe("public visual placement v9 uses a declared pixel target directly", () => {
  beforeEach(async () => {
    mocks.config.simplePointImageProvider = "myarchitectai";
    request.simplePlacements = request.simplePlacements!.slice(0, 1);
    request.simplePlacements[0]!.visualWidthNormalized = 0.04;
    await scenes.updateOne({ id: "scene" }, { $set: { publicSessionId: "storefront:visitor-1" } });
    const pose = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect x="20" y="20" width="20" height="40" fill="#2850a0"/></svg>')).png().toBuffer();
    mocks.edit.mockImplementation(async input => ({
      provider: input.productIsolation || input.storefrontRoomRefinement ? "openai" : "myarchitectai",
      model: input.productIsolation || input.storefrontRoomRefinement ? "test-repair-image" : "edit-by-prompt",
      status: "succeeded", durationMs: 1, estimatedCostUsd: 0.1, attemptCount: 1,
      images: [{ data: input.productIsolation ? pose : input.composition, mimeType: input.productIsolation ? "image/png" : "image/webp" }],
      safety: { blocked: false },
    }));
  });
  const run = () => createRender(db, "org", structuredClone(request), "storefront:visitor-1");

  it("starts both image providers without the slow scale/support preflight, with unknown camera and a frozen v9 snapshot", async () => {
    mocks.storefrontPreflight.mockRejectedValue(new Error("This mandatory analysis would time out."));
    const result = await run();
    expect(result.status).toBe("succeeded");
    expect(mocks.storefrontPreflight).not.toHaveBeenCalled();
    expect(mocks.edit).toHaveBeenCalledTimes(2);
    expect(renders.rows[0]).toMatchObject({ engineVersions: { prompt: "storefront-myarchitect-room-v9" },
      requestSnapshot: { input: { simplePlacements: [{ visualWidthNormalized: 0.04 }] } },
      audit: { scaleSources: ["visual_size"], scaleFallbackFired: false } });
    expect(mocks.edit.mock.calls[1]![0].prompt).toContain("not a physical measurement");
    expect(mocks.edit.mock.calls[1]![0].prompt).toContain('"elevationDegrees":null');
    const steps = vi.mocked(durableStep).mock.calls.map(call => call[1]);
    expect(steps).toContain("manual-placement-v9");
    expect(steps).not.toContain("preflight-v9");
    expect(reviewCalls).toBe(1);
    expect(mocks.capture).toHaveBeenCalledOnce();
  });

  it("uses the exact confirmed replacement box and final replacement QA without asking for a visible empty support", async () => {
    request.replaceExisting = true;
    request.replacementRegion = { xMin: 0.05, yMin: 0.25, xMax: 0.75, yMax: 0.85 };
    const result = await run();
    expect(result.status).toBe("succeeded");
    expect(mocks.storefrontPreflight).not.toHaveBeenCalled();
    expect(mocks.edit).toHaveBeenCalledTimes(3);
    const [cleanup, pose, contact] = mocks.edit.mock.calls.map(call => call[0]);
    expect(cleanup.prompt).toContain("FULL ORIGINAL ROOM");
    expect(cleanup.prompt).toContain(JSON.stringify({ xMin: (0.05 * 400 + 25) / 450, yMin: 0.25,
      xMax: (0.75 * 400 + 25) / 450, yMax: 0.85 }));
    expect(cleanup.prompt).toContain('"left":25,"top":0,"width":400,"height":300');
    expect(cleanup.references.map((reference: { role: string }) => reference.role)).toEqual(["composition"]);
    expect(await sharp(Buffer.from(cleanup.composition)).metadata()).toMatchObject({ width: 450, height: 300 });
    expect(pose).toMatchObject({ productIsolation: true, productIsolationCameraFirst: true, generateProductView: true });
    expect(await sharp(Buffer.from(pose.composition)).metadata()).toMatchObject({ width: 400, height: 300 });
    expect(contact.prompt).not.toContain("Remove only");
    expect(mocks.edit.mock.calls.some(call => call[0].storefrontRoomRefinement)).toBe(false);
    expect(renders.rows[0]).toMatchObject({ engineVersions: { prompt: "storefront-myarchitect-replacement-v11" },
      modelChain: expect.arrayContaining([{ provider: "myarchitectai", model: "edit-by-prompt", role: "confirmed_object_removal" },
        { provider: "openai", model: "test-repair-image", role: "isolated_product_pose" },
        { provider: "myarchitectai", model: "edit-by-prompt", role: "contact_lighting" }]) });
    const steps = vi.mocked(durableStep).mock.calls.map(call => call[1]);
    expect(steps).toEqual(expect.arrayContaining(["manual-placement-v11", "replacement-clean-v11", "replacement-background-v11",
      "pose-responses-v11", "harmonize-v11", "review-v11"]));
    expect(steps).not.toContain("room-refine-v11");
    expect(renders.rows[0]!.placement).toMatchObject({ replacementRegion: request.replacementRegion,
      replacedTargets: [{ objectIndex: 0, name: "objet sélectionné" }] });
    expect((renders.rows[0] as unknown as RenderDocument).qualityDecision!.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "replacement_complete" })]));
  });

  it("preserves the admitted v10 unpadded cleanup and never reads v11 image checkpoints", async () => {
    request.replaceExisting = true;
    request.replacementRegion = { xMin: 0.05, yMin: 0.25, xMax: 0.75, yMax: 0.85 };
    expect((await runHybridVersion("v10")).status).toBe("succeeded");
    expect(mocks.edit).toHaveBeenCalledTimes(3);
    const cleanup = mocks.edit.mock.calls[0]![0];
    expect(await sharp(Buffer.from(cleanup.composition)).metadata()).toMatchObject({ width: 400, height: 300 });
    expect(cleanup.prompt).toContain(JSON.stringify(request.replacementRegion));
    const steps = vi.mocked(durableStep).mock.calls.map(call => call[1]);
    expect(steps).toContain("replacement-clean-v10");
    expect(steps).not.toContain("replacement-clean-v11");
  });

  it("preserves the frozen v9 replacement path and never starts v10 cleanup for an old job", async () => {
    request.replaceExisting = true;
    request.replacementRegion = { xMin: 0.05, yMin: 0.25, xMax: 0.75, yMax: 0.85 };
    expect((await runHybridVersion("v9")).status).toBe("succeeded");
    expect(mocks.edit).toHaveBeenCalledTimes(2);
    expect(mocks.edit.mock.calls[1]![0].storefrontRoomRefinement).toBe(true);
    const steps = vi.mocked(durableStep).mock.calls.map(call => call[1]);
    expect(steps).toContain("room-refine-v9");
    expect(steps).not.toContain("replacement-clean-v11");
  });

  it.each(["cleanup", "pose", "contact"])("never proceeds or repeats images after an uncertain v11 %s", async failedStage => {
    request.replaceExisting = true;
    request.replacementRegion = { xMin: 0.05, yMin: 0.25, xMax: 0.75, yMax: 0.85 };
    const edit = mocks.edit.getMockImplementation()!;
    let calls = 0;
    const failureIndex = failedStage === "cleanup" ? 1 : failedStage === "pose" ? 2 : 3;
    mocks.edit.mockImplementation(async input => ++calls !== failureIndex ? edit(input) : ({
      provider: input.productIsolation ? "openai" : "myarchitectai", model: input.productIsolation ? "test-repair-image" : "edit-by-prompt",
      status: "failed", durationMs: 1, estimatedCostUsd: 0.03, attemptCount: 1, images: [], safety: { blocked: false },
      error: { code: "timeout", message: "Réponse perdue", retryable: true },
    }));
    await expect(run()).rejects.toThrow();
    expect(mocks.edit).toHaveBeenCalledTimes(failureIndex);
    expect(reviewCalls).toBe(0);
    expect(attempts.rows.some(row => row.usageOutcome === "unknown")).toBe(true);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(renders.rows[0]!.resultAssetId).toBeUndefined();
  });

  it("does not start an isolated pose or charge when cleanup exhausts the three-minute deadline", async () => {
    request.replaceExisting = true;
    request.replacementRegion = { xMin: 0.05, yMin: 0.25, xMax: 0.75, yMax: 0.85 };
    vi.useFakeTimers({ toFake: ["Date"] });
    const edit = mocks.edit.getMockImplementation()!;
    mocks.edit.mockImplementation(async input => {
      const result = await edit(input);
      vi.setSystemTime(Date.now() + 180_000);
      return result;
    });
    await expect(run()).rejects.toThrow(/délai|minutes/);
    expect(mocks.edit).toHaveBeenCalledOnce();
    expect(reviewCalls).toBe(0);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("keeps a geometry-only rejected v11 replacement private and uncharged", async () => {
    request.replaceExisting = true;
    request.replacementRegion = { xMin: 0.05, yMin: 0.25, xMax: 0.75, yMax: 0.85 };
    reviewPayload.gateFailure = "contact";
    await expect(run()).rejects.toThrow();
    const row = renders.rows[0] as unknown as RenderDocument;
    expect(row.status).toBe("failed");
    expect(row.creditCharged).toBe(false);
    expect(row.resultAssetId).toBeUndefined();
    expect(renderResponse(row).adjustmentPreviewUrl).toBe(`/api/assets/${row.compositeAssetId}`);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.edit).toHaveBeenCalledTimes(3);
  });

  it("retains explicit detection when replacement is requested without a confirmed manual box", async () => {
    request.replaceExisting = true;
    await run();
    expect(mocks.storefrontPreflight).toHaveBeenCalledOnce();
  });

  it.each(["scale", "perspective", "contact", "position", "supportIntegration"])(
    "shows an owner-only adjustment candidate for %s while refusing the final and releasing its credit", async gate => {
      reviewPayload.gateFailure = gate;
      await expect(run()).rejects.toThrow();
      const row = renders.rows[0] as unknown as RenderDocument;
      expect(row).toMatchObject({ status: "failed", qualityDecision: { status: "rejected" }, creditCharged: false });
      expect(renderResponse(row).adjustmentPreviewUrl).toBe(`/api/assets/${row.compositeAssetId}`);
      expect(row.resultAssetId).toBeUndefined();
      expect(mocks.capture).not.toHaveBeenCalled();
      expect(mocks.release).toHaveBeenCalledOnce();
      expect(mocks.edit).toHaveBeenCalledTimes(2);
    });

  it.each(["identity", "present", "silhouetteComplete", "noDuplicate"])(
    "withholds a corrupt %s candidate despite the simpler geometry policy", async gate => {
      reviewPayload.gateFailure = gate;
      await expect(run()).rejects.toThrow();
      expect(renderResponse(renders.rows[0] as unknown as RenderDocument).adjustmentPreviewUrl).toBeNull();
      expect(mocks.capture).not.toHaveBeenCalled();
    });

  it("withholds incomplete replacement and never retries its paid image", async () => {
    request.replaceExisting = true;
    request.replacementRegion = { xMin: 0.05, yMin: 0.25, xMax: 0.75, yMax: 0.85 };
    reviewPayload.replacementFailure = true;
    await expect(run()).rejects.toThrow();
    expect(renderResponse(renders.rows[0] as unknown as RenderDocument).adjustmentPreviewUrl).toBeNull();
    expect(mocks.edit).toHaveBeenCalledTimes(3);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("preserves the historical v6 clarity admission for a client without visual controls", async () => {
    delete request.simplePlacements![0]!.visualWidthNormalized;
    const preflight = await mocks.storefrontPreflight.getMockImplementation()!();
    preflight.inspections[0].supportVisible = false;
    mocks.storefrontPreflight.mockResolvedValue(preflight);
    await expect(run()).rejects.toThrow(/support|visible/);
    expect((renders.rows[0] as unknown as RenderDocument).engineVersions!.prompt).toBe("storefront-myarchitect-room-v6");
    expect(mocks.storefrontPreflight).toHaveBeenCalledOnce();
    expect(mocks.edit).not.toHaveBeenCalled();
  });

  it("keeps explicit measured-reference analysis instead of treating it as a visual calibration", async () => {
    delete request.simplePlacements![0]!.visualWidthNormalized;
    request.simplePlacements![0]!.pixelsPerCm = 3;
    request.scaleReference = { realHeightCm: 30, basePoint: { x: 0.2, y: 0.8 }, topPoint: { x: 0.2, y: 0.5 }, sameDepthConfirmed: true };
    await expect(run()).rejects.toThrow(); // The offline review deliberately lacks the measured-reference check.
    expect(mocks.storefrontPreflight).toHaveBeenCalledOnce();
    expect(mocks.storefrontPreflight.mock.calls[0]![0].reference).toEqual(request.scaleReference);
    expect((renders.rows[0] as unknown as RenderDocument).engineVersions!.prompt).toBe("storefront-myarchitect-room-v6");
  });

  it("uses visual widths for two articles on the existing OpenAI route without a MyArchitect fallback or mandatory preflight", async () => {
    request.simplePlacements!.push({ ...request.simplePlacements![0]!, productId: "p1", placementPoint: { x: 0.65, y: 0.8 } });
    mocks.edit.mockImplementation(async input => ({ provider: "openai", model: "test-image", status: "succeeded",
      durationMs: 1, estimatedCostUsd: 0.1, attemptCount: 1, images: [{ data: input.composition, mimeType: "image/webp" }], safety: { blocked: false } }));
    const result = await run();
    expect(result.status).toBe("succeeded");
    expect(mocks.storefrontPreflight).not.toHaveBeenCalled();
    expect(mocks.edit).toHaveBeenCalledOnce();
    expect(renders.rows[0]).toMatchObject({ engineVersions: { prompt: "storefront-openai-room-v9", editProvider: "openai" },
      audit: { scaleSources: ["visual_size", "visual_size"] } });
    expect(reviewCalls).toBe(1);
  });
});
