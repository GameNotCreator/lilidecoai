import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import type {
  ProductDocument,
  RenderDocument,
  SceneDocument,
} from "../lib/server/types";
import { mongoStore } from "./helpers/mongo-store";
import { globalRoom } from "./fixtures/spatial-room";
const mocks = vi.hoisted(() => ({
  collections: vi.fn(),
  read: vi.fn(),
  store: vi.fn(),
  estimate: vi.fn(),
  edit: vi.fn(),
  review: vi.fn(),
  complete: vi.fn(),
  cachedRoom: vi.fn(),
  sourceReview: vi.fn(),
  volumePrepare: vi.fn(),
  volumeAssemble: vi.fn(),
  volumeMatte: vi.fn(),
  config: {
    aiMockMode: false,
    openaiMaxCostUsd: 10,
    mattingUrl: "https://matting.example.test",
    mattingToken: "unit-test-token",
    mattingTimeoutMs: 90000,
  },
}));
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/spatial-source-review", async (original) => ({
  ...(await original<object>()),
  cachedSourceReview: mocks.sourceReview,
}));
vi.mock("../lib/server/spatial-scene-cache", async (original) => ({
  ...(await original<object>()),
  cachedSpatialRoom: mocks.cachedRoom,
}));
vi.mock("../lib/server/mongodb", () => ({ collections: mocks.collections }));
vi.mock("../lib/server/assets", () => ({
  ApiInputError: class extends Error {},
  readAsset: mocks.read,
  storeAsset: mocks.store,
  privateVisibility: () => ({ visibility: "private" }),
}));
vi.mock("../lib/server/config", () => ({
  serverConfig: mocks.config,
}));
vi.mock("../lib/server/spatial-volume-edit", async (original) => ({
  ...(await original<object>()),
  prepareSpatialVolumeEdit: mocks.volumePrepare,
  assembleSpatialVolumeEdit: mocks.volumeAssemble,
}));
vi.mock("../lib/server/spatial-volume-matte", async (original) => ({
  ...(await original<object>()),
  matteSpatialVolume: mocks.volumeMatte,
}));
vi.mock("../lib/server/ai/openai", () => ({
  OpenAIImageProvider: class {
    isAvailable() {
      return true;
    }
    edit = mocks.edit;
  },
  estimateOpenAICost: () => 0.1,
}));
vi.mock("../lib/server/ai/spatial-placement", async (original) => ({
  ...(await original<object>()),
  estimateSpatialScene: mocks.estimate,
}));
vi.mock("../lib/server/ai/visual-review", async (original) => ({
  ...(await original<object>()),
  reviewVisualRender: mocks.review,
}));
vi.mock("../lib/server/render-lifecycle", async (original) => ({
  ...(await original<object>()),
  completeRender: mocks.complete,
}));
import { durableContext } from "../lib/server/durable-context";
import {
  VisualReviewError,
  type VisualReviewInput,
} from "../lib/server/ai/visual-review";
import {
  SPATIAL_VOLUME_NUMERIC_REPAIR_POLICY as numericPolicy,
  type VolumeReviewObservations,
} from "../lib/server/spatial-volume-repair";
import { SpatialVolumeEditError } from "../lib/server/spatial-volume-edit";
import { SpatialVolumeMatteError } from "../lib/server/spatial-volume-matte";
import { SPATIAL_REVIEW_EXECUTION_POLICY as reviewPolicy } from "../lib/server/spatial-review-policy";
import {
  runSpatialRender,
  restoreSpatialBackground,
} from "../lib/server/spatial-rendering";
import {
  prepareSpatialEdit,
  type SpatialSceneEstimate,
} from "../lib/server/ai/spatial-placement";
const estimate: SpatialSceneEstimate = {
  camera: {
    focalLengthInImageWidths: 1,
    heightAboveSupportCm: 150,
    pitchDownDegrees: 30,
  },
  yawDegrees: 0,
  support: "floor",
  cameraEvidence: "approximate",
  scaleReference: "not measured",
  visibleFaces: "top",
  lighting: "left",
  occlusions: "none",
  hiddenGeometryAssumptions: "back",
  confidence: 0.8,
};
const accepted = {
  accepted: true,
  score: 0.95,
  replacementComplete: true,
  scaleAndPerspectivePlausible: true,
  scaleCorrectionFactor: 1,
  photorealistic: true,
  duplicateProduct: false,
  artifactsPresent: false,
  productIdentityPreserved: true,
  backgroundPreserved: true,
  allProductsPresent: true,
  feedback: "Conforme",
  repairFeedback: "",
  checks: [],
};
const db = {} as Db;
let renders: ReturnType<typeof mongoStore>,
  assets: ReturnType<typeof mongoStore>,
  render: RenderDocument,
  room: Buffer;
let scene: SceneDocument, product: ProductDocument;
const input = {
  engine: "spatial" as const,
  placement: { sceneId: "scene", productId: "product" },
  placementPoint: { x: 0.5, y: 0.8 },
  idempotencyKey: "once",
};
const run = () =>
  durableContext.run({ render, token: "lease" }, () =>
    runSpatialRender(db, render, scene, product, input),
  );
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.volumePrepare.mockReset();
  mocks.volumeAssemble.mockReset();
  mocks.volumeMatte.mockReset();
  mocks.config.mattingUrl = "https://matting.example.test";
  mocks.config.mattingToken = "unit-test-token";
  mocks.config.mattingTimeoutMs = 90000;
  renders = mongoStore();
  assets = mongoStore();
  mocks.collections.mockReturnValue({
    renders,
    assets,
    renderAttempts: mongoStore(),
  });
  const images = new Map<string, Buffer>();
  room = await sharp({
    create: { width: 600, height: 400, channels: 3, background: "#102030" },
  })
    .png()
    .toBuffer();
  images.set("room", room);
  images.set("identity", room);
  images.set("side", room);
  mocks.read.mockImplementation(async (_db, id: string) =>
    images.has(id)
      ? { buffer: images.get(id), asset: { organizationId: "org" } }
      : null,
  );
  mocks.store.mockImplementation(
    async (_db, args: { buffer: Buffer; organizationId: string }) => {
      const id = crypto.randomUUID();
      images.set(id, args.buffer);
      assets.rows.push({ id, organizationId: args.organizationId });
      return { id };
    },
  );
  scene = {
    id: "scene",
    assetId: "room",
    expiresAt: new Date(Date.now() + 1800_000),
  } as SceneDocument;
  product = {
    organizationId: "org",
    id: "product",
    name: "Chair",
    assetId: "identity",
    widthCm: 42,
    heightCm: 80,
    depthCm: 45,
    placementType: "floor",
  } as ProductDocument;
  render = {
    id: "render",
    organizationId: "org",
    status: "processing",
    createdAt: new Date(),
    engine: "spatial",
    engineVersions: {
      prompt: "spatial-v1",
      mockMode: false,
      imageQuality: "high",
      editModel: "frozen-image",
      visionModel: "frozen-vision",
    },
    execution: {
      token: "lease",
      leaseUntil: new Date(Date.now() + 1800_000),
      deadlineAt: new Date(Date.now() + 1800_000),
      steps: {},
      scene,
    },
  } as RenderDocument;
  renders.rows.push(
    structuredClone(render) as unknown as Record<string, unknown>,
  );
  mocks.estimate.mockResolvedValue({
    estimate: {
      ...estimate,
      supportAssessment: {
        kind: "floor",
        pointOnVisibleSupport: true,
        occupied: false,
        boundary: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
          { x: 0, y: 1 },
        ],
        holes: [],
        evidence: "visible floor",
      },
    },
    durationMs: 1,
  });
  mocks.review.mockResolvedValue(accepted);
  mocks.sourceReview.mockResolvedValue({
    references: [
      {
        index: 0,
        sameProduct: true,
        singleUnambiguousProduct: true,
        readable: true,
        completeSilhouette: true,
        confidence: 0.9,
        reason: "Complet",
      },
    ],
  });
  mocks.cachedRoom.mockResolvedValue({
    value: globalRoom,
    fingerprint: "a".repeat(64),
  });
  mocks.edit.mockImplementation(async () => ({
    status: "succeeded",
    provider: "openai",
    model: "frozen-image",
    estimatedCostUsd: 0.1,
    durationMs: 1,
    requestId: "request",
    attemptCount: 1,
    images: [{ data: room, mimeType: "image/png" }],
  }));
});
async function setupVolume() {
  product.objectType = "other";
  product.name = "Basket";
  product.widthCm = 32;
  product.heightCm = 32;
  product.depthCm = 33;
  product.spatialMetadata = {
    measurementConvention: "Complete envelope including handles",
    dimensionSource: "catalog",
    supports: ["floor"],
    characteristicParts: ["woven walls", "complete opening"],
    contactProfile: "solid-base",
    volumeFamily: "basket",
  };
  render.engineVersions!.prompt = "spatial-v12";
  render.engineVersions!.volumeIntegrationPolicy =
    "spatial-volume-local-matte-v1";
  const local = await sharp({
    create: { width: 1024, height: 1024, channels: 3, background: "#506070" },
  })
    .webp({ lossless: true })
    .toBuffer();
  const apiMask = await sharp({
    create: {
      width: 1024,
      height: 1024,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    },
  })
    .png()
    .toBuffer();
  const fullMask = await sharp({
    create: { width: 600, height: 400, channels: 3, background: "white" },
  })
    .toColourspace("b-w")
    .png()
    .toBuffer();
  const emptyMask = await sharp({
    create: { width: 600, height: 400, channels: 3, background: "black" },
  })
    .toColourspace("b-w")
    .png()
    .toBuffer();
  const prepared = {
    composition: local,
    guide: local,
    apiMask,
    canonicalRoom: room,
    objectRegion: fullMask,
    contactRegion: emptyMask,
    freeSupport: fullMask,
    protectedRegion: emptyMask,
    nominalObjectRegion: fullMask,
    outputSize: "1024x1024",
    point: { x: 0.4, y: 0.6 },
    prompt: "Frozen volume replacement prompt",
    transform: {
      version: 1,
      frame: { width: 600, height: 400 },
      model: { width: 1024, height: 1024 },
      window: { left: 44, top: -56, width: 512, height: 512 },
      intersection: { left: 44, top: 0, width: 512, height: 400 },
      padding: { left: 0, top: 56, right: 0, bottom: 56 },
      scale: 2,
      contextMarginPx: 32,
    },
    metadata: {
      policy: "spatial-volume-local-proxy-v1",
      continuousRangeGuaranteed: false,
    },
  };
  mocks.volumePrepare.mockResolvedValue(prepared);
  mocks.volumeAssemble.mockResolvedValue(room);
  mocks.volumeMatte.mockResolvedValue({
    image: room,
    alpha: fullMask,
    metadata: {
      version: "spatial-volume-matte-v12",
      outsideAuthorizationPixels: 0,
      alphaModified: false,
    },
  });
  return prepared;
}
async function setupNumericVolume() {
  const prepared = await setupVolume();
  render.engineVersions!.prompt = "spatial-v13";
  render.engineVersions!.volumeRepairPolicy = numericPolicy;
  return prepared;
}
function rejectedVolumeReview(request: VisualReviewInput) {
  const product = request.products[0]!;
  const geometryObservations: VolumeReviewObservations = {
    policy: numericPolicy,
    source: "validated-visual-review",
    coordinateSpace: "normalized-original-room",
    reviewConfidence: 0.95,
    products: [
      {
        productId: product.id,
        confidence: 0.95,
        foregroundOccluded: false,
        expectedBox: product.expectedBox!,
        expectedContact: product.expectedGeometry!.contact,
        observedBox: {
          ...product.expectedBox!,
          xMin: product.expectedBox!.xMin - 0.02,
        },
        observedContact: {
          x: product.expectedGeometry!.contact.x - 0.01,
          y: product.expectedGeometry!.contact.y,
        },
      },
    ],
  };
  return {
    ...accepted,
    accepted: false,
    scaleAndPerspectivePlausible: false,
    repairFeedback: "Restore projected bounds",
    geometryObservations,
  };
}
describe("prospective v13 numeric repair orchestration", () => {
  it("pins numeric diagnostics to the rejected candidate and crop while keeping all three original references and geometry", async () => {
    const prepared = await setupNumericVolume();
    mocks.review.mockImplementationOnce(async (request) =>
      rejectedVolumeReview(request),
    );
    await run();
    expect(mocks.edit).toHaveBeenCalledTimes(2);
    const first = mocks.edit.mock.calls[0]![0],
      second = mocks.edit.mock.calls[1]![0];
    expect(first.prompt).not.toContain("NUMERIC REPAIR DIAGNOSTIC");
    expect(second.prompt).toContain("NUMERIC REPAIR DIAGNOSTIC");
    expect(second.prompt).toContain("Restore projected bounds");
    expect(second.prompt).toContain("observedMinusTargetEdges");
    expect(second.references).toHaveLength(3);
    expect(second.references).toEqual(first.references);
    expect(second.composition).toEqual(first.composition);
    expect(second.mask).toEqual(first.mask);
    expect(second.placement).toEqual(first.placement);
    const reviews = mocks.review.mock.calls.map(([request]) => request);
    expect(reviews[1].products).toEqual(reviews[0].products);
    expect(reviews[0].geometryObservationPolicy).toBe(numericPolicy);
    expect(reviews[1].executionPolicy).toBe(reviewPolicy.version);
    expect(
      reviews.every((request) => request.generated.mimeType === "image/png"),
    ).toBe(true);
    const step = (renders.rows[0] as unknown as RenderDocument).execution!
      .steps["spatial-numeric-repair-1"]!;
    expect(step).toMatchObject({
      status: "completed",
      attempts: 1,
      output: {
        policy: numericPolicy,
        status: "ready",
        candidateSha256: createHash("sha256").update(room).digest("hex"),
      },
    });
    const diagnostic = step.output as {
      feedbackData: {
        target: { left: number };
        targetContact: { x: number; y: number };
        observedMinusTargetEdges: { left: number };
        dimensionsCm: object;
      };
    };
    expect(diagnostic.feedbackData.target.left).toBeCloseTo(
      (reviews[0].products[0].expectedBox.xMin * 600 -
        prepared.transform.window.left) *
        2,
    );
    expect(diagnostic.feedbackData.targetContact).toEqual({ x: 512, y: 752 });
    expect(diagnostic.feedbackData.observedMinusTargetEdges.left).toBeCloseTo(
      -24,
    );
    expect(diagnostic.feedbackData.dimensionsCm).toEqual({
      widthCm: 32,
      heightCm: 32,
      depthCm: 33,
      unit: "cm",
    });
    const evidence = mocks.complete.mock.calls[0]![2].spatialEvidence;
    expect(evidence.engine).toBe("spatial-v13");
    expect(evidence.plan).toMatchObject({
      volumeRepairPolicy: numericPolicy,
      volumeIntegrationPolicy: "spatial-volume-local-matte-v1",
      reviewExecutionPolicy: reviewPolicy.version,
    });
  });
  it("resumes the persisted correction and numeric feedback after second QA times out without another generation or matting", async () => {
    await setupNumericVolume();
    mocks.review
      .mockImplementationOnce(async (request) => rejectedVolumeReview(request))
      .mockRejectedValueOnce(
        new VisualReviewError("timeout", "Timed out", true, true),
      );
    await expect(run()).rejects.toMatchObject({ code: "retry" });
    const checkpoint = structuredClone(
      (renders.rows[0] as unknown as RenderDocument).execution!.steps[
        "spatial-numeric-repair-1"
      ],
    );
    expect(checkpoint?.status).toBe("completed");
    render.execution!.deadlineAt = new Date(Date.now() + 90_000);
    await renders.updateOne(
      { id: render.id },
      { $set: { "execution.deadlineAt": render.execution!.deadlineAt } },
    );
    await run();
    expect(mocks.edit).toHaveBeenCalledTimes(2);
    expect(mocks.volumeMatte).toHaveBeenCalledTimes(2);
    expect(mocks.volumePrepare).toHaveBeenCalledOnce();
    expect(mocks.review).toHaveBeenCalledTimes(3);
    expect(mocks.review.mock.calls[2]![0].generated).toEqual(
      mocks.review.mock.calls[1]![0].generated,
    );
    expect(
      (renders.rows[0] as unknown as RenderDocument).execution!.steps[
        "spatial-numeric-repair-1"
      ],
    ).toEqual(checkpoint);
    expect(mocks.complete).toHaveBeenCalledOnce();
  });
  it.each(["missing", "low-confidence", "mismatch"])(
    "does not spend on a numeric retry with %s observations",
    async (kind) => {
      await setupNumericVolume();
      mocks.review.mockImplementationOnce(async (request) => {
        const review = rejectedVolumeReview(request);
        if (kind === "missing")
          delete (review as { geometryObservations?: VolumeReviewObservations })
            .geometryObservations;
        if (kind === "low-confidence")
          review.geometryObservations.reviewConfidence = 0.89;
        if (kind === "mismatch")
          review.geometryObservations.products[0]!.expectedContact = {
            x: 0.4,
            y: 0.6,
          };
        return review;
      });
      await expect(run()).rejects.toThrow();
      await expect(run()).rejects.toThrow();
      expect(mocks.edit).toHaveBeenCalledOnce();
      expect(mocks.review).toHaveBeenCalledOnce();
      expect(mocks.complete).not.toHaveBeenCalled();
      expect(
        (renders.rows[0] as unknown as RenderDocument).execution!.steps[
          "spatial-numeric-repair-1"
        ],
      ).toMatchObject({
        status: "completed",
        output: { status: "unavailable" },
      });
    },
  );
  it.each(["missing", "unknown"])(
    "refuses a %s frozen v13 repair policy before any AI call",
    async (kind) => {
      await setupNumericVolume();
      if (kind === "missing") delete render.engineVersions!.volumeRepairPolicy;
      else
        (
          render.engineVersions as unknown as { volumeRepairPolicy: string }
        ).volumeRepairPolicy = "future-policy";
      await expect(run()).rejects.toMatchObject({ code: "permanent" });
      expect(mocks.sourceReview).not.toHaveBeenCalled();
      expect(mocks.cachedRoom).not.toHaveBeenCalled();
      expect(mocks.volumePrepare).not.toHaveBeenCalled();
      expect(mocks.edit).not.toHaveBeenCalled();
      expect(mocks.review).not.toHaveBeenCalled();
    },
  );
  it("still refuses the second rejected candidate after the single numeric repair", async () => {
    await setupNumericVolume();
    mocks.review.mockImplementation(async (request) =>
      rejectedVolumeReview(request),
    );
    await expect(run()).rejects.toThrow();
    await expect(run()).rejects.toThrow();
    expect(mocks.edit).toHaveBeenCalledTimes(2);
    expect(mocks.volumeMatte).toHaveBeenCalledTimes(2);
    expect(mocks.review).toHaveBeenCalledTimes(2);
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it("keeps persisted v12 repairs generic, including when numeric observations or a future policy field are present", async () => {
    await setupVolume();
    render.engineVersions!.volumeRepairPolicy = numericPolicy;
    mocks.review
      .mockImplementationOnce(async (request) => rejectedVolumeReview(request))
      .mockRejectedValueOnce(
        new VisualReviewError("timeout", "Timed out", true, true),
      );
    await expect(run()).rejects.toMatchObject({ code: "retry" });
    await run();
    expect(mocks.edit).toHaveBeenCalledTimes(2);
    expect(mocks.edit.mock.calls[1]![0].prompt).toContain(
      "Restore projected bounds",
    );
    expect(mocks.edit.mock.calls[1]![0].prompt).not.toContain(
      "NUMERIC REPAIR DIAGNOSTIC",
    );
    expect(mocks.review.mock.calls[0]![0]).not.toHaveProperty(
      "geometryObservationPolicy",
    );
    expect(
      (renders.rows[0] as unknown as RenderDocument).execution!.steps,
    ).not.toHaveProperty("spatial-numeric-repair-1");
    expect(mocks.complete.mock.calls[0]![2].spatialEvidence.engine).toBe(
      "spatial-v12",
    );
    expect(
      mocks.complete.mock.calls[0]![2].spatialEvidence.plan,
    ).not.toHaveProperty("volumeRepairPolicy");
  });
});
describe("durable v12 volume orchestration", () => {
  it("uses the frozen crop for generation while QA retains original nominal geometry and PNG MIME", async () => {
    const prepared = await setupVolume();
    await run();
    expect(mocks.volumePrepare).toHaveBeenCalledOnce();
    expect(mocks.volumeAssemble).toHaveBeenCalledOnce();
    expect(mocks.volumeMatte).toHaveBeenCalledOnce();
    const providerInput = mocks.edit.mock.calls[0]![0];
    expect(providerInput.size).toBe("1024x1024");
    expect(
      Buffer.from(providerInput.composition).equals(prepared.composition),
    ).toBe(true);
    expect(providerInput.placement).toMatchObject(prepared.point);
    expect(providerInput.references[2].role).toBe("spatial_guide");
    expect(
      Buffer.from(providerInput.references[2].data).equals(prepared.guide),
    ).toBe(true);
    const review = mocks.review.mock.calls[0]![0],
      evidence = mocks.complete.mock.calls[0]![2].spatialEvidence;
    expect(review.generated.mimeType).toBe("image/png");
    expect(Buffer.from(review.generated.data).equals(room)).toBe(true);
    expect(review.executionPolicy).toBe(reviewPolicy.version);
    expect(review.products[0].expectedGeometry).toEqual({
      kind: "volume-envelope",
      contact: input.placementPoint,
    });
    expect(review.products[0].scaleVerified).toBe(false);
    expect(evidence.engine).toBe("spatial-v12");
    expect(evidence.qualification).toBe("internal-only");
    expect(evidence.scene.transform).toEqual({
      offsetX: 0,
      offsetY: 0,
      paddedWidth: 600,
      paddedHeight: 400,
    });
    expect(evidence.plan).toMatchObject({
      volumeIntegrationPolicy: "spatial-volume-local-matte-v1",
      reviewExecutionPolicy: reviewPolicy.version,
      reviewGeometry: "volume-envelope-contact-v1",
    });
    const points = evidence.plan.projectedCorners as Array<{
      x: number;
      y: number;
    }>;
    expect(review.products[0].expectedBox).toEqual({
      xMin: Math.min(...points.map((p) => p.x)) / 600,
      xMax: Math.max(...points.map((p) => p.x)) / 600,
      yMin: Math.min(...points.map((p) => p.y)) / 400,
      yMax: Math.max(...points.map((p) => p.y)) / 400,
    });
    expect((await sharp(review.composition.data).metadata()).width).toBe(600);
    const finalWrite = mocks.store.mock.calls.at(-1)![1];
    expect(finalWrite.contentType).toBe("image/png");
    expect(Buffer.from(finalWrite.buffer).equals(room)).toBe(true);
    expect(mocks.complete).toHaveBeenCalledOnce();
  });
  it("resumes a temporary matte outage from the original generated image without paying again", async () => {
    await setupVolume();
    mocks.volumeMatte.mockRejectedValueOnce(
      new SpatialVolumeMatteError("matting-unavailable"),
    );
    await expect(run()).rejects.toMatchObject({ code: "retry" });
    expect(mocks.review).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
    await run();
    expect(mocks.edit).toHaveBeenCalledOnce();
    expect(mocks.volumePrepare).toHaveBeenCalledOnce();
    expect(mocks.sourceReview).toHaveBeenCalledOnce();
    expect(mocks.cachedRoom).toHaveBeenCalledOnce();
    expect(mocks.volumeMatte).toHaveBeenCalledTimes(2);
    const [first, second] = mocks.volumeMatte.mock.calls.map(([args]) => args);
    for (const key of [
      "originalRoom",
      "generatedRoom",
      "objectRegion",
      "contactRegion",
      "freeSupport",
      "protectedRegion",
      "nominalObjectRegion",
    ])
      expect(Buffer.from(first[key]).equals(Buffer.from(second[key]))).toBe(
        true,
      );
    expect(mocks.review).toHaveBeenCalledOnce();
    expect(mocks.complete).toHaveBeenCalledOnce();
  });
  it("resumes v12 final QA with its v11 review policy and without regenerating or rematting", async () => {
    await setupVolume();
    mocks.review.mockRejectedValueOnce(
      new VisualReviewError("timeout", "Timed out", true, true),
    );
    await expect(run()).rejects.toMatchObject({ code: "retry" });
    await run();
    expect(mocks.edit).toHaveBeenCalledOnce();
    expect(mocks.volumeMatte).toHaveBeenCalledOnce();
    expect(mocks.review).toHaveBeenCalledTimes(2);
    for (const [review] of mocks.review.mock.calls)
      expect(review.executionPolicy).toBe(reviewPolicy.version);
    expect(
      Buffer.from(mocks.review.mock.calls[0]![0].generated.data).equals(
        Buffer.from(mocks.review.mock.calls[1]![0].generated.data),
      ),
    ).toBe(true);
  });
  it("fences cancellation during matting before QA, completed checkpoint or delivery", async () => {
    await setupVolume();
    const completedMatte = mocks.volumeMatte.getMockImplementation()!;
    mocks.volumeMatte.mockImplementationOnce(async (...args) => {
      await renders.updateOne(
        { id: render.id },
        { $set: { status: "cancelled" } },
      );
      return completedMatte(...args);
    });
    await expect(run()).rejects.toMatchObject({ code: "lease_lost" });
    expect(mocks.edit).toHaveBeenCalledOnce();
    expect(mocks.volumeMatte).toHaveBeenCalledOnce();
    expect(mocks.review).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
    const persisted = renders.rows[0] as unknown as RenderDocument;
    expect(persisted.status).toBe("cancelled");
    expect(
      persisted.execution!.steps["spatial-volume-matte-1"]?.status,
    ).not.toBe("completed");
    await expect(run()).rejects.toThrow();
    expect(mocks.edit).toHaveBeenCalledOnce();
    expect(mocks.volumeMatte).toHaveBeenCalledOnce();
    expect(mocks.review).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it.each([
    "alpha-outside-object-authorization",
    "matting-model-drift",
    "invalid-png-grid",
  ])(
    "rejects matte integrity failure %s without QA, repair image or delivery",
    async (code) => {
      await setupVolume();
      mocks.volumeMatte.mockRejectedValueOnce(
        new SpatialVolumeMatteError(code),
      );
      await expect(run()).rejects.toMatchObject({ code: "permanent" });
      expect(mocks.edit).toHaveBeenCalledOnce();
      expect(mocks.review).not.toHaveBeenCalled();
      expect(mocks.complete).not.toHaveBeenCalled();
    },
  );
  it("refuses invalid uncertain geometry before the image API", async () => {
    await setupVolume();
    mocks.volumePrepare.mockRejectedValueOnce(
      new SpatialVolumeEditError(
        "Expanded uncertain volume intersects protection",
      ),
    );
    await expect(run()).rejects.toMatchObject({ code: "permanent" });
    expect(mocks.edit).not.toHaveBeenCalled();
    expect(mocks.volumeMatte).not.toHaveBeenCalled();
    expect(mocks.review).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it.each([
    "missing-policy",
    "wrong-policy",
    "unsupported-family",
    "no-profile",
    "bad-url",
    "no-url",
    "no-token",
  ])("refuses %s before source, room or image AI", async (kind) => {
    await setupVolume();
    if (kind === "missing-policy")
      delete render.engineVersions!.volumeIntegrationPolicy;
    if (kind === "wrong-policy")
      (
        render.engineVersions as unknown as Record<string, unknown>
      ).volumeIntegrationPolicy = "unknown-policy";
    if (kind === "unsupported-family") product.objectType = "furniture";
    if (kind === "no-profile") delete product.spatialMetadata!.contactProfile;
    if (kind === "bad-url")
      mocks.config.mattingUrl = "http://public-matting.example.test";
    if (kind === "no-url") mocks.config.mattingUrl = "";
    if (kind === "no-token") mocks.config.mattingToken = "";
    await expect(run()).rejects.toMatchObject({
      code: ["no-url", "no-token"].includes(kind) ? "retry" : "permanent",
    });
    expect(mocks.sourceReview).not.toHaveBeenCalled();
    expect(mocks.cachedRoom).not.toHaveBeenCalled();
    expect(mocks.edit).not.toHaveBeenCalled();
    expect(mocks.volumePrepare).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});
describe("durable spatial pipeline", () => {
  it("uses the newly admitted allowance without replacing review execution metadata", async () => {
    render.engineVersions!.prompt = "spatial-v11";
    render.engineVersions!.visionModel = "gpt-6-astra";
    render.engineVersions!.visionCostPolicy = "astra-token-allowance-v1";
    await run();
    const review = mocks
      .collections()
      .renderAttempts.rows.find(
        (row: { stage: string }) => row.stage === "spatial-review",
      );
    // This test config leaves service tier unspecified, so reserve the 2x tier.
    expect(review).toMatchObject({
      estimatedCostUsd: 1.8,
      usage: {
        reviewExecutionPolicy: reviewPolicy.version,
        costAllowance: {
          policy: "astra-token-allowance-v1",
          maxOutputTokens: 13000,
          hardSpendCap: false,
        },
      },
    });
  });
  it.each(["spatial-v10", "spatial-v11"])(
    "freezes the review execution policy for %s",
    async (version) => {
      render.engineVersions!.prompt = version;
      mocks.review.mockRejectedValueOnce(
        new VisualReviewError("timeout", "Timed out", true, true),
      );
      await expect(run()).rejects.toMatchObject({ code: "retry" });
      await run();
      expect(mocks.edit).toHaveBeenCalledOnce();
      expect(mocks.review).toHaveBeenCalledTimes(2);
      const first = mocks.review.mock.calls[0]![0];
      const second = mocks.review.mock.calls[1]![0];
      expect(
        Buffer.from(second.generated.data).equals(
          Buffer.from(first.generated.data),
        ),
      ).toBe(true);
      expect(first.executionPolicy).toBe(
        version === "spatial-v11" ? reviewPolicy.version : undefined,
      );
      expect(
        mocks.complete.mock.calls[0]![2].spatialEvidence.plan
          .reviewExecutionPolicy,
      ).toBe(version === "spatial-v11" ? reviewPolicy.version : undefined);
      const reviews = mocks
        .collections()
        .renderAttempts.rows.filter(
          (row: { stage: string }) => row.stage === "spatial-review",
        );
      expect(reviews).toHaveLength(2);
      expect(reviews[0]).toMatchObject({
        usageOutcome: "unknown",
        estimatedCostUsd: 0.03,
      });
      expect(reviews[1]).toMatchObject({
        usageOutcome: "succeeded",
        estimatedCostUsd: 0.03,
      });
      if (version === "spatial-v11")
        expect(reviews[0].usage).toMatchObject({
          reviewExecutionPolicy: reviewPolicy.version,
          timeoutMs: 90_000,
          maxAttempts: 2,
        });
    },
  );
  it("stops v11 after two unavailable reviews without another image or delivery", async () => {
    render.engineVersions!.prompt = "spatial-v11";
    mocks.review.mockRejectedValue(
      new VisualReviewError("timeout", "Timed out", true, true),
    );
    for (const code of ["retry", "permanent", "permanent"])
      await expect(run()).rejects.toMatchObject({ code });
    expect(mocks.review).toHaveBeenCalledTimes(2);
    expect(mocks.edit).toHaveBeenCalledOnce();
    expect(mocks.complete).not.toHaveBeenCalled();
    const reviews = mocks
      .collections()
      .renderAttempts.rows.filter(
        (row: { stage: string }) => row.stage === "spatial-review",
      );
    expect(reviews).toHaveLength(2);
    expect(
      reviews.every(
        (row: { usageOutcome: string; estimatedCostUsd: number }) =>
          row.usageOutcome === "unknown" && row.estimatedCostUsd === 0.03,
      ),
    ).toBe(true);
  });
  it.each(["invalid_review", "refusal", "deadline"])(
    "never retries terminal v11 review %s",
    async (code) => {
      render.engineVersions!.prompt = "spatial-v11";
      mocks.review.mockRejectedValue(
        new VisualReviewError(
          code,
          "Review refused",
          false,
          code !== "deadline",
        ),
      );
      for (let i = 0; i < 2; i++)
        await expect(run()).rejects.toMatchObject({ code: "permanent" });
      expect(mocks.review).toHaveBeenCalledOnce();
      expect(mocks.edit).toHaveBeenCalledOnce();
      expect(mocks.complete).not.toHaveBeenCalled();
      const reviews = mocks
        .collections()
        .renderAttempts.rows.filter(
          (row: { stage: string }) => row.stage === "spatial-review",
        );
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toMatchObject(
        code === "deadline"
          ? {
              usageOutcome: "failed",
              estimatedCostUsd: 0,
              errorCode: "provider_not_called",
            }
          : { usageOutcome: "unknown", estimatedCostUsd: 0.03 },
      );
    },
  );
  async function driftedOutput() {
    const result = await mocks.edit.getMockImplementation()!();
    const drift = await sharp(room).linear(1, 35).png().toBuffer();
    return { ...result, images: [{ data: drift, mimeType: "image/png" }] };
  }
  it.each(["spatial-v9", "spatial-v10", "spatial-v11"])(
    "versions the seam veto and bounds repairs (%s)",
    async (version) => {
      render.engineVersions!.prompt = version;
      const bad = await driftedOutput();
      mocks.edit.mockResolvedValue(bad);
      if (version === "spatial-v9") {
        await run();
        expect(mocks.review).toHaveBeenCalledOnce();
        expect(mocks.complete).toHaveBeenCalledOnce();
      } else {
        await expect(run()).rejects.toMatchObject({
          decision: {
            status: "rejected",
            score: null,
            feedback: expect.stringContaining("rupture"),
          },
        });
        expect(mocks.edit).toHaveBeenCalledTimes(2);
        expect(mocks.review).not.toHaveBeenCalled();
        expect(mocks.complete).not.toHaveBeenCalled();
        expect(mocks.edit.mock.calls[1]![0].prompt).toContain(
          "hard colour seam",
        );
        expect(JSON.stringify(renders.rows)).toContain(
          "spatial-integration-v2-2",
        );
      }
    },
  );
  it.each(["spatial-v10", "spatial-v11"])(
    "retains a corrected %s candidate through a QA outage without generating a third image",
    async (version) => {
      render.engineVersions!.prompt = version;
      const bad = await driftedOutput();
      mocks.edit.mockResolvedValueOnce(bad);
      mocks.review.mockRejectedValueOnce(new Error("offline"));
      await expect(run()).rejects.toMatchObject({ code: "retry" });
      expect(mocks.edit).toHaveBeenCalledTimes(2);
      expect(mocks.review).toHaveBeenCalledOnce();
      expect(mocks.complete).not.toHaveBeenCalled();
      await run();
      expect(mocks.edit).toHaveBeenCalledTimes(2);
      expect(mocks.complete).toHaveBeenCalledOnce();
      expect(
        mocks.complete.mock.calls[0]![2].spatialEvidence.plan
          .backgroundBoundaryPolicy,
      ).toBe("spatial-boundary-v1");
      expect(JSON.stringify(renders.rows)).toContain('"status":"rejected"');
      expect(JSON.stringify(renders.rows)).toContain('"status":"not-detected"');
    },
  );
  it.each(["spatial-v10", "spatial-v11"])(
    "still refuses %s images rejected by visual QA when no seam is detected",
    async (version) => {
      render.engineVersions!.prompt = version;
      mocks.review.mockResolvedValue({
        ...accepted,
        accepted: false,
        productIdentityPreserved: false,
        repairFeedback: "Wrong identity",
      });
      await expect(run()).rejects.toThrow();
      expect(mocks.review).toHaveBeenCalledTimes(2);
      expect(mocks.complete).not.toHaveBeenCalled();
    },
  );
  it.each([
    "spatial-v7",
    "spatial-v8",
    "spatial-v9",
    "spatial-v10",
    "spatial-v11",
  ])("keeps the frozen review contract for %s volumes", async (version) => {
    render.engineVersions!.prompt = version;
    await run();
    expect(mocks.review.mock.calls[0]![0].products[0].expectedGeometry).toEqual(
      version !== "spatial-v7"
        ? { kind: "volume-envelope", contact: input.placementPoint }
        : undefined,
    );
  });
  it("retains every global exclusion and the full evidence accepted by preview", async () => {
    render.engineVersions!.prompt = "spatial-v8";
    const analysis = structuredClone(globalRoom);
    const obstacle = [
      { x: 0.01, y: 0.01 },
      { x: 0.02, y: 0.01 },
      { x: 0.02, y: 0.02 },
      { x: 0.01, y: 0.02 },
    ];
    analysis.surfaces[0]!.obstacles = Array.from(
      { length: 30 },
      () => obstacle,
    );
    analysis.surfaces[0]!.holes = Array.from({ length: 12 }, () => obstacle);
    analysis.surfaces[0]!.scaleEvidence = "e".repeat(800);
    mocks.cachedRoom.mockResolvedValue({
      value: analysis,
      fingerprint: "a".repeat(64),
    });
    await run();
    const evidence = mocks.complete.mock.calls[0]![2].spatialEvidence;
    expect(evidence.scene.supportHoles).toHaveLength(42);
    expect(evidence.scene.observations).toContain("e".repeat(800));
    expect(mocks.edit).toHaveBeenCalledOnce();
  });
  function rug() {
    render.engineVersions!.prompt = "spatial-v6";
    product.objectType = "rug";
    product.heightCm = 1;
    product.planarTexture = {
      version: 1,
      assetId: "identity",
      fingerprint: createHash("sha256").update(room).digest("hex"),
      widthPx: 600,
      heightPx: 400,
      productWidthCm: product.widthCm,
      productDepthCm: product.depthCm,
      confirmedAt: new Date().toISOString(),
      corners: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
    };
  }
  it.each(["spatial-v8", "spatial-v9", "spatial-v10", "spatial-v11"])(
    "retains silhouette review and feathered contacts while versioning the rug filter (%s)",
    async (version) => {
      rug();
      render.engineVersions!.prompt = version;
      await run();
      expect(
        mocks.review.mock.calls[0]![0].products[0].expectedGeometry,
      ).toBeUndefined();
      const evidence = mocks.complete.mock.calls[0]![2].spatialEvidence;
      expect(evidence.plan.reviewGeometry).toBe("projected-silhouette-v1");
      expect(evidence.plan.interactionPolicy).toBe("plane-and-contact-v1");
      expect(evidence.plan.planarTexture.version).toBe(
        version !== "spatial-v8" ? "planar-texture-v2" : "planar-texture-v1",
      );
      if (version !== "spatial-v8")
        expect(evidence.plan.planarTexture.filteredPixels).toBeGreaterThan(0);
      else expect(evidence.plan.planarTexture.filtering).toBeUndefined();
      expect(evidence.plan.backgroundBoundaryPolicy).toBeUndefined();
    },
  );
  it("projects a saved rug, reviews the final integrated image and resumes v6 without another paid image", async () => {
    rug();
    mocks.review.mockRejectedValueOnce(new Error("offline"));
    await expect(run()).rejects.toMatchObject({ code: "retry" });
    expect(mocks.complete).not.toHaveBeenCalled();
    await run();
    expect(mocks.edit).toHaveBeenCalledOnce();
    expect(mocks.sourceReview).toHaveBeenCalledOnce();
    expect(mocks.edit.mock.calls[0]![0].prompt).toContain(
      "Do not redraw the rug",
    );
    expect(mocks.review.mock.calls[1]![0].instructions).toContain(
      "FINAL integrated candidate",
    );
    const evidence = mocks.complete.mock.calls[0]![2].spatialEvidence;
    expect(evidence.engine).toBe("spatial-v6");
    expect(evidence.plan.planarTexture.lightingPolicy).toBe(
      "planar-neutral-light-v1",
    );
    expect(evidence.plan.projectedCorners.slice(0, 4)).toEqual(
      evidence.plan.projectedCorners.slice(4),
    );
    expect(JSON.stringify(renders.rows)).toContain("spatial-planar-projection");
    const finalImage = mocks.review.mock.calls[1]![0].generated.data;
    const stores = mocks.store.mock.calls.map(
      (call) => call[1].buffer as Buffer,
    );
    expect(stores.some((buffer) => buffer.equals(finalImage))).toBe(true);
  });
  it("uses the selected texture view rather than substituting the main catalogue photo", async () => {
    rug();
    const texture = await sharp({
      create: { width: 600, height: 400, channels: 3, background: "#d09010" },
    })
      .png()
      .toBuffer();
    const read = mocks.read.getMockImplementation()!;
    mocks.read.mockImplementation(async (...args) =>
      args[1] === "side"
        ? { buffer: texture, asset: { organizationId: "org" } }
        : read(...args),
    );
    product.views = [
      {
        id: "side",
        assetId: "side",
        type: "top",
        validationStatus: "valid",
        widthPx: 600,
        heightPx: 400,
        createdAt: new Date(),
      },
    ];
    product.planarTexture!.assetId = "side";
    product.planarTexture!.fingerprint = createHash("sha256")
      .update(texture)
      .digest("hex");
    await run();
    const evidence = mocks.complete.mock.calls[0]![2].spatialEvidence;
    expect(evidence.plan.planarTexture.sourceFingerprint).toBe(
      product.planarTexture!.fingerprint,
    );
    expect(mocks.sourceReview.mock.calls[0]![1].references).toHaveLength(2);
    const guide = await sharp(mocks.review.mock.calls[0]![0].composition.data)
      .raw()
      .toBuffer();
    expect(guide.includes(Buffer.from([208, 144, 16]))).toBe(true);
  });
  it.each(["spatial-v7", "spatial-v9"])(
    "persists contacts/projection and resumes final QA without repeating generation (%s)",
    async (version) => {
      rug();
      render.engineVersions!.prompt = version;
      mocks.review.mockRejectedValueOnce(new Error("offline"));
      await expect(run()).rejects.toMatchObject({ code: "retry" });
      await run();
      expect(mocks.edit).toHaveBeenCalledOnce();
      const evidence = mocks.complete.mock.calls[0]![2].spatialEvidence;
      expect(evidence.engine).toBe(version);
      expect(evidence.plan.planarTexture.version).toBe(
        version === "spatial-v9" ? "planar-texture-v2" : "planar-texture-v1",
      );
      expect(evidence.plan.interactionPolicy).toBe("plane-and-contact-v1");
      expect(evidence.plan.interactionMask).toMatchObject({
        objectMarginPx: 0,
      });
      expect(
        evidence.plan.interactionMask.contactFeatherPx,
      ).toBeGreaterThanOrEqual(2);
      expect(evidence.plan.planarTexture.lightingPolicy).toBe(
        "planar-neutral-light-v2",
      );
      expect(JSON.stringify(renders.rows)).toContain("contactOpacity");
    },
  );
  it.each(["missing", "changed", "wrong-owner", "old-version"])(
    "blocks %s rug texture before any paid calls",
    async (reason) => {
      rug();
      if (reason === "missing") product.planarTexture = undefined;
      if (reason === "changed")
        product.planarTexture!.fingerprint = "a".repeat(64);
      if (reason === "wrong-owner") product.organizationId = "another";
      if (reason === "old-version")
        render.engineVersions!.prompt = "spatial-v5";
      await expect(run()).rejects.toMatchObject({ code: "permanent" });
      expect(mocks.sourceReview).not.toHaveBeenCalled();
      expect(mocks.cachedRoom).not.toHaveBeenCalled();
      expect(mocks.edit).not.toHaveBeenCalled();
    },
  );
  it("does not deliver a rug rejected by visual review after its single repair", async () => {
    rug();
    mocks.review.mockResolvedValue({
      ...accepted,
      accepted: false,
      photorealistic: false,
      repairFeedback: "Floating rug edge",
    });
    await expect(run()).rejects.toThrow();
    expect(mocks.edit).toHaveBeenCalledTimes(2);
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it("keeps a temporary texture read failure retryable without a paid call", async () => {
    rug();
    mocks.read.mockRejectedValueOnce(new Error("storage offline"));
    await expect(run()).rejects.toMatchObject({ code: "retry" });
    expect(mocks.edit).not.toHaveBeenCalled();
    await run();
    expect(mocks.complete).toHaveBeenCalledOnce();
  });
  it("persists separate interaction masks and reuses generation after a v5 QA interruption", async () => {
    render.engineVersions!.prompt = "spatial-v5";
    mocks.review.mockRejectedValueOnce(new Error("offline"));
    await expect(run()).rejects.toMatchObject({ code: "retry" });
    await run();
    expect(mocks.edit).toHaveBeenCalledOnce();
    const evidence = mocks.complete.mock.calls[0]![2].spatialEvidence;
    expect(evidence.engine).toBe("spatial-v5");
    expect(evidence.plan.interactionPolicy).toBe("volume-and-contact-v1");
    expect(evidence.plan.interactionMask.objectPixels).toBeGreaterThan(0);
    expect(JSON.stringify(renders.rows)).toContain("spatial-interaction-masks");
  });
  it("blocks a cropped source before room analysis or image generation", async () => {
    render.engineVersions!.prompt = "spatial-v4";
    mocks.sourceReview.mockResolvedValue({
      references: [
        {
          index: 0,
          sameProduct: true,
          singleUnambiguousProduct: true,
          readable: true,
          completeSilhouette: false,
          confidence: 0.9,
          reason: "Pieds coupés : fournir une photo complète",
        },
      ],
    });
    await expect(run()).rejects.toThrow(/Pieds coupés/);
    await expect(run()).rejects.toThrow(/Pieds coupés/);
    expect(mocks.sourceReview).toHaveBeenCalledOnce();
    expect(mocks.cachedRoom).not.toHaveBeenCalled();
    expect(mocks.edit).not.toHaveBeenCalled();
  });
  it("retries unavailable source inspection without approval or image generation", async () => {
    render.engineVersions!.prompt = "spatial-v4";
    mocks.sourceReview.mockRejectedValueOnce(new Error("offline"));
    await expect(run()).rejects.toMatchObject({ code: "retry" });
    expect(mocks.edit).not.toHaveBeenCalled();
    await run();
    expect(mocks.edit).toHaveBeenCalledOnce();
    expect(mocks.complete).toHaveBeenCalledOnce();
  });
  it("uses additional real views for v3 generation and independent review", async () => {
    render.engineVersions!.prompt = "spatial-v3";
    product.views = [
      {
        id: "side-view",
        assetId: "side",
        type: "top",
        widthPx: 600,
        heightPx: 400,
        validationStatus: "valid",
        createdAt: new Date(),
      },
    ];
    await run();
    expect(
      mocks.edit.mock.calls[0]![0].references.map(
        (item: { role: string }) => item.role,
      ),
    ).toEqual([
      "composition",
      "product_front",
      "spatial_guide",
      "product_detail",
    ]);
    expect(mocks.edit.mock.calls[0]![0].prompt).toContain('"top"');
    expect(mocks.review.mock.calls[0]![0].products[0].views[0].view).toBe(
      "top",
    );
    expect(mocks.complete.mock.calls[0]![2].spatialEvidence.engine).toBe(
      "spatial-v3",
    );
  });
  it("refuses a missing admitted view before starting a paid image call", async () => {
    render.engineVersions!.prompt = "spatial-v3";
    product.views = [
      {
        id: "missing",
        assetId: "missing",
        type: "side",
        widthPx: 600,
        heightPx: 400,
        validationStatus: "valid",
        createdAt: new Date(),
      },
    ];
    await expect(run()).rejects.toThrow(/vue catalogue/);
    expect(mocks.edit).not.toHaveBeenCalled();
  });
  it("pins v2 global geometry across a QA retry without rerunning legacy analysis", async () => {
    render.engineVersions!.prompt = "spatial-v2";
    mocks.review.mockRejectedValueOnce(new Error("review offline"));
    await expect(run()).rejects.toMatchObject({ code: "retry" });
    await run();
    expect(mocks.cachedRoom).toHaveBeenCalledOnce();
    expect(mocks.estimate).not.toHaveBeenCalled();
    expect(mocks.edit).toHaveBeenCalledOnce();
    expect(mocks.complete.mock.calls[0]![2].spatialEvidence.engine).toBe(
      "spatial-v2",
    );
    expect(
      mocks.complete.mock.calls[0]![2].spatialEvidence.scene.cameraUncertainty
        .source,
    ).toBe("model_estimate_not_statistical");
  });
  it("checkpoints generation, then retries only unavailable QA", async () => {
    mocks.review.mockRejectedValueOnce(new Error("provider offline"));
    await expect(run()).rejects.toMatchObject({ code: "retry" });
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(renders.rows[0]!.attemptCount).toBe(1);
    expect(renders.rows[0]!.estimatedCostUsd).toBeCloseTo(0.16);
    await run();
    expect(renders.rows[0]!.attemptCount).toBe(1);
    expect(renders.rows[0]!.estimatedCostUsd).toBeCloseTo(0.19);
    expect(mocks.edit).toHaveBeenCalledTimes(1);
    expect(mocks.estimate).toHaveBeenCalledTimes(1);
    expect(mocks.review).toHaveBeenCalledTimes(2);
    expect(mocks.review.mock.calls[1]![0].model).toBe("frozen-vision");
    expect(mocks.complete).toHaveBeenCalledOnce();
    expect(
      mocks.complete.mock.calls[0]![2].spatialEvidence.plan.calibration,
    ).toBe("approximate");
    expect(
      mocks.edit.mock.calls[0]![0].references.map(
        (r: { role: string }) => r.role,
      ),
    ).toEqual(["composition", "product_front", "spatial_guide"]);
  });
  it("never repeats an ambiguous paid generation", async () => {
    mocks.edit.mockResolvedValue({
      status: "failed",
      estimatedCostUsd: 0.1,
      durationMs: 1,
      provider: "openai",
      model: "frozen-image",
      error: { code: "timeout", message: "timeout" },
      images: [],
    });
    await expect(run()).rejects.toMatchObject({ code: "provider_unknown" });
    await expect(run()).rejects.toMatchObject({ code: "provider_unknown" });
    expect(mocks.edit).toHaveBeenCalledOnce();
    expect(renders.rows[0]!.attemptCount).toBe(1);
    expect(renders.rows[0]!.estimatedCostUsd).toBeCloseTo(0.13);
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it("limits visual corrections to one and never delivers rejected candidates", async () => {
    mocks.review.mockResolvedValue({
      ...accepted,
      accepted: false,
      productIdentityPreserved: false,
      repairFeedback: "Restore the distinctive neck",
    });
    await expect(run()).rejects.toThrow();
    expect(mocks.edit).toHaveBeenCalledTimes(2);
    expect(renders.rows[0]!.attemptCount).toBe(2);
    expect(renders.rows[0]!.estimatedCostUsd).toBeCloseTo(0.29);
    expect(mocks.edit.mock.calls[1]![0].prompt).toContain("distinctive neck");
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it("fences cancellation during generation", async () => {
    mocks.edit.mockImplementationOnce(async () => {
      await renders.updateOne(
        { id: render.id },
        { $set: { status: "cancelled" } },
      );
      return {
        status: "succeeded",
        estimatedCostUsd: 0.1,
        durationMs: 1,
        images: [{ data: room }],
      };
    });
    await expect(run()).rejects.toThrow();
    expect(mocks.review).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it("resumes an already generated correction even when the time for a new correction has elapsed", async () => {
    mocks.review
      .mockResolvedValueOnce({
        ...accepted,
        accepted: false,
        productIdentityPreserved: false,
        repairFeedback: "neck",
      })
      .mockRejectedValueOnce(new Error("review offline"));
    await expect(run()).rejects.toMatchObject({ code: "retry" });
    expect(mocks.edit).toHaveBeenCalledTimes(2);
    render.execution!.deadlineAt = new Date(Date.now() + 90_000);
    await renders.updateOne(
      { id: render.id },
      { $set: { "execution.deadlineAt": render.execution!.deadlineAt } },
    );
    await run();
    expect(mocks.edit).toHaveBeenCalledTimes(2);
    expect(mocks.complete).toHaveBeenCalledOnce();
  });
  it.each([false, true])(
    "preserves every protected pixel and refuses changed aspect ratio (volume mask: %s)",
    async (volumeMask) => {
      const prepared = await prepareSpatialEdit(
        room,
        input.placementPoint,
        { widthCm: 42, heightCm: 80, depthCm: 45 },
        estimate,
        volumeMask
          ? { support: globalRoom.surfaces[0]!, reflectiveRegions: [] }
          : undefined,
      );
      const green = await sharp(room).tint("#00ff00").png().toBuffer();
      const output = await sharp(
        await restoreSpatialBackground(prepared, green),
      )
        .removeAlpha()
        .raw()
        .toBuffer();
      const source = await sharp(room).removeAlpha().raw().toBuffer();
      for (let i = 0; i < 600 * 400; i++)
        if (prepared.composition.maskRaw[i * 4 + 3] !== 0) {
          if (
            !output
              .subarray(i * 3, i * 3 + 3)
              .equals(source.subarray(i * 3, i * 3 + 3))
          )
            throw new Error(`Protected pixel changed at ${i}`);
        }
      const square = await sharp(room).resize(300, 300).png().toBuffer();
      await expect(restoreSpatialBackground(prepared, square)).rejects.toThrow(
        /cadrage/,
      );
    },
  );
});
