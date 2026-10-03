import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageEditingRequest, ImageReference } from "@lili/ai-router";
import type { RenderDocument } from "../lib/server/types";

vi.mock("server-only", () => ({}));
vi.mock("../lib/server/config", () => ({ serverConfig: {
  openaiApiKey: "test-only", openaiBaseUrl: "https://api.openai.com/v1",
  openaiModel: "gpt-image-2.5-sunburst-2026-09-08", openAIImageEnabled: true, aiMockMode: false,
} }));
import { OpenAIImageProvider, estimateOpenAIProductViewCost, OPENAI_PRODUCT_VIEW_MAINLINE_MODEL,
  OPENAI_PRODUCT_VIEW_MAX_OUTPUT_TOKENS } from "../lib/server/ai/openai";
import { durableContext } from "../lib/server/durable-context";

const imageModel = "gpt-image-2.5-sunburst-2026-09-08";
const reference = (role: ImageReference["role"], bytes: number[]): ImageReference => ({
  role, data: new Uint8Array(bytes), mimeType: "image/png",
});
const request = (): ImageEditingRequest => ({
  scene: new Uint8Array([1]), productCutout: new Uint8Array([2]), composition: new Uint8Array([3]),
  protectionMask: new Uint8Array([4]), targetMask: reference("target_mask", [5]),
  prompt: "Generate this physical product from 49 degrees above the horizontal, allowing natural self-occlusion.",
  quality: "high", size: "1024x1024", productIsolation: true, productIsolationCameraFirst: true, generateProductView: true,
  references: [reference("product_front", [31, 32]), reference("spatial_guide", [11, 12]), reference("room_original", [21, 22])],
  lighting: { direction: "automatic", temperature: "neutral", hardness: "balanced" }, placement: { x: 0.5, y: 0.8 },
  mode: "insert", outputQuality: "final", preserveBackground: true, idempotencyKey: "pose-responses-test-only",
  deadlineMs: Date.now() + 130_000,
});
const reportedUsage = { input_tokens: 1000, input_tokens_details: { cached_tokens: 200, cache_write_tokens: 100 },
  output_tokens: 100, output_tokens_details: { reasoning_tokens: 20 }, total_tokens: 1100 };
const imageCall = { type: "image_generation_call", id: "ig_test", status: "completed", action: "generate",
  result: "AQID", output_format: "webp", revised_prompt: "A newly photographed three-dimensional view." };
const response = (override: Record<string, unknown> = {}) => ({ id: "response-test", status: "completed", model: "gpt-6-astra",
  service_tier: "default", output: [imageCall], usage: reportedUsage, ...override });
function mockResponse(override: Record<string, unknown> = {}) {
  const mock = vi.fn<typeof fetch>(async () => Response.json(response(override), { headers: { "x-request-id": "provider-response-test" } }));
  vi.stubGlobal("fetch", mock);
  return mock;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("single Responses call for a new catalogue product viewpoint", () => {
  it("uses one forced generation tool with the frozen image model and ordered camera/room/identity inputs", async () => {
    const mock = mockResponse();
    const input = request();
    const result = await new OpenAIImageProvider(imageModel).edit(input);
    expect(mock).toHaveBeenCalledOnce();
    expect(mock.mock.calls[0]![0]).toBe("https://api.openai.com/v1/responses");
    const init = mock.mock.calls[0]![1]!;
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: "gpt-6-astra", reasoning: { effort: "low" }, service_tier: "default", store: false,
      max_output_tokens: 2048, max_tool_calls: 1, tool_choice: { type: "image_generation" },
      tools: [{ type: "image_generation", model: imageModel, action: "generate", background: "transparent", quality: "high", size: "1024x1024" }] });
    expect(body.tools).toHaveLength(1);
    expect(body).not.toHaveProperty("previous_response_id");
    const images = body.input.flatMap((message: { content: Array<{ type: string; image_url?: string }> }) => message.content)
      .filter((item: { type: string }) => item.type === "input_image");
    expect(images.map((image: { image_url: string }) => [...Buffer.from(image.image_url.split(",")[1]!, "base64")]))
      .toEqual([[11, 12], [21, 22], [31, 32]]);
    expect(result).toMatchObject({ provider: "openai", model: imageModel, status: "succeeded", attemptCount: 1 });
    expect(result.images[0]!.data).toEqual(new Uint8Array([1, 2, 3]));
    expect(OPENAI_PRODUCT_VIEW_MAINLINE_MODEL).toBe("gpt-6-astra");
    expect(OPENAI_PRODUCT_VIEW_MAX_OUTPUT_TOKENS).toBe(2048);
  });

  it("accounts separately for reported mainline tokens and the image allowance, without pricing reasoning twice", async () => {
    mockResponse();
    const result = await new OpenAIImageProvider(imageModel).edit(request());
    expect(result.estimatedCostUsd).toBeCloseTo(1 + (700 * 10 + 200 + 100 * 12.5 + 100 * 50) / 1_000_000);
    expect(result.productViewUsage).toMatchObject({ mainline: { model: "gpt-6-astra", usage: reportedUsage },
      imageGeneration: { model: imageModel, callId: "ig_test", action: "generate", cost: { method: "allowance", estimatedCostUsd: 1 } } });
    expect(estimateOpenAIProductViewCost()).toBeCloseTo(1.3524);
  });

  it("reserves the mainline allowance when usage is absent instead of claiming a free analysis", async () => {
    mockResponse({ usage: undefined });
    const result = await new OpenAIImageProvider(imageModel).edit(request());
    expect(result.estimatedCostUsd).toBeCloseTo(1.3524);
  });

  it("accepts nullable optional tool fields while retaining the explicit requested generation contract", async () => {
    mockResponse({ output: [{ ...imageCall, action: null, output_format: null, background: null }] });
    expect((await new OpenAIImageProvider(imageModel).edit(request())).status).toBe("succeeded");
  });

  it("journals numeric token evidence without copying prompts, image data or arbitrary usage text", async () => {
    mockResponse({ usage: { ...reportedUsage, prompt: "private text", image: "private image",
      input_tokens_details: { ...reportedUsage.input_tokens_details, explanation: "private reference" } } });
    const result = await new OpenAIImageProvider(imageModel).edit(request());
    expect(result.productViewUsage?.mainline.usage).toEqual(reportedUsage);
    expect(JSON.stringify(result.productViewUsage)).not.toContain("private");
    expect(result.usage).toBeUndefined();
  });

  it.each([[400, 0], [429, 0], [502, 1.3524]])("does not retry or fall back after HTTP %i and retains the appropriate cost estimate", async (status, cost) => {
    const mock = vi.fn<typeof fetch>(async () => Response.json({ error: { code: status === 400 ? "moderation_blocked" : "failed" } }, { status }));
    vi.stubGlobal("fetch", mock);
    const result = await new OpenAIImageProvider(imageModel).edit(request());
    expect(result.status).toBe("failed");
    expect(result.estimatedCostUsd).toBeCloseTo(cost);
    expect(result.safety.blocked).toBe(status === 400);
    expect(mock).toHaveBeenCalledOnce();
  });

  it("caps the whole request to 85 seconds while retaining the caller's review reserve", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const timer = vi.spyOn(AbortSignal, "timeout");
    mockResponse();
    await new OpenAIImageProvider(imageModel).edit({ ...request(), deadlineMs: Date.now() + 300_000 });
    expect(timer).toHaveBeenCalledOnce();
    expect(timer).toHaveBeenCalledWith(85_000);
  });

  it("refuses locally when fewer than ten image seconds remain after the review reserve", async () => {
    const mock = mockResponse();
    const result = await new OpenAIImageProvider(imageModel).edit({ ...request(), deadlineMs: Date.now() + 54_000 });
    expect(mock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "failed", estimatedCostUsd: 0, error: { code: "render_deadline" } });
  });

  it.each(["spatial_guide", "room_original", "product_front"] as const)("refuses a missing %s before any paid request", async role => {
    const mock = mockResponse();
    const input = request();
    input.references = input.references!.filter(reference => reference.role !== role);
    const result = await new OpenAIImageProvider(imageModel).edit(input);
    expect(mock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "failed", estimatedCostUsd: 0, error: { code: "invalid_input", retryable: false } });
  });

  it.each(["network", "timeout"])("never falls back to edits or retries after a %s outcome", async type => {
    const mock = vi.fn<typeof fetch>(async () => { throw type === "timeout" ? new DOMException("late", "TimeoutError") : new Error("connection lost"); });
    vi.stubGlobal("fetch", mock);
    const result = await new OpenAIImageProvider(imageModel).edit(request());
    expect(mock).toHaveBeenCalledOnce();
    expect(result.status).toBe("failed");
    expect(result.images).toEqual([]);
    expect(result.estimatedCostUsd).toBeCloseTo(1.3524);
  });

  it.each([
    { status: "incomplete", output: [imageCall] },
    { output: [] },
    { output: [{ type: "message", content: [{ type: "refusal", refusal: "Cannot generate" }] }] },
    { output: [{ ...imageCall, status: "in_progress" }] },
    { output: [{ ...imageCall, action: "edit" }] },
    { output: [{ ...imageCall, output_format: "png" }] },
    { output: [{ ...imageCall, result: "not!base64" }] },
    { output: [imageCall, { ...imageCall, id: "unexpected-second-call" }] },
  ])("rejects incomplete or ambiguous image outputs without another POST (%j)", async payload => {
    const mock = mockResponse(payload);
    const result = await new OpenAIImageProvider(imageModel).edit(request());
    expect(mock).toHaveBeenCalledOnce();
    expect(result.status).toBe("failed");
    expect(result.images).toEqual([]);
    expect(result.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("keeps one abortable deadline through response-body reading and preserves uncertain cost", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const bodyStarted = new Promise<void>(resolve => { started = resolve; });
    const mock = vi.fn<typeof fetch>(async (_url, init) => ({
      ok: true, status: 200, headers: new Headers({ "x-request-id": "body-timeout" }),
      json: () => new Promise((_resolve, reject) => {
        started();
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      }),
    }) as Response);
    vi.stubGlobal("fetch", mock);
    const pending = durableContext.run({ render: { id: "render-test" } as RenderDocument, token: "lease-test", signal: controller.signal },
      () => new OpenAIImageProvider(imageModel).edit(request()));
    await bodyStarted;
    controller.abort(new DOMException("stop", "AbortError"));
    const result = await pending;
    expect(result.status).toBe("failed");
    expect(result.estimatedCostUsd).toBeCloseTo(1.3524);
    expect(result.requestId).toBe("body-timeout");
    expect(mock).toHaveBeenCalledOnce();
  });

  it("does not silently switch API when the generated-view flag is disabled", async () => {
    const mock = vi.fn<typeof fetch>(async () => Response.json({ data: [{ b64_json: "AQID" }] }));
    vi.stubGlobal("fetch", mock);
    await new OpenAIImageProvider(imageModel).edit({ ...request(), generateProductView: false });
    expect(mock).toHaveBeenCalledOnce();
    expect(mock.mock.calls[0]![0]).toBe("https://api.openai.com/v1/images/edits");
    expect(mock.mock.calls[0]![1]!.body).toBeInstanceOf(FormData);
  });
});
