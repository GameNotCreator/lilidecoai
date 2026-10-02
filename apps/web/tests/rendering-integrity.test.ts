import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { ImageEditingRequest, ImageReference } from "@lili/ai-router";
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
  config: {
    aiMockMode: false,
    openaiApiKey: "test-only",
    openaiVisionModel: "test-vision",
    openaiModel: "test-image",
    storefrontImageModel: "test-isolated-image",
    openaiBaseUrl: "https://invalid.test/v1",
    openaiQuality: "high",
    openaiMaxCostUsd: 2,
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
vi.mock("../lib/server/scale-estimation", () => ({
  SCALE_ESTIMATION_VERSION: "scale-test",
  markPoints: async (buffer: Buffer) => buffer,
  getOrEstimateSceneScale: vi.fn(async () => ({
    spans: [0, 1, 2].map(() => ({
      pixelsPerCm: 2.5,
      scaleSource: "vision",
      confidence: "high",
    })),
    lighting: null,
  })),
  STOREFRONT_SCALE_PROFILE: "storefront-placement-v1",
}));
vi.mock("../lib/server/ai", () => ({
  selectEditingProvider: (_mode: unknown, _quality: unknown, _preferred: unknown, model?: string) => ({
    route: { provider: "openai", degradedMode: false },
    provider: { model: model ?? "test-image", edit: mocks.edit },
  }),
  selectSceneAnalysisProvider: vi.fn(),
  inspectImagesWithGoogle: vi.fn(),
}));
import { createRender } from "../lib/server/rendering";
import { getOrEstimateSceneScale } from "../lib/server/scale-estimation";
import { stopRender } from "../lib/server/render-lifecycle";
import * as storefrontPlacementReview from "../lib/server/ai/storefront-placement-review";

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
let preflightRequest: typeof reviewRequest;
let reviewCalls: number;
let inspectionFailure: boolean;
let obstacle: boolean;
let preflightVerticalPixelsPerCm: number;
let preflightWidthPixelsPerCm: number | null;
let scenePreflightNames: string[];
let scenePreflightTexts: string[];
let reviewRequest: {
  input: Array<{
    content: Array<{ type: string; image_url?: string; text?: string }>;
  }>;
} | null;

const passed = () => ({
  passed: true,
  score: 0.95,
  reason: "Conforme aux références.",
});

function structuredReview(
  body: NonNullable<typeof reviewRequest>,
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

/** Inject a historical admitted contract at the fixture's storage boundary. */
async function runHistoricalStorefrontRender(
  scaleEstimation = "storefront-scene-pose-v3",
  promptVersion = "storefront-realistic-placement-v3",
  imageQuality: "medium" | "high" = "medium",
) {
  const insert = renders.insertOne;
  renders.insertOne = async row => {
    const versions = row.engineVersions as NonNullable<RenderDocument["engineVersions"]>;
    versions.scaleEstimation = scaleEstimation;
    versions.composite = "storefront-isolated-product-v4";
    versions.prompt = promptVersion;
    versions.imageQuality = imageQuality;
    versions.quality = promptVersion === "storefront-isolated-camera-detail-v8"
      ? "storefront-realistic-detail-v4" : "storefront-realistic-placement-v3";
    row.promptVersion = promptVersion;
    return insert(row);
  };
  try {
    return await createRender(db, "org", request, "storefront:visitor-1");
  } finally {
    renders.insertOne = insert;
  }
}

/** Inspect actual delivered pixels rather than only the request's scale field. */
async function deliveredProductBox() {
  const roomAsset = await mocks.read(db, "room");
  const delivered = mocks.store.mock.calls.at(-1)![1];
  const decode = (buffer: Buffer) => sharp(buffer).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  const [room, result] = await Promise.all([decode(roomAsset.buffer), decode(delivered.buffer)]);
  expect(result.info).toMatchObject({ width: room.info.width, height: room.info.height, channels: 3 });
  let left = room.info.width, right = -1, top = room.info.height, bottom = -1;
  for (let y = 0; y < room.info.height; y++) {
    for (let x = 0; x < room.info.width; x++) {
      const pixel = (y * room.info.width + x) * 3;
      if ([0, 1, 2].some(channel => result.data[pixel + channel] !== room.data[pixel + channel])) {
        left = Math.min(left, x); right = Math.max(right, x);
        top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
    }
  }
  return { left, top, bottom, width: right - left + 1, height: bottom - top + 1 };
}

function cameraGuideWindow(prompt: string) {
  const contract = prompt.split("CAMERA GUIDE WINDOW: ")[1]?.split(". image1 shows")[0];
  expect(contract).toBeDefined();
  return JSON.parse(contract!) as {
    originalFrame: { width: number; height: number };
    window: { left: number; top: number; width: number; height: number };
  };
}

async function opaqueRoomMock(input: ImageEditingRequest): Promise<Buffer> {
  const frame = await sharp(input.composition).metadata();
  const width = frame.width!;
  const height = frame.height!;
  const sourceWidth = 400, sourceHeight = 300;
  const offsetX = (width - sourceWidth) / 2, offsetY = (height - sourceHeight) / 2;
  const rectangles = request.simplePlacements!.map(placement => {
    const productWidth = 10 * preflightWidthPixelsPerCm!;
    const productHeight = 20 * preflightVerticalPixelsPerCm;
    const x = Math.round(placement.placementPoint.x * sourceWidth) + offsetX;
    const y = Math.round(placement.placementPoint.y * sourceHeight) + offsetY;
    return `<rect x="${x - productWidth / 2}" y="${y - productHeight}" width="${productWidth}" height="${productHeight}" fill="#aa6633"/>`;
  });
  return sharp(input.composition).removeAlpha().composite([{ input: Buffer.from(
    `<svg width="${width}" height="${height}">${rectangles.join("")}</svg>`,
  ) }]).webp({ lossless: true }).toBuffer();
}

beforeEach(async () => {
  vi.spyOn(storefrontPlacementReview, "reviewStorefrontPlacement");
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
  mocks.edit.mockReset().mockImplementation(async (input: ImageEditingRequest) => ({
    provider: "openai",
    model: (renders.rows.at(-1)?.engineVersions as RenderDocument["engineVersions"])?.editModel ?? "test-image",
    status: "succeeded",
    durationMs: 1,
    estimatedCostUsd: 0.1,
    attemptCount: 1,
    images: [{ data: input.productIsolation ? await sharp({ create: { width: 600, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite((input.references ?? []).filter((reference: ImageReference) => reference.role.startsWith("product_")).map((_reference: ImageReference, index: number, all: ImageReference[]) => ({
        input: Buffer.from(`<svg width="40" height="80"><rect width="40" height="80" fill="#aa6633"/></svg>`),
        left: Math.round((index + 0.5) * 600 / all.length) - 20, top: 100,
      }))).webp({ lossless: true }).toBuffer() :
      (renders.rows.at(-1)?.engineVersions as RenderDocument["engineVersions"])?.composite === "storefront-room-integration-v5"
        ? await opaqueRoomMock(input) : input.composition, mimeType: "image/webp" }],
    safety: { blocked: false },
  }));
  vi.mocked(getOrEstimateSceneScale).mockClear();
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
  preflightRequest = null;
  reviewCalls = 0;
  inspectionFailure = false;
  obstacle = false;
  preflightVerticalPixelsPerCm = 2.5;
  preflightWidthPixelsPerCm = 2.5;
  scenePreflightNames = [];
  scenePreflightTexts = [];
  reviewRequest = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init: RequestInit) => {
      if (init.body instanceof FormData)
        return new Response("cleanup unavailable", { status: 502 });
      const payload = JSON.parse(String(init.body));
      if (["storefront_scene_preflight", "storefront_scene_pose_preflight", "storefront_scene_width_pose_preflight"].includes(payload.text?.format?.name)) {
        if (inspectionFailure) throw new Error("offline");
        scenePreflightNames.push(payload.text.format.name);
        scenePreflightTexts.push(payload.input[0].content[0].text);
        const withPose = payload.text.format.name !== "storefront_scene_preflight";
        const withWidth = payload.text.format.name === "storefront_scene_width_pose_preflight";
        return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify({
          points: request.simplePlacements!.map((_, index) => ({ index: index + 1, pixelsPerCm: preflightVerticalPixelsPerCm,
            supportKind: "floor", imageClear: true, clarityScore: 1, targetVisible: true, supportVisible: true,
            obstacleAtPoint: obstacle, obstacleName: obstacle ? "old vase" : null,
            obstacleBox: obstacle ? { xMin: 0, yMin: 0, xMax: 1, yMax: 1 } : null, evidence: "Sol libre et perspective lisible.",
            ...(withPose ? { cameraElevationDegrees: 25, cameraRollDegrees: 0, shortposeEvidence: "Dessus des meubles visible." } : {}),
            ...(withWidth ? { widthPixelsPerCm: preflightWidthPixelsPerCm } : {}),
          })),
        }) }] }] });
      }
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
      if (["storefront_placement_review", "storefront_realistic_placement_review", "storefront_realistic_detail_review", "storefront_room_integration_review"].includes(payload.text?.format?.name)) {
        reviewRequest = payload;
        reviewCalls++;
        if (qualityUnavailable) return new Response("offline", { status: 503 });
        const text = payload.input[1].content[0].text as string;
        const placementData = JSON.parse(text.split("Placement contracts: ")[1]!.split(". ")[0]!) as Array<{ id: string; expectedBox: Record<string, number>; placementPoint?: { x: number; y: number } }>;
        const realistic = payload.text.format.name !== "storefront_placement_review";
        const checks = ["present", "identity", "position", "scale", "perspective", "contact", "edges", "occlusion", "noDuplicate"];
        return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify({
          accepted: true, score: 0.95, confidence: 0.95, photoUsable: passed(), backgroundPreserved: passed(), noUnrequestedProducts: passed(), feedback: "Placement conforme.",
          products: placementData.map(({ id, expectedBox, placementPoint }) => ({ id, confidence: 0.95, observedBox: expectedBox, foregroundOccluded: false,
            ...(realistic ? { observedContact: placementPoint } : {}),
            checks: { ...Object.fromEntries(checks.map(name => [name, name === "identity" && reviewPayload.identityFailure ? { ...passed(), passed: false } : passed()])),
              ...(payload.text.format.name === "storefront_room_integration_review" ? { supportIntegration: passed() } : {}),
              ...(realistic ? { gravity: passed(), silhouetteComplete: passed(), photographicCoherence: reviewPayload.photographicFailure ? { ...passed(), passed: false } : passed(),
                referenceScale: text.includes('"realHeightCm"') ? passed() : null } : {}) } })),
        }) }] }] });
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
      if (stage === "preflight") preflightRequest = payload;
      else {
        reviewRequest = payload;
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
  vi.restoreAllMocks();
});

describe("restricted spatial admission", () => {
  it("does not admit unprofiled v11 products when only solid-base v12 is enabled", async () => {
    Object.assign(mocks.config, { spatialAdmissionMode: "solid-base-only", spatialOrganizationIds: ["org"] });
    try {
      await expect(createRender(db, "org", { engine: "spatial", workflow: "standard", placement: request.placement,
        placementPoint: { x: 0.5, y: 0.8 }, idempotencyKey: crypto.randomUUID() })).rejects.toThrow(/uniquement les paniers/);
      expect(mocks.reserve).not.toHaveBeenCalled();
      expect(mocks.edit).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      delete (mocks.config as Record<string, unknown>).spatialAdmissionMode;
      delete (mocks.config as Record<string, unknown>).spatialOrganizationIds;
    }
  });
  it("rejects an invalid matte service before credit reservation or any provider", async () => {
    Object.assign(mocks.config, { spatialAdmissionMode: "solid-base-only", spatialOrganizationIds: ["org"], mattingUrl: "http://untrusted.example", mattingToken: "test", mattingTimeoutMs: 60000 });
    await products.updateOne({ id: "p0" }, { $set: { spatialMetadata: { measurementConvention: "outside", dimensionSource: "catalog", supports: ["table"], characteristicParts: [], contactProfile: "solid-base", volumeFamily: "vase" } } });
    try {
      await expect(createRender(db, "org", { engine: "spatial", workflow: "standard", placement: request.placement,
        placementPoint: { x: 0.5, y: 0.8 }, idempotencyKey: crypto.randomUUID() })).rejects.toThrow(/configuration du service/);
      expect(mocks.reserve).not.toHaveBeenCalled();
      expect(mocks.edit).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      for (const key of ["spatialAdmissionMode", "spatialOrganizationIds", "mattingUrl", "mattingToken", "mattingTimeoutMs"])
        delete (mocks.config as Record<string, unknown>)[key];
    }
  });
});

describe("simple render orchestration with offline providers", () => {
  it("admits V9 full-room generation with a frozen high-quality model and one room-integration review", async () => {
    await scenes.updateOne({ id: "scene" }, { $set: { publicSessionId: "storefront:visitor-1" } });
    request.simplePlacements = request.simplePlacements!.map((item, index) => ({
      ...item, placementPoint: { ...item.placementPoint, y: [0.55, 0.85, 0.7][index]! },
    }));
    const read = mocks.read.getMockImplementation()!;
    const catalogues = await Promise.all(["#a02020", "#20a020", "#2020a0"].map(background =>
      sharp({ create: { width: 64, height: 80, channels: 3, background } }).png().toBuffer(),
    ));
    mocks.read.mockImplementation(async (...args) => {
      const original = await read(...args);
      const index = ["original-0", "original-1", "original-2"].indexOf(args[1]);
      return index >= 0 ? { ...original, buffer: catalogues[index]! } : original;
    });
    const insert = renders.insertOne;
    renders.insertOne = async row => {
      expect(row).toMatchObject({ promptVersion: "storefront-room-integration-v9", engineVersions: {
        prompt: "storefront-room-integration-v9", composite: "storefront-room-integration-v5",
        quality: "storefront-room-integration-review-v5", scaleEstimation: "storefront-scene-width-pose-v4",
        editModel: "test-isolated-image", imageQuality: "high",
      } });
      return insert(row);
    };
    const result = await createRender(db, "org", request, "storefront:visitor-1");
    expect(result).toMatchObject({ status: "succeeded", promptVersion: "storefront-room-integration-v9",
      qualityDecision: { status: "accepted", version: "storefront-room-integration-review-v5" },
      engineVersions: { composite: "storefront-room-integration-v5", imageQuality: "high", editModel: "test-isolated-image" } });
    expect(mocks.edit).toHaveBeenCalledOnce();
    const edit = mocks.edit.mock.calls[0]![0] as ImageEditingRequest;
    expect(edit.quality).toBe("high");
    expect(edit.productIsolation).not.toBe(true);
    expect(edit.productIsolationCameraFirst).not.toBe(true);
    expect(edit.targetMask).toMatchObject({ role: "target_mask", mimeType: "image/png" });
    const originals = edit.references!.filter(reference => reference.role.startsWith("product_"));
    expect(originals.map(reference => Buffer.from(reference.data))).toEqual(await Promise.all(
      ["original-1", "original-2", "original-0"].map(async id => (await mocks.read(db, id)).buffer),
    ));
    expect(originals).toHaveLength(3);
    const room = edit.references!.filter(reference => reference.role === "room_original" || reference.role === "composition");
    const guides = edit.references!.filter(reference => reference.role === "spatial_guide");
    expect(room).toHaveLength(1);
    expect(guides).toHaveLength(1);
    expect(room[0]!.mimeType).toBe("image/png");
    // The adapter's legacy editable role is named composition. Its pixels,
    // rather than that internal name, must be the untouched original room.
    expect(edit.references![0]).toBe(room[0]);
    expect(edit.prompt).toMatch(/image1.*(?:untouched|original).*room/i);
    expect(edit.prompt).toMatch(/image2.*(?:first|product).*?(?:product|catalogue|identity)/i);
    expect(edit.prompt).toMatch(/image3.*guide/i);
    expect(edit.prompt).not.toContain("Return ONLY 3 isolated");
    const base = await sharp(room[0]!.data).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const original = await sharp((await mocks.read(db, "room")).buffer).removeAlpha().raw().toBuffer();
    const unpadded = await sharp(base.data, { raw: { width: base.info.width, height: base.info.height, channels: 3 } })
      .extract({ left: Math.round((base.info.width - 400) / 2), top: Math.round((base.info.height - 300) / 2), width: 400, height: 300 }).raw().toBuffer();
    expect(unpadded).toEqual(original);
    expect(await sharp(edit.targetMask!.data).metadata()).toMatchObject({ format: "png", width: base.info.width, height: base.info.height, hasAlpha: true });
    const output = await mocks.edit.mock.results[0]!.value;
    expect(await sharp(output.images[0].data).metadata()).toMatchObject({ hasAlpha: false });
    const review = vi.mocked(storefrontPlacementReview.reviewStorefrontPlacement).mock.calls[0]![0];
    expect(review).toMatchObject({ realism: true, fastReview: true, roomIntegration: true });
    expect(review).not.toHaveProperty("detailReview");
    expect(review).not.toHaveProperty("generatedProducts");
    expect(reviewRequest).toMatchObject({ reasoning: { effort: "low" }, max_output_tokens: 6000,
      text: { format: { name: "storefront_room_integration_review" } } });
    expect(reviewRequest!.input[1]!.content.filter(entry => entry.type === "input_image")).toHaveLength(5);
    expect(edit.deadlineMs! - Date.now()).toBeLessThanOrEqual(135_000);
    expect(review.deadlineMs).toBeLessThanOrEqual((renders.rows[0]!.createdAt as Date).getTime() + 180_000);
    expect(attempts.rows.find(row => row.stage === "generating_final")).toMatchObject({ promptVersion: "storefront-room-integration-v9", model: "test-isolated-image", estimatedCostUsd: 0.1 });
    expect(attempts.rows.filter(row => row.stage === "storefront_placement_review")).toHaveLength(1);
    expect(attempts.rows.find(row => row.stage === "storefront_placement_review")!.promptVersion).toBe("storefront-room-integration-review-v5");
    expect(scenePreflightNames).toEqual(["storefront_scene_width_pose_preflight"]);
    expect(reviewCalls).toBe(1);
    expect(mocks.capture).toHaveBeenCalledOnce();
  });

  it.each([1, 2, 3])("retains %s repeated-SKU placements as separate V9 catalogue references and review IDs", async count => {
    await scenes.updateOne({ id: "scene" }, { $set: { publicSessionId: "storefront:visitor-1" } });
    request.simplePlacements = request.simplePlacements!.slice(0, count).map((item, index) => ({
      ...item, productId: "p0", placementPoint: { ...item.placementPoint, y: [0.55, 0.85, 0.7][index]! },
    }));
    const result = await createRender(db, "org", request, "storefront:visitor-1");
    expect(result.status).toBe("succeeded");
    const edit = mocks.edit.mock.calls[0]![0] as ImageEditingRequest;
    const originals = edit.references!.filter(reference => reference.role.startsWith("product_"));
    expect(originals).toHaveLength(count);
    expect(originals.every(reference => Buffer.from(reference.data).equals(Buffer.from(originals[0]!.data)))).toBe(true);
    const review = vi.mocked(storefrontPlacementReview.reviewStorefrontPlacement).mock.calls[0]![0];
    expect(review.products.map(item => item.id)).toEqual(Array.from({ length: count }, (_, index) => `p0:${index}`));
    expect(review).not.toHaveProperty("generatedProducts");
    expect(reviewRequest!.input[1]!.content.filter(entry => entry.type === "input_image")).toHaveLength(count + 2);
    expect(mocks.edit).toHaveBeenCalledOnce();
    expect(reviewCalls).toBe(1);
  });

  it("uses V9 guide width 6 and body height 4 independently and allows contact shading in the local mask", async () => {
    await scenes.updateOne({ id: "scene" }, { $set: { publicSessionId: "storefront:visitor-1" } });
    request.simplePlacements = [request.simplePlacements![0]!];
    preflightVerticalPixelsPerCm = 4;
    preflightWidthPixelsPerCm = 6;
    await createRender(db, "org", request, "storefront:visitor-1");
    const edit = mocks.edit.mock.calls[0]![0] as ImageEditingRequest;
    const guide = edit.references!.find(reference => reference.role === "spatial_guide")!;
    const decoded = await sharp(guide.data).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const offsetX = (decoded.info.width - 400) / 2;
    const offsetY = (decoded.info.height - 300) / 2;
    const blueXs: number[] = [];
    const y = Math.round(200 + offsetY);
    for (let x = 0; x < decoded.info.width; x++) {
      const offset = (y * decoded.info.width + x) * 3;
      const [red, green, blue] = [...decoded.data.subarray(offset, offset + 3)];
      if (blue! > red! + 40 && blue! > green! + 20) blueXs.push(x);
    }
    expect(Math.abs(Math.min(...blueXs) - 50 - offsetX)).toBeLessThanOrEqual(2);
    expect(Math.abs(Math.max(...blueXs) - 110 - offsetX)).toBeLessThanOrEqual(2);
    const mask = await sharp(edit.targetMask!.data).raw().toBuffer({ resolveWithObject: true });
    const alpha = (x: number, row: number) => mask.data[(Math.round(row + offsetY) * mask.info.width + Math.round(x + offsetX)) * 4 + 3];
    expect(alpha(80, 240)).toBe(0);
    expect(alpha(80, 244)).toBe(0);
    expect(mask.data[3]).toBe(255);
    const box = await deliveredProductBox();
    // The scene model generated a 60x80 volume directly. No isolated 40x80
    // sprite is resized to 60x120 or re-stamped over its generated floor pixels.
    expect(box.width).toBe(60);
    expect(box.height).toBe(80);
    expect(box.bottom).toBe(239);
    expect(edit.productIsolation).not.toBe(true);
  });

  it.each(["wrong aspect", "transparent"])("refuses V9 %s output before QA, delivery or another image call", async failure => {
    await scenes.updateOne({ id: "scene" }, { $set: { publicSessionId: "storefront:visitor-1" } });
    const output = failure === "wrong aspect"
      ? await sharp({ create: { width: 600, height: 300, channels: 3, background: "#aaaaaa" } }).webp({ lossless: true }).toBuffer()
      : await sharp({ create: { width: 450, height: 300, channels: 4, background: "#00000000" } }).webp({ lossless: true }).toBuffer();
    mocks.edit.mockResolvedValue({ provider: "openai", model: "test-isolated-image", status: "succeeded",
      durationMs: 1, estimatedCostUsd: 0.1, attemptCount: 1, images: [{ data: output, mimeType: "image/webp" }], safety: { blocked: false } });
    await expect(createRender(db, "org", request, "storefront:visitor-1")).rejects.toThrow();
    expect(mocks.edit).toHaveBeenCalledOnce();
    expect(reviewCalls).toBe(0);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(renders.rows[0]!).toMatchObject({ status: "failed", creditCharged: false });
    expect(renders.rows[0]!.resultAssetId).toBeUndefined();
    expect(attempts.rows.find(row => row.stage === "generating_final")!.estimatedCostUsd).toBe(0.1);
  });

  it("retains the admitted V9 edit model when live configuration changes before execution", async () => {
    await scenes.updateOne({ id: "scene" }, { $set: { publicSessionId: "storefront:visitor-1" } });
    const saved = mocks.config.storefrontImageModel;
    const insert = renders.insertOne;
    renders.insertOne = async row => {
      mocks.config.storefrontImageModel = "changed-after-admission";
      return insert(row);
    };
    try {
      const result = await createRender(db, "org", request, "storefront:visitor-1");
      expect(result.engineVersions?.editModel).toBe(saved);
      expect(result.model).toBe(saved);
      expect(attempts.rows.find(row => row.stage === "generating_final")!.model).toBe(saved);
      expect(renders.rows[0]!.requestSnapshot).toMatchObject({ input: { simplePlacements: request.simplePlacements } });
      expect(mocks.edit).toHaveBeenCalledOnce();
    } finally {
      mocks.config.storefrontImageModel = saved;
    }
  });

  it("freezes V9 contracts and the original placement snapshot for durable queue admission", async () => {
    await scenes.updateOne({ id: "scene" }, { $set: { publicSessionId: "storefront:visitor-1" } });
    const assets = documentStore();
    for (const id of ["room", "original-0", "original-1", "original-2", "cutout-0", "cutout-1", "cutout-2"])
      await assets.insertOne({ id, organizationId: "org", visibility: id === "room" ? "private" : "published", ownerSessionId: "storefront:visitor-1" });
    mocks.collections.mockReturnValue({ ...mocks.collections.getMockImplementation()!(), assets });
    vi.stubEnv("RENDER_EXECUTION_MODE", "durable");
    try {
      const result = await createRender(db, "org", request, "storefront:visitor-1");
      expect(result.status).toBe("queued");
      expect(renders.rows[0]!).toMatchObject({ engineVersions: {
        prompt: "storefront-room-integration-v9", composite: "storefront-room-integration-v5",
        quality: "storefront-room-integration-review-v5", editModel: "test-isolated-image", imageQuality: "high",
      }, requestSnapshot: { input: { simplePlacements: request.simplePlacements } } });
      expect(mocks.capture).not.toHaveBeenCalled();
      expect(mocks.edit).not.toHaveBeenCalled();
      expect(reviewCalls).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("qualifies a storefront perspective edit once with an optional reference and no second image generation", async () => {
    await scenes.updateOne({ id: "scene" }, { $set: { publicSessionId: "storefront:visitor-1" } });
    const result = await runHistoricalStorefrontRender();
    expect(result).toMatchObject({ status: "succeeded", provider: "openai", attemptCount: 1,
      qualityDecision: { status: "accepted", version: "storefront-realistic-placement-v3" },
      engineVersions: { quality: "storefront-realistic-placement-v3", composite: "storefront-isolated-product-v4", editModel: "test-isolated-image", imageQuality: "medium", scaleEstimation: "storefront-scene-pose-v3" } });
    expect(mocks.edit).toHaveBeenCalledTimes(1);
    const imageRequest = mocks.edit.mock.calls[0]![0];
    expect(imageRequest).toMatchObject({ quality: "medium", preserveBackground: true, productIsolation: true });
    expect(imageRequest).not.toHaveProperty("productIsolationCameraFirst");
    expect(imageRequest.targetMask).toBeUndefined();
    expect(imageRequest.prompt).toContain("genuinely transparent RGBA canvas");
    expect(imageRequest.prompt).toContain("exactly 3 equal vertical columns");
    expect(imageRequest.prompt).toContain("images1..3 are the original catalogue identity");
    expect(imageRequest.prompt).toContain("image4 is the unmarked room");
    expect(imageRequest.prompt).toContain("BOTTOM-MIDDLE");
    expect(imageRequest.prompt).toContain("contactInOriginalRoom");
    expect(imageRequest.references.filter((reference: ImageReference) => reference.role.startsWith("product_"))).toHaveLength(3);
    expect(imageRequest.references.some((reference: ImageReference) => reference.role === "room_original")).toBe(true);
    const cleanRoomPixels = await sharp(Buffer.from(imageRequest.scene)).removeAlpha().raw().toBuffer();
    // The scene fixture is gray; a brown pasted product must not bias image1.
    let containsPastedColour = false;
    for (let index = 0; index < cleanRoomPixels.length; index += 3) {
      if (cleanRoomPixels[index] !== cleanRoomPixels[index + 1] || cleanRoomPixels[index + 1] !== cleanRoomPixels[index + 2]) {
        containsPastedColour = true;
        break;
      }
    }
    expect(containsPastedColour).toBe(false);
    const guide = imageRequest.references.find((reference: ImageReference) => reference.role === "spatial_guide");
    expect(guide).toBeDefined();
    expect(Buffer.from(guide.data)).not.toEqual(Buffer.from(imageRequest.scene));
    const sceneSize = await sharp(Buffer.from(imageRequest.scene)).metadata();
    const guideSize = await sharp(Buffer.from(guide.data)).metadata();
    expect([guideSize.width, guideSize.height]).toEqual([sceneSize.width, sceneSize.height]);
    expect(imageRequest.deadlineMs - Date.now()).toBeLessThanOrEqual(135_000);
    expect(reviewCalls).toBe(1);
    expect(preflightRequest).toBeNull();
    expect(attempts.rows.filter(row => row.stage === "storefront_placement_review")).toHaveLength(1);
    expect(getOrEstimateSceneScale).not.toHaveBeenCalled();
    expect(result.qualityChecks.every(check => !check.name.includes("lighting"))).toBe(true);
    expect(result.resultUrl).toBe(result.compositeUrl);
    expect(reviewRequest!.input[1]!.content.filter(entry => entry.type === "input_image")).toHaveLength(5);
    expect(scenePreflightNames).toEqual(["storefront_scene_pose_preflight"]);
    expect(scenePreflightTexts[0]).not.toContain("product widths in centimetres");
  });
  it("retains the admitted V8 high-quality native-detail contract and catalogue source order", async () => {
    await scenes.updateOne({ id: "scene" }, { $set: { publicSessionId: "storefront:visitor-1" } });
    request.simplePlacements = request.simplePlacements!.map((item, index) => ({
      ...item, placementPoint: { ...item.placementPoint, y: [0.55, 0.85, 0.7][index]! },
    }));
    const read = mocks.read.getMockImplementation()!;
    const catalogues = await Promise.all(["#a02020", "#20a020", "#2020a0"].map(background =>
      sharp({ create: { width: 64, height: 80, channels: 3, background } }).png().toBuffer(),
    ));
    mocks.read.mockImplementation(async (...args) => {
      const original = await read(...args);
      const index = ["original-0", "original-1", "original-2"].indexOf(args[1]);
      return index >= 0 ? { ...original, buffer: catalogues[index]! } : original;
    });
    const insert = renders.insertOne;
    renders.insertOne = async row => {
      // Assert the immutable admission contract before any provider could run.
      expect(row).toMatchObject({ promptVersion: "storefront-isolated-camera-detail-v8", engineVersions: {
        prompt: "storefront-isolated-camera-detail-v8", imageQuality: "high", composite: "storefront-isolated-product-v4",
        scaleEstimation: "storefront-scene-width-pose-v4", quality: "storefront-realistic-detail-v4",
      } });
      return insert(row);
    };
    const result = await runHistoricalStorefrontRender("storefront-scene-width-pose-v4", "storefront-isolated-camera-detail-v8", "high");
    expect(result).toMatchObject({ status: "succeeded", promptVersion: "storefront-isolated-camera-detail-v8",
      qualityDecision: { version: "storefront-realistic-detail-v4" },
      engineVersions: { prompt: "storefront-isolated-camera-detail-v8", imageQuality: "high", quality: "storefront-realistic-detail-v4" } });
    expect(renders.rows[0]!.promptVersion).toBe("storefront-isolated-camera-detail-v8");
    expect(mocks.edit).toHaveBeenCalledTimes(1);
    const imageRequest = mocks.edit.mock.calls[0]![0];
    expect(imageRequest).toMatchObject({ productIsolation: true, productIsolationCameraFirst: true, quality: "high" });
    expect(imageRequest.prompt).toContain("image1 is the annotated room geometry guide");
    expect(imageRequest.prompt).toContain("image2 is the unmarked room CAMERA");
    expect(imageRequest.prompt).toContain("images3..5 are the original catalogue identity photographs");
    expect(imageRequest.prompt).toContain("Column1 matches image3, column2 matches image4");
    const contracts = JSON.parse(imageRequest.prompt.split("PER-COLUMN CONTRACTS: ")[1]!.split("\n")[0]!) as Array<{
      column: number; sourceImage: number; guideLabel: number; name: string;
    }>;
    expect(contracts.map(({ column, sourceImage, guideLabel, name }) => ({ column, sourceImage, guideLabel, name }))).toEqual([
      { column: 1, sourceImage: 3, guideLabel: 2, name: "Product 1" },
      { column: 2, sourceImage: 4, guideLabel: 3, name: "Product 2" },
      { column: 3, sourceImage: 5, guideLabel: 1, name: "Product 0" },
    ]);
    // Rendering retains its internal references; the provider's tested flag
    // moves the guide/room before these ordered catalogues at the API boundary.
    expect(imageRequest.references.map((reference: ImageReference) => reference.role)).toEqual([
      "room_original", "product_front", "product_front", "product_front", "spatial_guide",
    ]);
    const originals = imageRequest.references.filter((reference: ImageReference) => reference.role.startsWith("product_"));
    expect(originals.map((reference: ImageReference) => Buffer.from(reference.data))).toEqual([catalogues[1], catalogues[2], catalogues[0]]);
    const windowContract = cameraGuideWindow(imageRequest.prompt);
    expect(windowContract.originalFrame).toEqual({ width: 400, height: 300 });
    const guides = imageRequest.references.filter((reference: ImageReference) => reference.role === "spatial_guide");
    expect(guides).toHaveLength(1);
    const guideSize = await sharp(Buffer.from(guides[0]!.data)).metadata();
    const { window } = windowContract;
    expect(Math.abs(guideSize.width! * window.height - guideSize.height! * window.width)).toBeLessThanOrEqual(Math.max(window.width, window.height));
    expect(imageRequest.prompt).toContain("Coordinates in the contracts still refer to the full original room");
    expect(attempts.rows.find(row => row.stage === "generating_final")!.promptVersion).toBe("storefront-isolated-camera-detail-v8");
    expect(attempts.rows.filter(row => row.stage === "storefront_placement_review")).toHaveLength(1);
    expect(attempts.rows.find(row => row.stage === "storefront_placement_review")!.promptVersion).toBe("storefront-realistic-detail-v4");
    const detailRequest = vi.mocked(storefrontPlacementReview.reviewStorefrontPlacement).mock.calls[0]![0];
    expect(detailRequest).toMatchObject({ detailReview: true, fastReview: true, generatedProducts: {
      productIds: ["p1:1", "p2:2", "p0:0"], image: { mimeType: "image/webp" },
    } });
    const generated = await mocks.edit.mock.results[0]!.value;
    expect(Buffer.from(detailRequest.generatedProducts!.image.data)).toEqual(Buffer.from(generated.images[0]!.data));
    expect(Buffer.from(detailRequest.generatedProducts!.image.data)).not.toEqual(Buffer.from(detailRequest.generated.data));
    const nativeSize = await sharp(Buffer.from(detailRequest.generatedProducts!.image.data)).metadata();
    expect(nativeSize).toMatchObject({ width: 600, height: 300, channels: 4 });
    expect(reviewRequest).toMatchObject({ text: { format: { name: "storefront_realistic_detail_review" } } });
    const reviewContent = reviewRequest!.input[1]!.content;
    const detailLabelIndex = reviewContent.findIndex(entry => entry.text?.startsWith("GENERATED PRODUCT VIEW DETAIL WITH COLUMN IDS "));
    expect(detailLabelIndex).toBeGreaterThan(0);
    expect(JSON.parse(reviewContent[detailLabelIndex]!.text!.split("GENERATED PRODUCT VIEW DETAIL WITH COLUMN IDS ")[1]!)).toEqual(["p1:1", "p2:2", "p0:0"]);
    const nativeReviewImage = reviewContent[detailLabelIndex + 1]!;
    expect(nativeReviewImage.type).toBe("input_image");
    const transportedNative = Buffer.from(nativeReviewImage.image_url!.split(",")[1]!, "base64");
    const expectedNativeView = await sharp(Buffer.from(generated.images[0]!.data))
      .flatten({ background: "#eeeeee" }).webp({ lossless: true }).toBuffer();
    expect(transportedNative).toEqual(expectedNativeView);
    expect(await sharp(transportedNative).metadata()).toMatchObject({ width: 600, height: 300, channels: 3 });
    expect(reviewContent.filter(entry => entry.type === "input_image")).toHaveLength(6);
    expect(detailRequest.deadlineMs).toBeLessThanOrEqual((renders.rows[0]!.createdAt as Date).getTime() + 180_000);
    expect(imageRequest.deadlineMs - Date.now()).toBeLessThanOrEqual(135_000);
    expect(vi.mocked(storefrontPlacementReview.reviewStorefrontPlacement)).toHaveBeenCalledOnce();
    expect(reviewCalls).toBe(1);
  });
  it("retains the V8 local camera guide containing one through three products", async () => {
    await scenes.updateOne({ id: "scene" }, { $set: { publicSessionId: "storefront:visitor-1" } });
    const placements = request.simplePlacements!;
    const windows: Array<ReturnType<typeof cameraGuideWindow>["window"]> = [];
    for (const count of [1, 2, 3]) {
      request.simplePlacements = placements.slice(0, count);
      request.idempotencyKey = crypto.randomUUID();
      const result = await runHistoricalStorefrontRender("storefront-scene-width-pose-v4", "storefront-isolated-camera-detail-v8", "high");
      expect(result.status).toBe("succeeded");
      const imageRequest = mocks.edit.mock.calls.at(-1)![0];
      const { originalFrame, window } = cameraGuideWindow(imageRequest.prompt);
      expect(originalFrame).toEqual({ width: 400, height: 300 });
      expect(window.left).toBeGreaterThanOrEqual(0);
      expect(window.top).toBeGreaterThanOrEqual(0);
      expect(window.left + window.width).toBeLessThanOrEqual(originalFrame.width);
      expect(window.top + window.height).toBeLessThanOrEqual(originalFrame.height);
      expect(window.width * window.height).toBeLessThan(originalFrame.width * originalFrame.height);
      for (const placement of request.simplePlacements) {
        const contactX = Math.round(placement.placementPoint.x * originalFrame.width);
        const contactY = Math.round(placement.placementPoint.y * originalFrame.height);
        expect(contactX).toBeGreaterThanOrEqual(window.left);
        expect(contactX).toBeLessThan(window.left + window.width);
        expect(contactY).toBeGreaterThanOrEqual(window.top);
        expect(contactY).toBeLessThan(window.top + window.height);
      }
      const guides = imageRequest.references.filter((reference: ImageReference) => reference.role === "spatial_guide");
      expect(guides).toHaveLength(1);
      const guideSize = await sharp(Buffer.from(guides[0]!.data)).metadata();
      expect(Math.max(guideSize.width!, guideSize.height!)).toBeLessThanOrEqual(1024);
      // Uniform enlargement may round by one pixel, but cannot warp the crop.
      expect(Math.abs(guideSize.width! * window.height - guideSize.height! * window.width)).toBeLessThanOrEqual(Math.max(window.width, window.height));
      expect(imageRequest).toMatchObject({ quality: "high", productIsolationCameraFirst: true });
      expect(imageRequest.references.filter((reference: ImageReference) => reference.role.startsWith("product_"))).toHaveLength(count);
      const detailRequest = vi.mocked(storefrontPlacementReview.reviewStorefrontPlacement).mock.calls.at(-1)![0];
      const generated = await mocks.edit.mock.results.at(-1)!.value;
      expect(detailRequest.generatedProducts!.productIds).toEqual(placements.slice(0, count).map((placement, index) => `${placement.productId}:${index}`));
      expect(Buffer.from(detailRequest.generatedProducts!.image.data)).toEqual(Buffer.from(generated.images[0]!.data));
      windows.push(window);
    }
    expect(windows[0]!.width).toBeLessThan(windows[2]!.width);
    expect(windows[0]!.width * windows[0]!.height).toBeLessThan(windows[2]!.width * windows[2]!.height);
    expect(mocks.edit).toHaveBeenCalledTimes(3);
    expect(reviewCalls).toBe(3);
  });
  it("sizes an admitted V8 isolated product from horizontal 6 rather than vertical 4 pixels per centimetre", async () => {
    await scenes.updateOne({ id: "scene" }, { $set: { publicSessionId: "storefront:visitor-1" } });
    request.simplePlacements = [request.simplePlacements![0]!];
    preflightVerticalPixelsPerCm = 4;
    preflightWidthPixelsPerCm = 6;
    const result = await runHistoricalStorefrontRender("storefront-scene-width-pose-v4", "storefront-isolated-camera-detail-v8", "high");
    expect(result).toMatchObject({ status: "succeeded", promptVersion: "storefront-isolated-camera-detail-v8",
      engineVersions: { scaleEstimation: "storefront-scene-width-pose-v4", prompt: "storefront-isolated-camera-detail-v8", imageQuality: "high" } });
    expect(scenePreflightNames).toEqual(["storefront_scene_width_pose_preflight"]);
    expect(scenePreflightTexts[0]).toContain("product widths in centimetres, in the exact placement order: [10].");
    // Native mock is 40x80: 10 cm horizontal width at 6 px/cm becomes 60x120 uniformly.
    const box = await deliveredProductBox();
    expect(box).toEqual({ left: 51, top: 121, bottom: 240, width: 60, height: 120 });
    expect(Math.abs(box.left + (box.width - 1) / 2 - 80)).toBeLessThanOrEqual(0.5);
    expect(mocks.edit).toHaveBeenCalledTimes(1);
    expect(mocks.edit.mock.calls[0]![0].productIsolationCameraFirst).toBe(true);
    expect(mocks.edit.mock.calls[0]![0].quality).toBe("high");
    expect(reviewCalls).toBe(1);
    expect(mocks.edit.mock.calls[0]![0].deadlineMs - Date.now()).toBeLessThanOrEqual(135_000);
    expect(attempts.rows.filter(row => row.stage === "storefront_scene_preflight")).toHaveLength(1);
    expect(attempts.rows.filter(row => row.stage === "generating_final")).toHaveLength(1);
    expect(attempts.rows.filter(row => row.stage === "storefront_placement_review")).toHaveLength(1);
    expect(attempts.rows.every(row => typeof row.estimatedCostUsd === "number")).toBe(true);
    expect(result.resultUrl).toBe(result.compositeUrl);
    expect(mocks.capture).toHaveBeenCalledOnce();
  });
  it("rejects an unknown horizontal scale before image generation even when vertical scale is known", async () => {
    await scenes.updateOne({ id: "scene" }, { $set: { publicSessionId: "storefront:visitor-1" } });
    request.simplePlacements = [request.simplePlacements![0]!];
    preflightVerticalPixelsPerCm = 4;
    preflightWidthPixelsPerCm = null;
    await expect(createRender(db, "org", request, "storefront:visitor-1")).rejects.toThrow(/largeur/);
    expect(scenePreflightNames).toEqual(["storefront_scene_width_pose_preflight"]);
    expect(mocks.edit).not.toHaveBeenCalled();
    expect(reviewCalls).toBe(0);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalled();
    expect(attempts.rows.filter(row => row.stage === "storefront_scene_preflight")).toHaveLength(1);
    expect(attempts.rows.some(row => row.stage === "generating_final")).toBe(false);
    expect(renders.rows[0]).toMatchObject({ status: "failed", creditCharged: false });
    expect(renders.rows[0]!.resultAssetId).toBeUndefined();
  });
  it("retains the admitted v3 vertical scale instead of applying the new horizontal scale contract", async () => {
    await scenes.updateOne({ id: "scene" }, { $set: { publicSessionId: "storefront:visitor-1" } });
    request.simplePlacements = [request.simplePlacements![0]!];
    preflightVerticalPixelsPerCm = 4;
    preflightWidthPixelsPerCm = 6;
    const result = await runHistoricalStorefrontRender();
    expect(result).toMatchObject({ status: "succeeded", engineVersions: { scaleEstimation: "storefront-scene-pose-v3" } });
    expect(scenePreflightNames).toEqual(["storefront_scene_pose_preflight"]);
    expect(scenePreflightTexts[0]).not.toContain("product widths in centimetres");
    expect(await deliveredProductBox()).toEqual({ left: 61, top: 161, bottom: 240, width: 40, height: 80 });
    expect(mocks.edit).toHaveBeenCalledTimes(1);
  });
  it("keeps the product-first prompt and absent camera-first flag for an admitted width-v4 job", async () => {
    await scenes.updateOne({ id: "scene" }, { $set: { publicSessionId: "storefront:visitor-1" } });
    const result = await runHistoricalStorefrontRender("storefront-scene-width-pose-v4");
    expect(result).toMatchObject({ status: "succeeded", promptVersion: "storefront-realistic-placement-v3",
      engineVersions: { prompt: "storefront-realistic-placement-v3", scaleEstimation: "storefront-scene-width-pose-v4", imageQuality: "medium" } });
    const imageRequest = mocks.edit.mock.calls[0]![0];
    expect(imageRequest.quality).toBe("medium");
    expect(imageRequest).not.toHaveProperty("productIsolationCameraFirst");
    expect(imageRequest.prompt).toContain("images1..3 are the original catalogue identity photographs");
    expect(imageRequest.prompt).toContain("image4 is the unmarked room CAMERA AND LIGHT REFERENCE ONLY");
    expect(imageRequest.prompt).toContain("image5 is the annotated room geometry guide CAMERA REFERENCE ONLY");
    expect(imageRequest.prompt).toContain("Column1 matches image1, column2 matches image2, and so on.");
    expect(imageRequest.prompt).not.toContain("establishes the OUTPUT CAMERA");
    const contracts = JSON.parse(imageRequest.prompt.split("PER-COLUMN CONTRACTS: ")[1]!.split("\n")[0]!) as Array<{ sourceImage: number }>;
    expect(contracts.map(contract => contract.sourceImage)).toEqual([1, 2, 3]);
    expect(attempts.rows.find(row => row.stage === "generating_final")!.promptVersion).toBe("storefront-realistic-placement-v3");
    expect(mocks.edit).toHaveBeenCalledTimes(1);
    expect(reviewCalls).toBe(1);
  });
  it("retains the full-frame camera-first guide for an admitted v5 job", async () => {
    await scenes.updateOne({ id: "scene" }, { $set: { publicSessionId: "storefront:visitor-1" } });
    const result = await runHistoricalStorefrontRender("storefront-scene-width-pose-v4", "storefront-isolated-camera-first-v5");
    expect(result).toMatchObject({ status: "succeeded", promptVersion: "storefront-isolated-camera-first-v5",
      engineVersions: { prompt: "storefront-isolated-camera-first-v5", scaleEstimation: "storefront-scene-width-pose-v4", imageQuality: "medium" } });
    const imageRequest = mocks.edit.mock.calls[0]![0];
    expect(imageRequest).toMatchObject({ quality: "medium", productIsolation: true, productIsolationCameraFirst: true });
    expect(imageRequest.prompt).toContain("image1 is the annotated room geometry guide");
    expect(imageRequest.prompt).toContain("image2 is the unmarked room CAMERA");
    expect(imageRequest.prompt).toContain("images3..5 are the original catalogue identity photographs");
    expect(imageRequest.prompt).not.toContain("CAMERA GUIDE WINDOW");
    const guides = imageRequest.references.filter((reference: ImageReference) => reference.role === "spatial_guide");
    expect(guides).toHaveLength(1);
    const guideSize = await sharp(Buffer.from(guides[0]!.data)).metadata();
    const sceneSize = await sharp(Buffer.from(imageRequest.scene)).metadata();
    expect([guideSize.width, guideSize.height]).toEqual([sceneSize.width, sceneSize.height]);
    expect(guideSize.width! * guideSize.height!).toBeGreaterThan(400 * 300);
    expect(renders.rows[0]!.promptVersion).toBe("storefront-isolated-camera-first-v5");
    expect(attempts.rows.find(row => row.stage === "generating_final")!.promptVersion).toBe("storefront-isolated-camera-first-v5");
    expect(mocks.edit).toHaveBeenCalledTimes(1);
    expect(reviewCalls).toBe(1);
  });
  it("retains a medium-quality local camera guide for an admitted v6 job", async () => {
    await scenes.updateOne({ id: "scene" }, { $set: { publicSessionId: "storefront:visitor-1" } });
    request.simplePlacements = [request.simplePlacements![0]!];
    const result = await runHistoricalStorefrontRender("storefront-scene-width-pose-v4", "storefront-isolated-camera-window-v6");
    expect(result).toMatchObject({ status: "succeeded", promptVersion: "storefront-isolated-camera-window-v6",
      engineVersions: { prompt: "storefront-isolated-camera-window-v6", scaleEstimation: "storefront-scene-width-pose-v4", imageQuality: "medium" } });
    const imageRequest = mocks.edit.mock.calls[0]![0];
    expect(imageRequest).toMatchObject({ quality: "medium", productIsolation: true, productIsolationCameraFirst: true });
    const { originalFrame, window } = cameraGuideWindow(imageRequest.prompt);
    expect(originalFrame).toEqual({ width: 400, height: 300 });
    expect(window.width * window.height).toBeLessThan(400 * 300);
    expect(imageRequest.references.filter((reference: ImageReference) => reference.role === "spatial_guide")).toHaveLength(1);
    expect(renders.rows[0]!.promptVersion).toBe("storefront-isolated-camera-window-v6");
    expect(attempts.rows.find(row => row.stage === "generating_final")!.promptVersion).toBe("storefront-isolated-camera-window-v6");
    expect(imageRequest.deadlineMs - Date.now()).toBeLessThanOrEqual(135_000);
    expect(mocks.edit).toHaveBeenCalledTimes(1);
    expect(reviewCalls).toBe(1);
  });
  it("retains high-quality generation with the original final review for an admitted v7 job", async () => {
    await scenes.updateOne({ id: "scene" }, { $set: { publicSessionId: "storefront:visitor-1" } });
    const result = await runHistoricalStorefrontRender("storefront-scene-width-pose-v4", "storefront-isolated-camera-window-high-v7", "high");
    expect(result).toMatchObject({ status: "succeeded", promptVersion: "storefront-isolated-camera-window-high-v7",
      qualityDecision: { version: "storefront-realistic-placement-v3" },
      engineVersions: { prompt: "storefront-isolated-camera-window-high-v7", imageQuality: "high", quality: "storefront-realistic-placement-v3" } });
    const imageRequest = mocks.edit.mock.calls[0]![0];
    expect(imageRequest).toMatchObject({ quality: "high", productIsolation: true, productIsolationCameraFirst: true });
    expect(cameraGuideWindow(imageRequest.prompt).originalFrame).toEqual({ width: 400, height: 300 });
    const finalReview = vi.mocked(storefrontPlacementReview.reviewStorefrontPlacement).mock.calls[0]![0];
    expect(finalReview).not.toHaveProperty("detailReview");
    expect(finalReview).not.toHaveProperty("generatedProducts");
    expect(reviewRequest!.input[1]!.content.filter(entry => entry.type === "input_image")).toHaveLength(5);
    expect(attempts.rows.find(row => row.stage === "generating_final")!.promptVersion).toBe("storefront-isolated-camera-window-high-v7");
    expect(attempts.rows.find(row => row.stage === "storefront_placement_review")!.promptVersion).toBe("storefront-realistic-placement-v3");
    expect(vi.mocked(storefrontPlacementReview.reviewStorefrontPlacement)).toHaveBeenCalledOnce();
    expect(mocks.edit).toHaveBeenCalledTimes(1);
    expect(reviewCalls).toBe(1);
  });
  it("reserves high-quality image and review costs with the actual model before generating a storefront product", async () => {
    await scenes.updateOne({ id: "scene" }, { $set: { publicSessionId: "storefront:visitor-1" } });
    request.simplePlacements = [request.simplePlacements![0]!];
    const config = { ...mocks.config };
    Object.assign(mocks.config, { storefrontImageModel: "gpt-image-2.5-sunburst", openaiVisionModel: "gpt-6-astra", openaiServiceTier: "default" });
    vi.stubEnv("RENDER_MAX_COST_USD", "2");
    try {
      // Missing provider token usage conservatively records the real preflight
      // allowance ($0.55). Sunburst high ($1) plus review ($0.55) exceeds $2;
      // medium quality or the unrelated default image model would wrongly fit.
      await expect(createRender(db, "org", request, "storefront:visitor-1")).rejects.toThrow(/Budget du rendu atteint/);
      expect(scenePreflightNames).toEqual(["storefront_scene_width_pose_preflight"]);
      expect(attempts.rows.filter(row => row.stage === "storefront_scene_preflight")).toHaveLength(1);
      expect(attempts.rows.find(row => row.stage === "storefront_scene_preflight")!.estimatedCostUsd).toBeCloseTo(0.55);
      expect(renders.rows[0]).toMatchObject({ status: "failed", creditCharged: false, engineVersions: { imageQuality: "high", editModel: "gpt-image-2.5-sunburst" } });
      expect(mocks.edit).not.toHaveBeenCalled();
      expect(reviewCalls).toBe(0);
      expect(mocks.capture).not.toHaveBeenCalled();
      expect(mocks.release).toHaveBeenCalled();
      expect(attempts.rows.some(row => row.stage === "generating_final")).toBe(false);
    } finally {
      Object.assign(mocks.config, config);
      delete (mocks.config as Record<string, unknown>).openaiServiceTier;
      vi.unstubAllEnvs();
    }
  });
  it("rejects an opaque generated product before review, completion or a paid retry", async () => {
    await scenes.updateOne({ id: "scene" }, { $set: { publicSessionId: "storefront:visitor-1" } });
    const opaque = await sharp({ create: { width: 600, height: 300, channels: 3, background: "#ffffff" } }).webp().toBuffer();
    mocks.edit.mockResolvedValue({ provider: "openai", model: "test-isolated-image", status: "succeeded",
      durationMs: 1, estimatedCostUsd: 0.1, attemptCount: 1, images: [{ data: opaque, mimeType: "image/webp" }], safety: { blocked: false } });
    await expect(runHistoricalStorefrontRender("storefront-scene-width-pose-v4", "storefront-isolated-camera-detail-v8", "high")).rejects.toThrow();
    expect(mocks.edit).toHaveBeenCalledTimes(1);
    expect(reviewCalls).toBe(0);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(renders.rows[0]!).toMatchObject({ status: "failed", creditCharged: false });
    expect(renders.rows[0]!.resultAssetId).toBeUndefined();
  });
  it.each(["identity", "unavailable", "photographic"])("does not deliver or retry a storefront %s defect", async failure => {
    await scenes.updateOne({ id: "scene" }, { $set: { publicSessionId: "storefront:visitor-1" } });
    reviewPayload.identityFailure = failure === "identity";
    qualityUnavailable = failure === "unavailable";
    reviewPayload.photographicFailure = failure === "photographic";
    await expect(createRender(db, "org", request, "storefront:visitor-1")).rejects.toThrow();
    expect(mocks.edit).toHaveBeenCalledTimes(1);
    expect(reviewCalls).toBe(1);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(renders.rows[0]!.status).toBe("failed");
    expect(renders.rows[0]!.resultAssetId).toBeUndefined();
    expect(typeof renders.rows[0]!.compositeAssetId).toBe("string");
    const candidate = mocks.store.mock.calls.at(-1)![1];
    expect(candidate.visibility).toEqual({ ownerSessionId: "storefront:visitor-1" });
  });
  it("still refuses an occupied storefront point before qualification or delivery", async () => {
    await scenes.updateOne({ id: "scene" }, { $set: { publicSessionId: "storefront:visitor-1" } });
    obstacle = true;
    await expect(createRender(db, "org", request, "storefront:visitor-1")).rejects.toThrow(/occupé/);
    expect(mocks.edit).not.toHaveBeenCalled();
    expect(reviewCalls).toBe(0);
    expect(mocks.capture).not.toHaveBeenCalled();
  });
  it("uses a supplied reference without a second scale call and preserves it in the replay snapshot", async () => {
    await scenes.updateOne({ id: "scene" }, { $set: { publicSessionId: "storefront:visitor-1" } });
    request.simplePlacements = [{ ...request.simplePlacements![0]!, pixelsPerCm: 2.5 }];
    request.scaleReference = { realHeightCm: 20, basePoint: { x: 0.15, y: 0.8 },
      topPoint: { x: 0.15, y: 0.633333 }, sameDepthConfirmed: true };
    const result = await createRender(db, "org", request, "storefront:visitor-1");
    expect(result.status).toBe("succeeded");
    expect(result.engineVersions?.scaleEstimation).toBe("storefront-scene-width-pose-v4");
    expect(mocks.edit).toHaveBeenCalledTimes(1);
    expect(mocks.edit.mock.calls[0]![0].references.some((reference: { role: string }) => reference.role === "spatial_guide")).toBe(true);
    expect(renders.rows[0]!.requestSnapshot).toMatchObject({ input: { scaleReference: request.scaleReference } });
    expect(result.qualityChecks.some(check => check.name.includes("referenceScale"))).toBe(true);
  });
  it("journals an uncertain storefront image once without review, delivery or another image attempt", async () => {
    await scenes.updateOne({ id: "scene" }, { $set: { publicSessionId: "storefront:visitor-1" } });
    mocks.edit.mockResolvedValue({ provider: "openai", model: "test-image", status: "failed",
      durationMs: 90_000, estimatedCostUsd: 0.4, attemptCount: 1, images: [], safety: { blocked: false },
      error: { code: "timeout", message: "Résultat incertain.", retryable: true } });
    await expect(createRender(db, "org", request, "storefront:visitor-1")).rejects.toThrow();
    expect(mocks.edit).toHaveBeenCalledTimes(1);
    expect(reviewCalls).toBe(0);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(attempts.rows.filter(row => row.stage === "generating_final" && row.usageOutcome === "unknown")).toHaveLength(1);
    expect(renders.rows[0]!).toMatchObject({ status: "failed", creditCharged: false });
    expect(renders.rows[0]!.resultAssetId).toBeUndefined();
  });
  it("loads the room and product inputs concurrently and reads a repeated asset once", async () => {
    request.simplePlacements = request.simplePlacements!.map((item) => ({
      ...item,
      productId: "p0",
    }));
    const read = mocks.read.getMockImplementation()!;
    mocks.read.mockClear();
    let releaseRoom!: () => void;
    const roomReady = new Promise<void>((resolve) => {
      releaseRoom = resolve;
    });
    let cutoutStarted!: () => void;
    const cutoutReady = new Promise<void>((resolve) => {
      cutoutStarted = resolve;
    });
    mocks.read.mockImplementation(async (...args) => {
      if (args[1] === "room") await roomReady;
      if (args[1] === "cutout-0") cutoutStarted();
      return read(...args);
    });
    const pending = createRender(db, "org", request);
    try {
      // Starting the cutout read must not depend on the room response.
      await cutoutReady;
      expect(mocks.read.mock.calls.map((args) => args[1])).toEqual(
        expect.arrayContaining(["room", "original-0", "cutout-0"]),
      );
    } finally {
      releaseRoom();
    }
    expect((await pending).status).toBe("succeeded");
    for (const id of ["room", "original-0", "cutout-0"])
      expect(
        mocks.read.mock.calls.filter((args) => args[1] === id),
      ).toHaveLength(1);
    expect(reviewCalls).toBe(1);
    expect(preflightRequest).not.toBeNull();
  });

  it("uses the first available original view without fetching unused views", async () => {
    products.rows[0]!.views = [
      { type: "back", assetId: "unused-back", validationStatus: "valid" },
      { type: "front", assetId: "missing-front", validationStatus: "valid" },
      { type: "side", assetId: "original-side", validationStatus: "valid" },
    ];
    const read = mocks.read.getMockImplementation()!;
    const expectedOriginal = await read(db, "original-side");
    mocks.read
      .mockClear()
      .mockImplementation(async (...args) =>
        args[1] === "missing-front" ? null : read(...args),
      );
    expect((await createRender(db, "org", request)).status).toBe("succeeded");
    const reads = mocks.read.mock.calls.map((args) => args[1]);
    expect(reads).toContain("missing-front");
    expect(reads).toContain("original-side");
    expect(reads).not.toContain("unused-back");
    expect(reads).not.toContain("original-0");
    const originals = preflightRequest!.input[1]!.content.filter(
      (item) => item.type === "input_image",
    ).slice(2);
    expect(originals[0]!.image_url).toContain(
      expectedOriginal.buffer.toString("base64"),
    );
  });

  it("reviews all three originals before delivery and persists the normalized replay contract", async () => {
    const result = await createRender(db, "org", request, "guest:visitor-1");
    expect(result).toMatchObject({
      status: "succeeded",
      qualityDecision: { status: "accepted" },
      creditCharged: true,
    });
    expect(mocks.capture).toHaveBeenCalledOnce();
    // A13: the quality control is a paid vision call and used to be invisible.
    // Every paid step of the render now leaves a journal row.
    const steps = attempts.rows.map((row) => row.stage);
    expect(steps).toContain("generating_final");
    expect(steps).toContain("visual_preflight");
    expect(steps).toContain("quality_check");
    expect(
      attempts.rows.every((row) => typeof row.estimatedCostUsd === "number"),
    ).toBe(true);
    // A16: every image a render stores belongs to the visitor session that
    // asked for it, never to the shared demo organization.
    expect(mocks.store.mock.calls.length).toBeGreaterThan(0);
    for (const [, input] of mocks.store.mock.calls) {
      expect(input).toMatchObject({
        kind: "render",
        visibility: { ownerSessionId: "guest:visitor-1" },
      });
    }
    expect(renders.rows[0]!.requestSnapshot).toMatchObject({
      version: 1,
      input: {
        workflow: "simple_point",
        simplePlacements: request.simplePlacements,
      },
    });
    const content = reviewRequest!.input[1]!.content;
    expect(content.filter((item) => item.type === "input_image")).toHaveLength(
      6,
    );
    const originals = content
      .filter((item) => item.type === "input_image")
      .slice(3);
    const original = await mocks.read(db, "original-0");
    expect(
      originals.every((item) =>
        item.image_url?.endsWith(original.buffer.toString("base64")),
      ),
    ).toBe(true);
  });
  it.each(["identity", "missing-check"])(
    "does not deliver or debit on %s failure",
    async (failure) => {
      if (failure === "identity") reviewPayload.identityFailure = true;
      else reviewPayload.missingCheck = true;
      await expect(createRender(db, "org", request)).rejects.toThrow(/qualité/);
      expect(mocks.capture).not.toHaveBeenCalled();
      expect(renders.rows[0]).toMatchObject({
        status: "failed",
        creditCharged: false,
        qualityDecision: {
          status: failure === "identity" ? "rejected" : "unavailable",
        },
      });
      expect(renders.rows[0]!.compositeAssetId).toBeTruthy();
      expect(renders.rows[0]!.resultAssetId).toBeUndefined();
    },
  );
  it("cannot resurrect a cancellation made during image generation", async () => {
    const edit = mocks.edit.getMockImplementation()!;
    mocks.edit.mockImplementation(async (input) => {
      await stopRender(
        db,
        renders.rows[0] as unknown as RenderDocument,
        "cancel",
      );
      return edit(input);
    });
    await expect(createRender(db, "org", request)).rejects.toThrow(
      /traitement|annulé/,
    );
    expect(renders.rows[0]!.status).toBe("cancelled");
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(reviewRequest).toBeNull();
  });
  it("does not blame the photograph when automatic scale analysis times out", async () => {
    vi.mocked(getOrEstimateSceneScale).mockResolvedValueOnce({
      spans: [],
      lighting: null,
      cached: false,
      call: {
        outcome: "unknown",
        latencyMs: 60000,
        estimatedCostUsd: 0.03,
        model: "test-vision",
      },
    });
    await expect(createRender(db, "org", request)).rejects.toThrow(
      /Votre photo n’est pas en cause/,
    );
    expect(mocks.edit).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalled();
  });
  it("rejects preflight defects before any image edit or credit capture", async () => {
    preflightRejected = true;
    await expect(createRender(db, "org", request)).rejects.toThrow(
      /avant génération/,
    );
    expect(preflightRequest).not.toBeNull();
    expect(mocks.edit).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalled();
    expect(renders.rows[0]).toMatchObject({
      status: "failed",
      creditCharged: false,
    });
    expect(renders.rows[0]!.resultAssetId).toBeUndefined();
  });
  it("repairs a local integration defect from the original composition and reviews it again", async () => {
    remainingRepairableFailures = 1;
    const result = await createRender(db, "org", request);
    expect(result).toMatchObject({
      status: "succeeded",
      qualityDecision: { status: "accepted" },
      attemptCount: 2,
    });
    expect(mocks.edit).toHaveBeenCalledTimes(2);
    expect(reviewCalls).toBe(2);
    const first = mocks.edit.mock.calls[0]![0];
    const second = mocks.edit.mock.calls[1]![0];
    expect(second.prompt).toContain("halo blanc autour du vase");
    expect(second.composition).toEqual(first.composition);
    expect(second.references).toEqual(first.references);
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(mocks.capture).toHaveBeenCalledOnce();
    expect(
      attempts.rows.filter((row) => row.stage === "quality_check"),
    ).toHaveLength(2);
  });
  it("never retries image generation or delivers when visual review is unavailable", async () => {
    qualityUnavailable = true;
    await expect(createRender(db, "org", request)).rejects.toThrow(/qualité/);
    expect(mocks.edit).toHaveBeenCalledOnce();
    expect(reviewCalls).toBe(1);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalled();
    expect(renders.rows[0]).toMatchObject({
      status: "failed",
      qualityDecision: { status: "unavailable" },
    });
    expect(renders.rows[0]!.resultAssetId).toBeUndefined();
    expect(
      attempts.rows.find((row) => row.stage === "quality_check"),
    ).toMatchObject({ usageOutcome: "unknown" });
  });
  it("limits repeated repairable defects to two candidates", async () => {
    remainingRepairableFailures = 100;
    await expect(createRender(db, "org", request)).rejects.toThrow(/qualité/);
    expect(mocks.edit).toHaveBeenCalledTimes(2);
    expect(reviewCalls).toBe(2);
    expect(mocks.capture).not.toHaveBeenCalled();
  });
  it.each(["preflight", "quality"] as const)(
    "honors cancellation during %s",
    async (stage) => {
      cancelAt = stage;
      await expect(createRender(db, "org", request)).rejects.toThrow(
        /traitement/,
      );
      expect(renders.rows[0]!.status).toBe("cancelled");
      expect(mocks.capture).not.toHaveBeenCalled();
      expect(mocks.edit).toHaveBeenCalledTimes(stage === "preflight" ? 0 : 1);
      expect(renders.rows[0]!.resultAssetId).toBeUndefined();
    },
  );
  // A13 again, at the recording site: an adapter that still prices a failed
  // call says the request reached the model, so its outcome is unknown — not a
  // known, free failure.
  it("journals a priced provider failure as unknown, and a refusal as failed", async () => {
    mocks.edit.mockResolvedValue({
      provider: "openai",
      model: "test-image",
      status: "failed",
      durationMs: 180_000,
      estimatedCostUsd: 0.165,
      attemptCount: 1,
      images: [],
      error: { code: "timeout", message: "timed out", retryable: true },
      safety: { blocked: false },
    });
    await expect(createRender(db, "org", request)).rejects.toThrow();
    const priced = attempts.rows.find(
      (row) => row.stage === "generating_final",
    );
    expect(priced).toMatchObject({
      usageOutcome: "unknown",
      estimatedCostUsd: 0.165,
    });

    attempts.rows.length = 0;
    renders.rows.length = 0;
    request.idempotencyKey = "second-attempt";
    mocks.edit.mockResolvedValue({
      provider: "openai",
      model: "test-image",
      status: "failed",
      durationMs: 200,
      estimatedCostUsd: 0,
      attemptCount: 1,
      images: [],
      error: { code: "moderation_blocked", message: "no", retryable: false },
      safety: { blocked: true },
    });
    await expect(createRender(db, "org", request)).rejects.toThrow();
    expect(
      attempts.rows.find((row) => row.stage === "generating_final"),
    ).toMatchObject({ usageOutcome: "failed", estimatedCostUsd: 0 });
  });

  // PRO-008. Found by the adversarial review as a gap: the render-time gate
  // could be deleted with every test still green. A cutout a model re-rendered
  // must never reach the composite — nor the reservation, nor the provider.
  it("refuses to render a product whose cutout a model re-rendered", async () => {
    for (const row of products.rows) {
      (row.cutout as Record<string, unknown>).synthetic = true;
      (row.cutout as Record<string, unknown>).source = "model";
    }
    await expect(createRender(db, "org", request)).rejects.toThrow(/régénéré/);
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.edit).not.toHaveBeenCalled();
    expect(renders.rows).toHaveLength(0);
  });

  it("refuses to render a product whose cutout has no recorded provenance", async () => {
    for (const row of products.rows) delete row.cutout;
    await expect(createRender(db, "org", request)).rejects.toThrow(
      /provenance|préparation/,
    );
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.edit).not.toHaveBeenCalled();
  });

  // Found by the adversarial review: every image a render stores inherits the
  // scene's expiry, so a scene about to expire minted a result asset already
  // unreadable — and the credit was captured for it anyway.
  it("refuses a render on a scene that expires before it could finish", async () => {
    scenes.rows[0]!.expiresAt = new Date(Date.now() + 60_000);
    await expect(createRender(db, "org", request)).rejects.toThrow(
      /expiration/,
    );
    expect(mocks.edit).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(renders.rows).toHaveLength(0);
  });

  it.each(["inspection", "cleanup"])(
    "stops instead of inserting on top when %s fails",
    async (failure) => {
      inspectionFailure = failure === "inspection";
      obstacle = failure === "cleanup";
      await expect(createRender(db, "org", request)).rejects.toThrow(
        failure === "inspection" ? /analyse/ : /occupé/,
      );
      expect(renders.rows[0]!.status).toBe("failed");
      expect(mocks.edit).not.toHaveBeenCalled();
      expect(mocks.capture).not.toHaveBeenCalled();
    },
  );
});
