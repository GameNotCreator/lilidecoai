import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
vi.mock("server-only", () => ({}));
const config = vi.hoisted(() => ({
  openaiApiKey: "test-only", aiMockMode: false,
  openaiVisionModel: "gpt-6-astra", openaiServiceTier: "default",
  openaiBaseUrl: "https://api.openai.com/v1",
}));
vi.mock("../lib/server/config", () => ({ serverConfig: config }));
import {
  inspectStorefrontScene, parseStorefrontScenePreflight,
  storefrontScenePreflightAllowance,
  storefrontScenePreflightSchema, storefrontScenePosePreflightSchema, storefrontSceneWidthPosePreflightSchema,
  STOREFRONT_SCENE_PREFLIGHT_VERSION, STOREFRONT_POSE_PREFLIGHT_VERSION, STOREFRONT_WIDTH_POSE_PREFLIGHT_VERSION,
  type StorefrontScenePreflightInput,
} from "../lib/server/ai/storefront-scene-preflight";
import { visionObservation } from "../lib/server/ai/openai-vision-cost";
import { DurableExecutionError } from "../lib/server/durable-context";

let room: Uint8Array;
beforeAll(async () => {
  room = new Uint8Array(await sharp({ create: {
    width: 240, height: 180, channels: 3, background: "#eeeeee",
  } }).webp({ lossless: true }).toBuffer());
});

function poseAnswer() {
  return { points: answer().points.map((entry, index) => ({
    ...entry,
    cameraElevationDegrees: index === 1 ? null : index === 0 ? 45 : 20,
    cameraRollDegrees: index === 2 ? null : index === 0 ? 8 : -4,
    shortposeEvidence: index === 1 ? "Angle du sommet incertain ; montants inclinés visibles." : "Les plateaux et montants montrent une vue plongeante.",
  })) };
}
const productHeightsCm = [40, 75, 20];
const productWidthsCm = [40, 35, 60];
function widthPoseAnswer() {
  return { points: poseAnswer().points.map((entry, index) => ({
    ...entry, widthPixelsPerCm: index === 2 ? null : index === 0 ? 6 : 8,
  })) };
}

describe("opt-in storefront independent width and pose preflight", () => {
  it("retains different width/height scales and nullable widths in exact object order", () => {
    expect(STOREFRONT_WIDTH_POSE_PREFLIGHT_VERSION).toBe("storefront-scene-width-pose-v4");
    const result = parseStorefrontScenePreflight(widthPoseAnswer(), points, productHeightsCm, productWidthsCm);
    expect(result.widthPixelsPerCm).toEqual([6, 8, null]);
    expect(result.spans.map((entry) => entry.pixelsPerCm)).toEqual([4, 4, null]);
    expect(result.poses).toEqual(parseStorefrontScenePreflight(poseAnswer(), points, productHeightsCm).poses);
    expect(result.spans.every((entry) => entry.confidence !== "high")).toBe(true);
    expect(productWidthsCm).toEqual([40, 35, 60]);
  });

  it("keeps existing v1/v3 schemas and results unchanged instead of activating width implicitly", () => {
    expect(STOREFRONT_SCENE_PREFLIGHT_VERSION).toBe("storefront-scene-preflight-v1");
    expect(STOREFRONT_POSE_PREFLIGHT_VERSION).toBe("storefront-scene-pose-v3");
    expect(parseStorefrontScenePreflight(answer(), points)).not.toHaveProperty("widthPixelsPerCm");
    expect(parseStorefrontScenePreflight(poseAnswer(), points, productHeightsCm)).not.toHaveProperty("widthPixelsPerCm");
    expect(storefrontScenePreflightSchema.safeParse(widthPoseAnswer()).success).toBe(false);
    expect(storefrontScenePosePreflightSchema.safeParse(widthPoseAnswer()).success).toBe(false);
    expect(storefrontSceneWidthPosePreflightSchema.safeParse(answer()).success).toBe(false);
    expect(storefrontSceneWidthPosePreflightSchema.safeParse(poseAnswer()).success).toBe(false);
    expect(() => parseStorefrontScenePreflight(widthPoseAnswer(), points, productHeightsCm)).toThrow();
  });

  it.each([1, 2, 3])("supports %i points and repeated product dimensions without deduplicating", (count) => {
    const data = widthPoseAnswer(); data.points = data.points.slice(0, count);
    const result = parseStorefrontScenePreflight(data, points.slice(0, count), Array(count).fill(40), Array(count).fill(40));
    expect(result.widthPixelsPerCm).toEqual([6, 8, null].slice(0, count));
    expect(result.inspections).toHaveLength(count);
    expect(result.poses).toHaveLength(count);
  });

  it("leaves an unknown horizontal width null even when height scale and pose are known", () => {
    const data = widthPoseAnswer(); data.points[0]!.widthPixelsPerCm = null;
    const result = parseStorefrontScenePreflight(data, points, productHeightsCm, productWidthsCm);
    expect(result.widthPixelsPerCm?.[0]).toBeNull();
    expect(result.spans[0]!.pixelsPerCm).toBe(4);
    expect(result.poses?.[0]!.cameraElevationDegrees).toBe(45);
  });

  it.each([0.2, 200])("accepts width scale bound %s without coercion", (scale) => {
    const data = widthPoseAnswer(); data.points[0]!.widthPixelsPerCm = scale;
    expect(parseStorefrontScenePreflight(data, points, productHeightsCm, productWidthsCm).widthPixelsPerCm?.[0]).toBe(scale);
  });

  it.each([0, 0.19, 200.01, NaN, Infinity, "6", undefined])("rejects malformed width %s instead of using height", (scale) => {
    const data = widthPoseAnswer(); Object.assign(data.points[0]!, { widthPixelsPerCm: scale });
    expect(() => parseStorefrontScenePreflight(data, points, productHeightsCm, productWidthsCm)).toThrow(/incomplète|invalide/);
  });

  it.each(["widthPixelsPerCm", "cameraElevationDegrees", "cameraRollDegrees", "shortposeEvidence"] as const)(
    "requires the complete opt-in schema including %s", (name) => {
      const data = widthPoseAnswer();
      delete (data.points[0]! as Partial<typeof data.points[0]>)[name];
      expect(() => parseStorefrontScenePreflight(data, points, productHeightsCm, productWidthsCm)).toThrow();
    },
  );

  it.each(["missing", "duplicate", "reordered", "unexpected"])("refuses %s width coverage without remapping a product", (defect) => {
    const data = widthPoseAnswer();
    if (defect === "missing") data.points.pop();
    if (defect === "duplicate") data.points[1]!.index = 1;
    if (defect === "reordered") data.points.reverse();
    if (defect === "unexpected") data.points[0]!.index = 4;
    expect(() => parseStorefrontScenePreflight(data, points, productHeightsCm, productWidthsCm)).toThrow();
  });

  it.each([[], [40], [40, 35], [40, 35, 60, 10], [0, 35, 60], [-40, 35, 60],
    [NaN, 35, 60], [Infinity, 35, 60], ["40", 35, 60], null])(
    "refuses invalid widths before calling the provider (%j)", async (widths) => {
      const fetcher = vi.fn<typeof globalThis.fetch>(); vi.stubGlobal("fetch", fetcher);
      await expect(inspectStorefrontScene({
        ...input(), productHeightsCm, productWidthsCm: widths as number[],
      })).rejects.toMatchObject({ code: "invalid_input", providerCalled: false });
      expect(fetcher).not.toHaveBeenCalled();
      expect(() => parseStorefrontScenePreflight(widthPoseAnswer(), points, productHeightsCm, widths as number[])).toThrow(/largeurs/);
    },
  );

  it("requires product heights for the complete width/pose opt-in before spending", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>(); vi.stubGlobal("fetch", fetcher);
    await expect(inspectStorefrontScene({ ...input(), productWidthsCm })).rejects.toMatchObject({
      code: "invalid_input", providerCalled: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(() => parseStorefrontScenePreflight(widthPoseAnswer(), points, undefined, productWidthsCm)).toThrow(/largeurs/);
  });

  it("requests width, height and pose together in one low-reasoning 25s/6000-token call", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetcher = vi.fn<typeof globalThis.fetch>(async () => Response.json(envelope(widthPoseAnswer())));
    vi.stubGlobal("fetch", fetcher);
    const result = await inspectStorefrontScene({ ...input(), reference, productHeightsCm, productWidthsCm });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(timeout.mock.calls[0]![0]).toBeLessThanOrEqual(25_000);
    expect(result.widthPixelsPerCm).toEqual([6, 8, null]);
    expect(visionObservation(result)?.usage).toEqual(usage);
    const request = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(request).toMatchObject({ reasoning: { effort: "low" }, max_output_tokens: 6000,
      text: { format: { name: "storefront_scene_width_pose_preflight", strict: true } } });
    expect(request.text.format.schema.properties.points.items.required).toContain("widthPixelsPerCm");
    const prompt = request.input[0].content[0].text as string;
    expect(prompt).toContain(JSON.stringify(productWidthsCm));
    expect(prompt).toContain(JSON.stringify(productHeightsCm));
    expect(prompt).toContain("horizontal image-x extent");
    expect(prompt).toContain("includes all visible opaque parts, including handles");
    expect(prompt).toContain("not a semantic body mask");
    expect(prompt).toContain("do not copy the height scale");
    expect(prompt).toContain("height reference constrains height only");
    expect(prompt).toContain("Return null for an unsupported width");
    expect(request.input[0].content.filter((entry: { type: string }) => entry.type === "input_image")).toHaveLength(1);
    expect(storefrontScenePreflightAllowance().estimatedCostUsd).toBe(0.55);
  });

  it("retains observed usage and refuses a late width response without another call", async () => {
    const start = Date.now();
    const fetcher = vi.fn<typeof globalThis.fetch>(async () => {
      vi.spyOn(Date, "now").mockReturnValue(start + 26_000);
      return Response.json(envelope(widthPoseAnswer()));
    });
    vi.stubGlobal("fetch", fetcher);
    const error = await inspectStorefrontScene({
      ...input(), deadlineMs: start + 180_000, productHeightsCm, productWidthsCm,
    }).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "deadline", providerCalled: true });
    expect(visionObservation(error)?.usage).toEqual(usage);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("retains usage for incomplete width output and never retries or falls back to height", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>(async () => Response.json(envelope(poseAnswer())));
    vi.stubGlobal("fetch", fetcher);
    const error = await inspectStorefrontScene({ ...input(), productHeightsCm, productWidthsCm }).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "malformed", providerCalled: true });
    expect(visionObservation(error)?.usage).toEqual(usage);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not retry a width request after network failure or swallow durable cancellation", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>(async () => { throw new Error("offline"); });
    vi.stubGlobal("fetch", fetcher);
    await expect(inspectStorefrontScene({ ...input(), productHeightsCm, productWidthsCm })).rejects.toMatchObject({
      code: "unavailable", providerCalled: true,
    });
    expect(fetcher).toHaveBeenCalledOnce(); fetcher.mockClear();
    const failure = new DurableExecutionError("Lease perdue", "lease_lost");
    fetcher.mockImplementation(async () => { throw failure; });
    await expect(inspectStorefrontScene({ ...input(), productHeightsCm, productWidthsCm })).rejects.toBe(failure);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe("opt-in storefront top-camera pose preflight", () => {
  it("adds ordered nullable pose evidence without changing the v1 schema or output", () => {
    expect(STOREFRONT_SCENE_PREFLIGHT_VERSION).toBe("storefront-scene-preflight-v1");
    expect(STOREFRONT_POSE_PREFLIGHT_VERSION).toBe("storefront-scene-pose-v3");
    expect(parseStorefrontScenePreflight(answer(), points)).not.toHaveProperty("poses");
    expect(storefrontScenePreflightSchema.safeParse(answer()).success).toBe(true);
    expect(storefrontScenePreflightSchema.safeParse(poseAnswer()).success).toBe(false);
    expect(storefrontScenePosePreflightSchema.safeParse(answer()).success).toBe(false);
    const result = parseStorefrontScenePreflight(poseAnswer(), points, productHeightsCm);
    expect(result.poses).toEqual([
      { cameraElevationDegrees: 45, cameraRollDegrees: 8, evidence: "Les plateaux et montants montrent une vue plongeante." },
      { cameraElevationDegrees: null, cameraRollDegrees: -4, evidence: "Angle du sommet incertain ; montants inclinés visibles." },
      { cameraElevationDegrees: 20, cameraRollDegrees: null, evidence: "Les plateaux et montants montrent une vue plongeante." },
    ]);
    expect(result.spans.every((span) => span.confidence !== "high")).toBe(true);
  });

  it("keeps completely unknown camera angles as null without inventing a neutral pose", () => {
    const data = poseAnswer();
    data.points[0]!.cameraElevationDegrees = null;
    data.points[0]!.cameraRollDegrees = null;
    data.points[0]!.shortposeEvidence = "Plans et axe vertical masqués ; pose indéterminée.";
    expect(parseStorefrontScenePreflight(data, points, productHeightsCm).poses?.[0]).toEqual({
      cameraElevationDegrees: null, cameraRollDegrees: null,
      evidence: "Plans et axe vertical masqués ; pose indéterminée.",
    });
  });

  it.each(["missing", "duplicate", "reordered", "unexpected"])("rejects %s pose coverage instead of reassigning another target's angle", (defect) => {
    const data = poseAnswer();
    if (defect === "missing") data.points.pop();
    if (defect === "duplicate") data.points[1]!.index = 1;
    if (defect === "reordered") data.points.reverse();
    if (defect === "unexpected") data.points[0]!.index = 4;
    expect(() => parseStorefrontScenePreflight(data, points, productHeightsCm)).toThrow();
  });

  it.each([
    { cameraElevationDegrees: -1 }, { cameraElevationDegrees: 86 },
    { cameraElevationDegrees: NaN }, { cameraElevationDegrees: Infinity },
    { cameraElevationDegrees: "45" },
    { cameraRollDegrees: -31 }, { cameraRollDegrees: 31 },
    { cameraRollDegrees: NaN }, { cameraRollDegrees: "0" },
    { shortposeEvidence: "" }, { shortposeEvidence: "x".repeat(161) },
    { confidence: "high" },
  ])("rejects malformed or fabricated pose evidence (%j)", (invalid) => {
    const data = poseAnswer();
    Object.assign(data.points[0]!, invalid);
    expect(() => parseStorefrontScenePreflight(data, points, productHeightsCm)).toThrow(/incomplète|invalide/);
  });

  it.each(["cameraElevationDegrees", "cameraRollDegrees", "shortposeEvidence"] as const)(
    "requires %s and never falls back to the legacy schema", (name) => {
      const data = poseAnswer();
      delete (data.points[0]! as Partial<typeof data.points[0]>)[name];
      expect(() => parseStorefrontScenePreflight(data, points, productHeightsCm)).toThrow();
      expect(() => parseStorefrontScenePreflight(answer(), points, productHeightsCm)).toThrow();
    },
  );

  it.each([[], [40], [40, 75], [40, 75, 20, 10], [0, 75, 20], [-40, 75, 20],
    [NaN, 75, 20], [Infinity, 75, 20], ["40", 75, 20], null])(
    "refuses invalid product heights before any provider call (%j)", async (heights) => {
      const fetcher = vi.fn<typeof globalThis.fetch>();
      vi.stubGlobal("fetch", fetcher);
      await expect(inspectStorefrontScene({
        ...input(), productHeightsCm: heights as number[],
      })).rejects.toMatchObject({ code: "invalid_input", providerCalled: false });
      expect(fetcher).not.toHaveBeenCalled();
      expect(() => parseStorefrontScenePreflight(poseAnswer(), points, heights as number[])).toThrow(/hauteurs/);
    },
  );

  it("uses the same single 25s call and 6000-token allowance for heights, scale and top-camera pose", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetcher = vi.fn<typeof globalThis.fetch>(async () => Response.json(envelope(poseAnswer())));
    vi.stubGlobal("fetch", fetcher);
    const result = await inspectStorefrontScene({ ...input(), productHeightsCm });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(timeout.mock.calls[0]![0]).toBeLessThanOrEqual(25_000);
    expect(result.poses).toHaveLength(3);
    const request = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(request).toMatchObject({
      reasoning: { effort: "low" }, max_output_tokens: 6000,
      text: { format: { name: "storefront_scene_pose_preflight", strict: true } },
    });
    expect(storefrontScenePreflightAllowance().estimatedCostUsd).toBe(0.55);
    const prompt = request.input[0].content[0].text as string;
    expect(prompt).toContain(JSON.stringify(productHeightsCm));
    expect(prompt).toContain("TOP of a standing product");
    expect(prompt).toContain("angle at the product top can differ");
    expect(prompt).toContain("floor and wall planes, table tops");
    expect(prompt).toContain("never derive it from a catalogue camera pose");
    expect(prompt).toContain("low-confidence visual estimate");
    expect(prompt).toContain("Return null independently for either angle");
    expect(request.input[0].content.filter((entry: { type: string }) => entry.type === "input_image")).toHaveLength(1);
    expect(visionObservation(result)?.usage).toEqual(usage);
  });

  it("retains answered usage and refuses a late pose response without a second call", async () => {
    const start = Date.now();
    const fetcher = vi.fn<typeof globalThis.fetch>(async () => {
      vi.spyOn(Date, "now").mockReturnValue(start + 26_000);
      return Response.json(envelope(poseAnswer()));
    });
    vi.stubGlobal("fetch", fetcher);
    const error = await inspectStorefrontScene({
      ...input(), deadlineMs: start + 180_000, productHeightsCm,
    }).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "deadline", providerCalled: true });
    expect(visionObservation(error)?.usage).toEqual(usage);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
const points: StorefrontScenePreflightInput["points"] = [
  { point: { x: 0.4, y: 0.8 }, kind: "standing" },
  { point: { x: 0.7, y: 0.7 }, kind: "standing" },
  { point: { x: 0.5, y: 0.3 }, kind: "wall" },
];
const reference = {
  realHeightCm: 75, basePoint: { x: 0.1, y: 0.8 },
  topPoint: { x: 0.1, y: 0.3 }, sameDepthConfirmed: true as const,
};
const input = (): StorefrontScenePreflightInput => ({
  room: { data: room, mimeType: "image/webp" }, points,
  deadlineMs: Date.now() + 180_000,
});
function answer() {
  return { points: points.map((entry, index) => ({
    index: index + 1, pixelsPerCm: index === 2 ? null : 4,
    supportKind: entry.kind === "wall" ? "wall" : "floor",
    imageClear: true, clarityScore: 0.95, targetVisible: true,
    supportVisible: true, obstacleAtPoint: false,
    obstacleName: null as string | null,
    obstacleBox: null as { xMin: number; yMin: number; xMax: number; yMax: number } | null,
    evidence: "Le support et le point sont libres et visibles.",
  })) };
}
const usage = { input_tokens: 2000, output_tokens: 200,
  input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } };
const envelope = (value: unknown, status = "completed") => ({
  status, model: "gpt-6-astra", service_tier: "default", usage,
  output: [{ type: "message", status: "completed", content: [
    { type: "output_text", text: JSON.stringify(value) },
  ] }],
});
afterEach(() => {
  vi.unstubAllGlobals(); vi.restoreAllMocks();
  config.openaiApiKey = "test-only"; config.aiMockMode = false;
});

describe("single storefront scene preflight", () => {
  it("returns one ordered inspection and only low-confidence scale evidence per target", () => {
    const result = parseStorefrontScenePreflight(answer(), points);
    expect(result.inspections).toHaveLength(3);
    expect(result.spans[0]).toMatchObject({ pixelsPerCm: 4, confidence: "low", scaleSource: "vision_coarse", supportKind: "floor" });
    expect(result.spans[2]).toMatchObject({ pixelsPerCm: null, confidence: "none", scaleSource: "assumed_room_width" });
    expect(result.spans.every((span) => span.confidence !== "high")).toBe(true);
  });
  it.each(["missing", "duplicate", "reordered", "unexpected"])("rejects %s target coverage", (defect) => {
    const data = answer();
    if (defect === "missing") data.points.pop();
    if (defect === "duplicate") data.points[1]!.index = 1;
    if (defect === "reordered") data.points.reverse();
    if (defect === "unexpected") data.points[0]!.index = 4;
    expect(() => parseStorefrontScenePreflight(data, points)).toThrow();
  });
  it.each([0, 0.19, 201, NaN, Infinity])("refuses an invalid scale %s instead of trusting a coerced value", (scale) => {
    const data = answer(); data.points[0]!.pixelsPerCm = scale;
    expect(() => parseStorefrontScenePreflight(data, points)).toThrow(/incomplète|invalide/);
  });
  it("keeps occupancy evidence without removing room structures or inventing an empty spot", () => {
    const data = answer();
    Object.assign(data.points[0]!, { obstacleAtPoint: true, obstacleName: "Panier existant",
      obstacleBox: { xMin: 0.3, yMin: 0.6, xMax: 0.5, yMax: 0.81 } });
    const inspection = parseStorefrontScenePreflight(data, points).inspections[0]!;
    expect(inspection.obstacleAtPoint).toBe(true);
    expect(inspection.obstacleName).toBe("Panier existant");
    data.points[0]!.obstacleBox = { xMin: 0.7, yMin: 0.1, xMax: 0.9, yMax: 0.3 };
    expect(() => parseStorefrontScenePreflight(data, points)).toThrow(/point choisi/);
  });
  it("rejects contradictory obstacle descriptors", () => {
    const missing = answer(); missing.points[0]!.obstacleAtPoint = true;
    expect(() => parseStorefrontScenePreflight(missing, points)).toThrow(/incohérente/);
    const stale = answer(); stale.points[0]!.obstacleName = "Objet";
    expect(() => parseStorefrontScenePreflight(stale, points)).toThrow(/Obstacle/);
  });
  it("preserves unclear targets and refuses unsupported wall/floor combinations", () => {
    const data = answer(); data.points[0]!.imageClear = false; data.points[0]!.clarityScore = 0.4;
    data.points[1]!.supportKind = "other"; data.points[2]!.supportKind = "floor";
    const result = parseStorefrontScenePreflight(data, points);
    expect(result.inspections[0]).toMatchObject({ imageClear: false, clarityScore: 0.4 });
    expect(result.inspections[1]!.supportVisible).toBe(false);
    expect(result.inspections[2]!.supportVisible).toBe(false);
  });
  it("rejects missing fields and fabricated high-confidence scale output", () => {
    const data = answer();
    delete (data.points[0]! as Partial<typeof data.points[0]>).targetVisible;
    expect(() => parseStorefrontScenePreflight(data, points)).toThrow();
    const high = answer(); Object.assign(high.points[0]!, { confidence: "high" });
    expect(() => parseStorefrontScenePreflight(high, points)).toThrow();
  });
  it("admits one full Astra allowance for the shared analysis", () => {
    expect(storefrontScenePreflightAllowance().estimatedCostUsd).toBe(0.55);
  });
  it("analyses all3 targets in one bounded marked-room request and retains usage", async () => {
    const original = Buffer.from(room);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetcher = vi.fn<typeof globalThis.fetch>(async () => Response.json(envelope(answer())));
    vi.stubGlobal("fetch", fetcher);
    const result = await inspectStorefrontScene(input());
    expect(fetcher).toHaveBeenCalledOnce();
    expect(timeout.mock.calls[0]![0]).toBeLessThanOrEqual(25_000);
    expect(timeout.mock.calls[0]![0]).toBeGreaterThan(2_000);
    const request = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(request).toMatchObject({ reasoning: { effort: "medium" }, max_output_tokens: 6000,
      text: { format: { name: "storefront_scene_preflight", strict: true } } });
    expect(request.input[0].content[0].text).toContain("never assume a table");
    expect(request.input[0].content[0].text).toContain("No measured reference");
    const encoded = request.input[0].content[1].image_url.split(",")[1];
    const marked = await sharp(Buffer.from(encoded, "base64")).removeAlpha().raw().toBuffer();
    let redPixels = 0;
    for (let i = 0; i < marked.length; i += 3)
      if (marked[i]! > marked[i + 1]! + 50 && marked[i]! > marked[i + 2]! + 50) redPixels++;
    expect(redPixels).toBeGreaterThan(50);
    expect(Buffer.from(room)).toEqual(original);
    expect(visionObservation(result)?.usage).toEqual(usage);
  });
  it("accepts an optional reference without certifying the returned model scale", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>(async () => Response.json(envelope(answer())));
    vi.stubGlobal("fetch", fetcher);
    const result = await inspectStorefrontScene({ ...input(), reference });
    expect(result.spans[0]!.confidence).toBe("low");
    const request = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(request.input[0].content[0].text).toContain(JSON.stringify(reference));
    expect(request.input[0].content[0].text).toContain("server's normalized scale calculation remains authoritative");
  });
  it("refuses malformed inputs, empty rooms and unreadable photos before any provider call", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>(); vi.stubGlobal("fetch", fetcher);
    await expect(inspectStorefrontScene({ ...input(), points: [] })).rejects.toThrow(/invalides/);
    await expect(inspectStorefrontScene({ ...input(), points: [{ point: { x: 2, y: 0.5 }, kind: "standing" }] })).rejects.toThrow(/invalides/);
    await expect(inspectStorefrontScene({ ...input(), room: { ...input().room, data: new Uint8Array() } })).rejects.toThrow(/invalides/);
    await expect(inspectStorefrontScene({ ...input(), room: { ...input().room, data: new Uint8Array([1, 2, 3]) } })).rejects.toThrow(/ne peut pas être lue/);
    await expect(inspectStorefrontScene({ ...input(), reference: { ...reference, sameDepthConfirmed: false } as unknown as typeof reference })).rejects.toThrow(/invalides/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("refuses insufficient time without spending and refuses a provider answer beyond25s", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>(async () => Response.json(envelope(answer())));
    vi.stubGlobal("fetch", fetcher);
    await expect(inspectStorefrontScene({ ...input(), deadlineMs: Date.now() + 1000 })).rejects.toThrow(/Temps insuffisant/);
    expect(fetcher).not.toHaveBeenCalled();
    const start = Date.now();
    fetcher.mockImplementation(async () => {
      vi.spyOn(Date, "now").mockReturnValue(start + 26_000);
      return Response.json(envelope(answer()));
    });
    let failure: unknown;
    try { await inspectStorefrontScene({ ...input(), deadlineMs: start + 180_000 }); } catch (reason) { failure = reason; }
    expect(failure).toMatchObject({ code: "deadline", providerCalled: true });
    expect(visionObservation(failure)?.usage).toEqual(usage);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("fails unavailable or incomplete responses without retrying or declaring a room usable", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>(async () => Response.json({}, { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(inspectStorefrontScene(input())).rejects.toThrow(/indisponible/);
    expect(fetcher).toHaveBeenCalledOnce(); fetcher.mockClear();
    fetcher.mockImplementation(async () => Response.json(envelope(answer(), "incomplete")));
    await expect(inspectStorefrontScene(input())).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce(); fetcher.mockClear();
    fetcher.mockImplementation(async () => { throw new Error("network unavailable"); });
    await expect(inspectStorefrontScene(input())).rejects.toMatchObject({ code: "unavailable", providerCalled: true });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("permits the explicit v5 analysis after25s while keeping one provider call", async () => {
    const start = Date.now();
    const fetcher = vi.fn<typeof globalThis.fetch>(async () => {
      vi.spyOn(Date, "now").mockReturnValue(start + 34_000);
      return Response.json(envelope(answer()));
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await inspectStorefrontScene({ ...input(), timeoutMs: 35_000, deadlineMs: start + 180_000 });
    expect(result.spans).toHaveLength(points.length);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([
    { remaining: 180_000, elapsed: 35_001 },
    { remaining: 28_000, elapsed: 28_001 },
  ])("v5 still rejects after its cap or tighter global reserve: $remaining", async ({ remaining, elapsed }) => {
    const start = Date.now();
    const fetcher = vi.fn<typeof globalThis.fetch>(async () => {
      vi.spyOn(Date, "now").mockReturnValue(start + elapsed);
      return Response.json(envelope(answer()));
    });
    vi.stubGlobal("fetch", fetcher);
    let failure: unknown;
    try { await inspectStorefrontScene({ ...input(), timeoutMs: 35_000, deadlineMs: start + remaining }); }
    catch (reason) { failure = reason; }
    expect(failure).toMatchObject({ code: "deadline", providerCalled: true });
    expect(visionObservation(failure)?.usage).toEqual(usage);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("rejects unsupported preflight caps before contacting the provider", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetcher);
    await expect(inspectStorefrontScene({ ...input(), timeoutMs: 60_000 as 35_000 })).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("allows one v6 replacement analysis up to45s without retrying", async () => {
    const start = Date.now();
    const fetcher = vi.fn<typeof globalThis.fetch>(async () => {
      vi.spyOn(Date, "now").mockReturnValue(start + 44_000);
      return Response.json(envelope(answer()));
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await inspectStorefrontScene({ ...input(), timeoutMs: 45_000, deadlineMs: start + 180_000 });
    expect(result.spans).toHaveLength(points.length);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([
    { remaining: 180_000, elapsed: 45_001 },
    { remaining: 32_000, elapsed: 32_001 },
  ])("v6 replacement never exceeds45s or the remaining global budget: $remaining", async ({ remaining, elapsed }) => {
    const start = Date.now();
    const fetcher = vi.fn<typeof globalThis.fetch>(async () => {
      vi.spyOn(Date, "now").mockReturnValue(start + elapsed);
      return Response.json(envelope(answer()));
    });
    vi.stubGlobal("fetch", fetcher);
    let failure: unknown;
    try { await inspectStorefrontScene({ ...input(), timeoutMs: 45_000, deadlineMs: start + remaining }); }
    catch (reason) { failure = reason; }
    expect(failure).toMatchObject({ code: "deadline", providerCalled: true });
    expect(visionObservation(failure)?.usage).toEqual(usage);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("does not swallow the worker deadline or lease errors", async () => {
    const failure = new DurableExecutionError("Lease perdue", "lease_lost");
    const fetcher = vi.fn<typeof globalThis.fetch>(async () => { throw failure; });
    vi.stubGlobal("fetch", fetcher);
    await expect(inspectStorefrontScene(input())).rejects.toBe(failure);
  });
  it("fails closed without a real provider configuration", async () => {
    config.openaiApiKey = "";
    const fetcher = vi.fn<typeof globalThis.fetch>(); vi.stubGlobal("fetch", fetcher);
    await expect(inspectStorefrontScene(input())).rejects.toThrow(/configurée/);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
