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
