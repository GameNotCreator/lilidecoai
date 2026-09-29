import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "mongodb";
import sharp from "sharp";
import { mongoStore } from "./helpers/mongo-store";

const mocks = vi.hoisted(() => ({
  collections: vi.fn(),
  readAsset: vi.fn(),
  fetch: vi.fn(),
  config: {
    aiMockMode: false,
    openaiApiKey: "test-key",
    openaiVisionModel: "test-vision-model",
    openaiBaseUrl: "https://example.invalid/v1",
    openaiServiceTier: "default",
  },
}));
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/mongodb", () => ({ collections: mocks.collections }));
vi.mock("../lib/server/assets", () => ({ readAsset: mocks.readAsset }));
vi.mock("../lib/server/config", () => ({ serverConfig: mocks.config }));

import {
  fetchOpenAIResponse,
  getOrEstimateSceneScale,
  sceneScaleCacheKey,
  type SceneScaleSpan,
} from "../lib/server/scale-estimation";
import type { SceneDocument } from "../lib/server/types";

const db = {} as Db;
const points = [{ x: 0.5, y: 0.7 }];
const kinds = ["standing"] as const;
const span: SceneScaleSpan = {
  pixelsPerCm: 5,
  scaleSource: "vision",
  confidence: "high",
  supportKind: "table",
  supportMaterial: "wood",
  supportGlossy: false,
  referenceKind: "mug",
  impliedFrameWidthCm: 200,
};
const lighting = {
  lightDirection: "left",
  lightElevation: "mid",
  shadowSoftness: "soft",
  colourTemperature: "neutral",
  shadowDirection: "right",
} as const;

let scenes: ReturnType<typeof mongoStore>;
let snapshot: SceneDocument;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.aiMockMode = false;
  mocks.config.openaiApiKey = "test-key";
  mocks.config.openaiVisionModel = "test-vision-model";
  scenes = mongoStore();
  mocks.collections.mockReturnValue({ scenes });
  mocks.readAsset.mockResolvedValue(null);
  mocks.fetch.mockRejectedValue(new Error("Unexpected provider call"));
  vi.stubGlobal("fetch", mocks.fetch);
  snapshot = {
    id: "scene-1",
    organizationId: "org-1",
    assetId: "photo-1",
    status: "uploaded",
    widthPx: 1000,
    heightPx: 750,
    analysis: {},
    publicSessionId: "visitor-1",
    consentAt: new Date(),
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function cachedScene(overrides: Partial<SceneDocument> = {}) {
  return {
    ...snapshot,
    analysis: {
      simpleScale: {
        [sceneScaleCacheKey(points, kinds)]: {
          spans: [span],
          lighting,
          createdAt: new Date(),
          // Real stored estimates include call metadata. Cache consumers must
          // not report this historical call as a newly billed provider call.
          call: {
            outcome: "succeeded",
            model: mocks.config.openaiVisionModel,
            latencyMs: 1200,
            estimatedCostUsd: 0.03,
          },
        },
      },
    },
    ...overrides,
  };
}

describe("scene scale cache after durable admission", () => {
  it.each([undefined, 25_000])("bounds a fresh provider call by 90 seconds and the parent deadline (%s)", async (remaining) => {
    vi.spyOn(sharp.prototype, "composite").mockReturnThis();
    const buffer = await sharp({ create: { width: 100, height: 100, channels: 3, background: "white" } }).webp().toBuffer();
    mocks.readAsset.mockResolvedValue({ buffer });
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
    mocks.fetch.mockImplementation(async () => {
      // The provider can legitimately finish after the former 60s cutoff.
      now += remaining ?? 65_000;
      return Response.json({ status: "completed", output: [{ content: [{ type: "output_text", text: '{"spans":[]}' }] }] });
    });
    const result = await getOrEstimateSceneScale(db, snapshot, points, kinds,
      remaining === undefined ? {} : { deadlineMs: now + remaining });
    expect(timeout).toHaveBeenCalledExactlyOnceWith(remaining ?? 90_000);
    expect(result.call?.outcome).toBe("succeeded");
    expect(result.call?.latencyMs).toBe(remaining ?? 65_000);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not start a paid request after the render deadline has expired", async () => {
    const buffer = await sharp({ create: { width: 100, height: 100, channels: 3, background: "white" } }).webp().toBuffer();
    mocks.readAsset.mockResolvedValue({ buffer });
    const result = await getOrEstimateSceneScale(db, snapshot, points, kinds, { deadlineMs: Date.now() - 1 });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(result.call).toBeUndefined();
    expect(result.spans[0]?.pixelsPerCm).toBeNull();
  });

  it("shares the deadline across service-tier retry and refuses a late retry", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
    mocks.fetch.mockImplementationOnce(async () => {
      now += 70_000;
      return new Response('priority service_tier unavailable', { status: 403 });
    }).mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await fetchOpenAIResponse({ service_tier: "priority" }, 90_000);
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([90_000, 20_000]);
    expect(JSON.parse(mocks.fetch.mock.calls[1]![1].body)).not.toHaveProperty("service_tier");
    mocks.fetch.mockClear();
    mocks.fetch.mockImplementationOnce(async () => {
      now += 90_001;
      return new Response('priority service_tier unavailable', { status: 403 });
    });
    await expect(fetchOpenAIResponse({ service_tier: "priority" }, 90_000)).rejects.toThrow("deadline expired");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("reuses the exact cache entry published after the render snapshot", async () => {
    const current = cachedScene();
    const before = structuredClone(current);
    scenes.rows.push(current);
    const find = vi.spyOn(scenes, "findOne");
    const write = vi.spyOn(scenes, "updateOne");

    const result = await getOrEstimateSceneScale(db, snapshot, points, kinds);

    expect(result).toEqual({ spans: [span], lighting, cached: true });
    expect(result.call).toBeUndefined();
    expect(mocks.readAsset).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(find).toHaveBeenCalledWith(
      {
        id: snapshot.id,
        organizationId: snapshot.organizationId,
        assetId: snapshot.assetId,
        status: { $ne: "deleted" },
        expiresAt: { $gt: expect.any(Date) },
        publicSessionId: snapshot.publicSessionId,
      },
      {
        projection: {
          _id: 0,
          [`analysis.simpleScale.${sceneScaleCacheKey(points, kinds)}`]: 1,
        },
      },
    );
    expect(snapshot.analysis).toEqual({});
    expect(scenes.rows[0]).toEqual(before);
  });

  it("keeps the existing snapshot cache as a lookup-free fast path", async () => {
    const find = vi.spyOn(scenes, "findOne");
    const result = await getOrEstimateSceneScale(
      db,
      cachedScene(),
      points,
      kinds,
    );
    expect(result).toEqual({ spans: [span], lighting, cached: true });
    expect(find).not.toHaveBeenCalled();
    expect(mocks.readAsset).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["different scene", { id: "scene-2" }],
    ["replaced source image", { assetId: "photo-2" }],
    ["different organization", { organizationId: "org-2" }],
    ["different visitor", { publicSessionId: "visitor-2" }],
    ["expired scene", { expiresAt: new Date(0) }],
    ["deleted scene", { status: "deleted" as const }],
  ])("does not reuse the cache of a %s", async (_, overrides) => {
    scenes.rows.push(cachedScene(overrides));
    const result = await getOrEstimateSceneScale(db, snapshot, points, kinds);
    expect(result.cached).toBe(false);
    expect(result.spans[0]?.pixelsPerCm).toBeNull();
    expect(result.call).toBeUndefined();
    expect(mocks.readAsset).toHaveBeenCalledWith(db, snapshot.assetId);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["missing entry", {}],
    ["malformed entry", { spans: null, lighting }],
    ["wrong point count", { spans: [span, span], lighting }],
  ])("ignores a %s without trusting or rewriting it", async (_, entry) => {
    const current = cachedScene({
      analysis: { simpleScale: { [sceneScaleCacheKey(points, kinds)]: entry } },
    });
    scenes.rows.push(current);
    const before = structuredClone(current);
    const result = await getOrEstimateSceneScale(db, snapshot, points, kinds);
    expect(result.cached).toBe(false);
    expect(result.spans[0]?.pixelsPerCm).toBeNull();
    expect(scenes.rows[0]).toEqual(before);
  });

  it("does not reuse another point, placement kind, or model's estimate", async () => {
    scenes.rows.push(cachedScene());
    const moved = await getOrEstimateSceneScale(
      db,
      snapshot,
      [{ x: 0.5001, y: 0.7 }],
      kinds,
    );
    const flat = await getOrEstimateSceneScale(db, snapshot, points, ["flat"]);
    mocks.config.openaiVisionModel = "other-vision-model";
    const otherModel = await getOrEstimateSceneScale(
      db,
      snapshot,
      points,
      kinds,
    );
    expect([moved.cached, flat.cached, otherModel.cached]).toEqual([
      false,
      false,
      false,
    ]);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("preserves fresh estimation and call accounting when both caches miss", async () => {
    // This test verifies cache persistence and provider accounting, not marker
    // pixels. Skip SVG/font rasterization, whose Windows startup alone takes
    // several seconds; keep real image decoding/encoding and estimation logic.
    vi.spyOn(sharp.prototype, "composite").mockReturnThis();
    scenes.rows.push({ ...snapshot });
    const buffer = await sharp({
      create: { width: 200, height: 150, channels: 3, background: "white" },
    })
      .webp()
      .toBuffer();
    mocks.readAsset.mockResolvedValue({ buffer });
    mocks.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "completed",
          output: [
            {
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    spans: [
                      {
                        pointNumber: 1,
                        supportKind: "table",
                        supportMaterial: "wood",
                        supportGlossy: false,
                        supportPlaneId: 1,
                        tenCmPixels: 20,
                        confident: true,
                        frameWidthCm: 100,
                        referenceKind: "mug",
                        referenceRealCm: 10,
                        referencePixels: 20,
                        referenceAxis: "vertical",
                        referenceAtSameDepth: true,
                      },
                    ],
                    lighting,
                  }),
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const fresh = await getOrEstimateSceneScale(db, snapshot, points, kinds);
    expect(fresh.cached).toBe(false);
    expect(fresh.spans[0]?.pixelsPerCm).toBe(2);
    expect(fresh.call).toEqual({
      outcome: "succeeded",
      estimatedCostUsd: 0.03,
      latencyMs: expect.any(Number),
      model: mocks.config.openaiVisionModel,
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const replay = await getOrEstimateSceneScale(db, snapshot, points, kinds);
    expect(replay).toEqual({
      spans: fresh.spans,
      lighting: fresh.lighting,
      cached: true,
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(replay.call).toBeUndefined();
  });

  it("keeps mock and unconfigured paths free of cache and provider I/O", async () => {
    const find = vi.spyOn(scenes, "findOne");
    mocks.config.aiMockMode = true;
    await getOrEstimateSceneScale(db, snapshot, points, kinds);
    mocks.config.aiMockMode = false;
    mocks.config.openaiApiKey = "";
    await getOrEstimateSceneScale(db, snapshot, points, kinds);
    expect(find).not.toHaveBeenCalled();
    expect(mocks.readAsset).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
