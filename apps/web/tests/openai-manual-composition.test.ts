import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { ImageEditingRequest, ImageReference } from "@lili/ai-router";

vi.mock("server-only", () => ({}));
vi.mock("../lib/server/config", () => ({ serverConfig: {
  openaiApiKey: "test-only", openaiBaseUrl: "https://invalid.test/v1",
  openaiModel: "gpt-image-2.5-sunburst", openAIImageEnabled: true, aiMockMode: false,
} }));
import { OpenAIImageProvider } from "../lib/server/ai/openai";
import { composeManualProducts, localiseManualComposition, manualEditContracts, manualPhotographicPrompt } from "../lib/server/manual-composition";
import { padCompositionForAspect } from "../lib/server/simple-composite";

async function request(cleanup = false): Promise<ImageEditingRequest> {
  const image = await sharp({ create: { width: 120, height: 80, channels: 3, background: "#345678" } }).png().toBuffer();
  const mask = await sharp({ create: { width: 120, height: 80, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } } }).png().toBuffer();
  const reference = (role: ImageReference["role"], data: Buffer): ImageReference => ({ role, data: new Uint8Array(data), mimeType: "image/png" });
  return { operation: cleanup ? "manual_cleanup" : "manual_composition", scene: image, productCutout: image,
    composition: image, protectionMask: mask, targetMask: reference("target_mask", mask),
    references: [reference("composition", image), ...(cleanup ? [] : [reference("product_front", image), reference("room_original", image)])],
    prompt: cleanup ? "Remove the selected old product only." : "Photographically integrate the already placed product.",
    quality: "high", size: "1536x1024", lighting: { direction: "automatic", temperature: "neutral", hardness: "balanced" },
    placement: { operation: cleanup ? "remove" : "place" }, idempotencyKey: "manual-test-only",
    mode: cleanup ? "replace" : "insert", outputQuality: "final", preserveBackground: true, deadlineMs: Date.now() + 180_000 };
}
function successfulFetch() {
  const mock = vi.fn<typeof fetch>(async () => Response.json({ data: [{ b64_json: "AQID" }] }, { headers: { "x-request-id": "manual-call" } }));
  vi.stubGlobal("fetch", mock);
  return mock;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("one bounded OpenAI manual edit", () => {
  it("sends the placed local montage and its identical mask first while keeping the full room as context", async () => {
    const mock = successfulFetch();
    const scene = await sharp({ create: { width: 600, height: 400, channels: 3, background: "#345678" } }).webp({ lossless: true }).toBuffer();
    const raw = Buffer.alloc(30 * 40 * 4, 255);
    for (let pixel = 0; pixel < 30 * 40; pixel++) {
      raw[pixel * 4] = 220; raw[pixel * 4 + 1] = 30; raw[pixel * 4 + 2] = 40;
      if (pixel < 60) raw[pixel * 4 + 3] = 0;
    }
    const cutout = await sharp(raw, { raw: { width: 30, height: 40, channels: 4 } }).png().toBuffer();
    const composition = await composeManualProducts(scene, 600, 400, [{ cutout, kind: "standing",
      placement: { box: { xMin: 0.6, yMin: 0.5, xMax: 0.7, yMax: 0.7 } } }]);
    const local = await localiseManualComposition(composition);
    const padded = await padCompositionForAspect(local.composition, "1536x1024", { exactRasterAspect: true });
    const montage = await sharp(padded.imageWebp).png().toBuffer();
    const input = await request();
    input.scene = scene; input.composition = montage; input.protectionMask = padded.maskPng;
    input.targetMask!.data = padded.maskPng;
    input.references = [{ data: montage, mimeType: "image/png", role: "composition" },
      { data: cutout, mimeType: "image/png", role: "product_front" }, { data: scene, mimeType: "image/webp", role: "room_original" }];
    input.prompt = manualPhotographicPrompt(1, padded.padded, manualEditContracts(composition, local.window, padded));
    expect(await new OpenAIImageProvider().edit(input)).toMatchObject({ status: "succeeded" });
    const body = mock.mock.calls[0]![1]!.body as FormData;
    const images = body.getAll("image[]") as Blob[];
    const first = Buffer.from(await images[0]!.arrayBuffer());
    expect(first).toEqual(montage);
    expect(Buffer.from(await (body.get("mask") as Blob).arrayBuffer())).toEqual(padded.maskPng);
    expect(await sharp(first).metadata()).toMatchObject({ width: padded.paddedWidth, height: padded.paddedHeight });
    expect(padded.paddedWidth).toBeLessThan(600);
    expect(await sharp(Buffer.from(await images[2]!.arrayBuffer())).metadata()).toMatchObject({ width: 600, height: 400 });
    expect(body.get("prompt")).toContain("fractions 0..1");
    expect(body.get("prompt")).not.toContain("quadPx");
  });
  it.each([false, true])("puts the matching PNG alpha mask on image 1 and uses only the actual references (cleanup=%s)", async cleanup => {
    const mock = successfulFetch();
    const input = await request(cleanup);
    const result = await new OpenAIImageProvider().edit(input);
    expect(result).toMatchObject({ status: "succeeded", attemptCount: 1 });
    expect(mock).toHaveBeenCalledOnce();
    const body = mock.mock.calls[0]![1]!.body as FormData;
    expect(body.getAll("image[]")).toHaveLength(cleanup ? 1 : 3);
    const image = body.getAll("image[]")[0] as Blob;
    const mask = body.get("mask") as Blob;
    expect(image.type).toBe("image/png");
    expect(mask.type).toBe("image/png");
    const imageMeta = await sharp(Buffer.from(await image.arrayBuffer())).metadata();
    const maskMeta = await sharp(Buffer.from(await mask.arrayBuffer())).metadata();
    expect(imageMeta.width).toBe(maskMeta.width);
    expect(imageMeta.height).toBe(maskMeta.height);
    expect(maskMeta.hasAlpha).toBe(true);
    expect(body.get("input_fidelity")).toBeNull();
    expect(body.get("background")).toBe("opaque");
    expect(body.get("model")).toBe("gpt-image-2.5-sunburst");
  });

  it("uses high fidelity only on the supported GPT Image 1.5 family", async () => {
    const mock = successfulFetch();
    await new OpenAIImageProvider("gpt-image-1.5").edit(await request());
    expect((mock.mock.calls[0]![1]!.body as FormData).get("input_fidelity")).toBe("high");
  });

  it.each([false, true])("rejects a mismatched image/mask before any paid call (cleanup=%s)", async cleanup => {
    const mock = successfulFetch();
    const input = await request(cleanup);
    input.targetMask!.data = await sharp({ create: { width: 121, height: 80, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } } }).png().toBuffer();
    const result = await new OpenAIImageProvider().edit(input);
    expect(result).toMatchObject({ status: "failed", estimatedCostUsd: 0, error: { code: "invalid_input", retryable: false } });
    expect(mock).not.toHaveBeenCalled();
  });

  it("never sends a catalogue reference to a cleanup call", async () => {
    const mock = successfulFetch();
    const input = await request(true);
    input.references!.push({ ...input.references![0]!, role: "product_front" });
    expect(await new OpenAIImageProvider().edit(input)).toMatchObject({ error: { code: "invalid_input" }, estimatedCostUsd: 0 });
    expect(mock).not.toHaveBeenCalled();
  });

  it.each([[false, 180_000, 120_000], [true, 180_000, 55_000], [false, 100_000, 55_000], [true, 120_000, 20_000]])(
    "reserves remaining final/review time within the total deadline (cleanup=%s, remaining=%i)", async (cleanup, remaining, allowance) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const timer = vi.spyOn(AbortSignal, "timeout");
      successfulFetch();
      const input = await request(cleanup);
      input.deadlineMs = Date.now() + remaining;
      await new OpenAIImageProvider().edit(input);
      expect(timer).toHaveBeenCalledWith(allowance);
    });

  it.each([false, true])("does not start another image when insufficient time remains (cleanup=%s)", async cleanup => {
    const mock = successfulFetch();
    const input = await request(cleanup);
    input.deadlineMs = Date.now() + (cleanup ? 109_000 : 54_000);
    expect(await new OpenAIImageProvider().edit(input)).toMatchObject({ status: "failed", estimatedCostUsd: 0, error: { code: "render_deadline" } });
    expect(mock).not.toHaveBeenCalled();
  });

  it("records an interrupted response body as an uncertain billable result and never retries", async () => {
    const response = new Response("{}", { headers: { "x-request-id": "manual-started" } });
    vi.spyOn(response, "json").mockRejectedValue(new DOMException("deadline", "AbortError"));
    const mock = vi.fn<typeof fetch>(async () => response);
    vi.stubGlobal("fetch", mock);
    const result = await new OpenAIImageProvider().edit(await request());
    expect(result).toMatchObject({ status: "failed", requestId: "manual-started", error: { code: "timeout", retryable: false } });
    expect(result.estimatedCostUsd).toBeGreaterThan(0);
    expect(mock).toHaveBeenCalledOnce();
  });
});
