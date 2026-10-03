import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageEditingRequest, ImageReference } from "@lili/ai-router";
import type { RenderDocument } from "../lib/server/types";

vi.mock("server-only", () => ({}));
vi.mock("../lib/server/config", () => ({ serverConfig: {
  openaiApiKey: "test-only", openaiBaseUrl: "https://api.openai.com/v1",
  openaiModel: "gpt-image-2.5-sunburst-2026-09-08", openAIImageEnabled: true, aiMockMode: false,
} }));
import { OpenAIImageProvider, estimateOpenAIRoomRefinementCost, OPENAI_ROOM_REFINEMENT_MAINLINE_MODEL,
  OPENAI_ROOM_REFINEMENT_MAX_OUTPUT_TOKENS } from "../lib/server/ai/openai";
import { durableContext } from "../lib/server/durable-context";

const model = "gpt-image-2.5-sunburst-2026-09-08";
const reference = (role: ImageReference["role"], bytes: number[]): ImageReference => ({ role, data: new Uint8Array(bytes), mimeType: "image/png" });
const request = (): ImageEditingRequest => ({
  scene: new Uint8Array([1]), productCutout: new Uint8Array([2]), composition: new Uint8Array([31, 32]),
  protectionMask: new Uint8Array([4]), targetMask: reference("target_mask", [51, 52]),
  references: [reference("composition", [31, 32]), reference("product_front", [11, 12]),
    reference("composition_clean", [41, 42]), reference("spatial_guide", [21, 22])],
  prompt: "Edit image1, remove its markers, preserve the exact visible base and width, and show the correct downward room camera.",
  quality: "high", size: "1536x1024", storefrontRoomRefinement: true, storefrontRoomRefinementContactGuide: true,
  storefrontRoomRefinementGuideFirst: true, storefrontRoomRefinementResponses: true,
  lighting: { direction: "automatic", temperature: "neutral", hardness: "balanced" }, placement: { x: 0.5, y: 0.8 },
  mode: "insert", outputQuality: "final", preserveBackground: true, idempotencyKey: "responses-room-edit-only",
  deadlineMs: Date.now() + 180_000,
});
const usage = { input_tokens: 1000, input_tokens_details: { cached_tokens: 200, cache_write_tokens: 100 },
  output_tokens: 100, output_tokens_details: { reasoning_tokens: 20 }, total_tokens: 1100 };
const imageCall = { type: "image_generation_call", id: "ig_room", status: "completed", action: "edit",
  result: "AQID", output_format: "webp", background: "opaque" };
const response = (override: Record<string, unknown> = {}) => ({ id: "response-room", status: "completed", model: "gpt-6-astra",
  service_tier: "default", output: [imageCall], usage, ...override });
function mockResponse(override: Record<string, unknown> = {}) {
  const mock = vi.fn<typeof fetch>(async () => Response.json(response(override), { headers: { "x-request-id": "room-responses-request" } }));
  vi.stubGlobal("fetch", mock);
  return mock;
}
const bytes = (url: string) => [...Buffer.from(url.split(",")[1]!, "base64")];
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("one masked Responses edit of the first native room image", () => {
  it("forces exactly one opaque edit with the PNG mask on image1 and four references in their physical order", async () => {
    const mock = mockResponse();
    const result = await new OpenAIImageProvider(model).edit(request());
    expect(mock).toHaveBeenCalledOnce();
    expect(mock.mock.calls[0]![0]).toBe("https://api.openai.com/v1/responses");
    const init = mock.mock.calls[0]![1]!;
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "Idempotency-Key": "responses-room-edit-only" });
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: "gpt-6-astra", reasoning: { effort: "low" }, service_tier: "default", store: false,
      max_output_tokens: 2048, max_tool_calls: 1, tool_choice: { type: "image_generation" },
      tools: [{ type: "image_generation", model, action: "edit", background: "opaque", quality: "high", size: "1536x1024" }] });
    expect(body.tools).toHaveLength(1);
    expect(body).not.toHaveProperty("previous_response_id");
    expect(body.tools[0].input_image_mask.image_url).toMatch(/^data:image\/png;base64,/);
    expect(bytes(body.tools[0].input_image_mask.image_url)).toEqual([51, 52]);
    const images = body.input.flatMap((item: { content: Array<{ type: string; image_url?: string }> }) => item.content)
      .filter((item: { type: string }) => item.type === "input_image");
    expect(images.map((item: { image_url: string }) => bytes(item.image_url))).toEqual([[31, 32], [11, 12], [41, 42], [21, 22]]);
    expect(result).toMatchObject({ status: "succeeded", provider: "openai", model, attemptCount: 1, requestId: "room-responses-request" });
    expect(result.images[0]!.data).toEqual(new Uint8Array([1, 2, 3]));
    expect(OPENAI_ROOM_REFINEMENT_MAINLINE_MODEL).toBe("gpt-6-astra");
    expect(OPENAI_ROOM_REFINEMENT_MAX_OUTPUT_TOKENS).toBe(2048);
  });

  it("adds the actual Astra tokens to the Sunburst allowance without double counting reasoning", async () => {
    mockResponse();
    const result = await new OpenAIImageProvider(model).edit(request());
    expect(result.estimatedCostUsd).toBeCloseTo(1 + (700 * 10 + 200 + 100 * 12.5 + 100 * 50) / 1_000_000, 10);
    expect(result.roomRefinementUsage).toMatchObject({ mainline: { model: "gpt-6-astra", modelSource: "response", usage },
      imageGeneration: { model, action: "edit", callId: "ig_room", cost: { method: "allowance", estimatedCostUsd: 1 } } });
    expect(result.productViewUsage).toBeUndefined();
    expect(estimateOpenAIRoomRefinementCost()).toBeCloseTo(1.3524);
  });

  it("keeps the mainline allowance when provider usage is missing", async () => {
    mockResponse({ usage: undefined, model: undefined });
    const result = await new OpenAIImageProvider(model).edit(request());
    expect(result.estimatedCostUsd).toBeCloseTo(1.3524);
    expect(result.roomRefinementUsage?.mainline.modelSource).toBe("requested");
  });

  it("journals only numeric usage, never image data, prompts or arbitrary explanations", async () => {
    mockResponse({ usage: { ...usage, image: "private image", prompt: "private prompt",
      input_tokens_details: { ...usage.input_tokens_details, evidence: "private evidence" } } });
    const result = await new OpenAIImageProvider(model).edit(request());
    expect(result.roomRefinementUsage?.mainline.usage).toEqual(usage);
    expect(JSON.stringify(result.roomRefinementUsage)).not.toContain("private");
    expect(result.usage).toBeUndefined();
  });

  it.each([[180_000, 85_000], [100_000, 55_000], [60_000, 15_000]])("caps POST and body while retaining45s for completion (%ims)", async (remaining, timeout) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const timer = vi.spyOn(AbortSignal, "timeout");
    mockResponse();
    await new OpenAIImageProvider(model).edit({ ...request(), deadlineMs: Date.now() + remaining });
    expect(timer).toHaveBeenCalledOnce();
    expect(timer).toHaveBeenCalledWith(timeout);
  });

  it("refuses before a paid call when less than10s remain after the45s reserve", async () => {
    const mock = mockResponse();
    const result = await new OpenAIImageProvider(model).edit({ ...request(), deadlineMs: Date.now() + 54_000 });
    expect(mock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "failed", estimatedCostUsd: 0, error: { code: "render_deadline", retryable: false } });
  });

  it.each(["composition", "product_front", "composition_clean", "spatial_guide", "target_mask"] as const)("requires%s locally before Responses", async role => {
    const mock = mockResponse();
    const input = request();
    input.references = input.references!.filter(item => item.role !== role);
    if (role === "target_mask") input.targetMask = undefined;
    const result = await new OpenAIImageProvider(model).edit(input);
    expect(mock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "failed", estimatedCostUsd: 0, error: { code: "invalid_input", retryable: false } });
  });

  it.each(["composition", "composition_clean", "target_mask"] as const)("requires PNG encoding for%s", async role => {
    const mock = mockResponse();
    const input = request();
    if (role === "target_mask") input.targetMask!.mimeType = "image/webp";
    else input.references!.find(item => item.role === role)!.mimeType = "image/webp";
    expect((await new OpenAIImageProvider(model).edit(input)).error?.code).toBe("invalid_input");
    expect(mock).not.toHaveBeenCalled();
  });

  it.each(["storefrontRoomRefinement", "storefrontRoomRefinementContactGuide", "storefrontRoomRefinementGuideFirst"] as const)("refuses the missing%s strategy flag without silently falling back", async flag => {
    const mock = mockResponse();
    expect((await new OpenAIImageProvider(model).edit({ ...request(), [flag]: false })).error?.code).toBe("invalid_input");
    expect(mock).not.toHaveBeenCalled();
  });

  it.each(["productIsolation", "generateProductView"] as const)("refuses conflicting%s mode without entering the alpha path", async flag => {
    const mock = mockResponse();
    expect((await new OpenAIImageProvider(model).edit({ ...request(), [flag]: true })).error?.code).toBe("invalid_input");
    expect(mock).not.toHaveBeenCalled();
  });

  it.each([[400, 0], [429, 0], [502, 1.3524]])("keeps appropriate cost and makes only one POST after HTTP%i", async (status, cost) => {
    const mock = vi.fn<typeof fetch>(async () => Response.json({ error: { code: status === 400 ? "moderation_blocked" : "failed" } }, { status }));
    vi.stubGlobal("fetch", mock);
    const result = await new OpenAIImageProvider(model).edit(request());
    expect(mock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "failed", images: [], error: { retryable: false } });
    expect(result.estimatedCostUsd).toBeCloseTo(cost);
    expect(result.safety.blocked).toBe(status === 400);
  });

  it("retains reported analysis cost after a refused image without adding an image allowance", async () => {
    const mock = vi.fn<typeof fetch>(async () => Response.json({ model: "gpt-6-astra", service_tier: "default", usage,
      error: { code: "rate_limit_exceeded" } }, { status: 429 }));
    vi.stubGlobal("fetch", mock);
    const result = await new OpenAIImageProvider(model).edit(request());
    expect(mock).toHaveBeenCalledOnce();
    expect(result.estimatedCostUsd).toBeCloseTo(0.01345, 10);
    expect(result.roomRefinementUsage?.imageGeneration.cost.estimatedCostUsd).toBe(0);
  });

  it.each(["network", "timeout"])("never retries or changes endpoints after uncertain%s", async kind => {
    const mock = vi.fn<typeof fetch>(async () => { throw kind === "timeout" ? new DOMException("late", "TimeoutError") : new Error("connection lost"); });
    vi.stubGlobal("fetch", mock);
    const result = await new OpenAIImageProvider(model).edit(request());
    expect(mock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "failed", images: [], error: { retryable: false } });
    expect(result.estimatedCostUsd).toBeCloseTo(1.3524);
    expect(result.roomRefinementUsage?.imageGeneration.action).toBe("edit");
  });

  it.each([
    { status: "incomplete" }, { output: [] }, { output: [{ ...imageCall, status: "in_progress" }] },
    { output: [{ ...imageCall, action: "generate" }] }, { output: [{ ...imageCall, output_format: "png" }] },
    { output: [{ ...imageCall, background: "transparent" }] }, { output: [{ ...imageCall, result: "not!base64" }] },
    { output: [imageCall, { ...imageCall, id: "ig_second" }] },
  ])("rejects incomplete, generated or multiple tool results without another call (%j)", async payload => {
    const mock = mockResponse(payload);
    const result = await new OpenAIImageProvider(model).edit(request());
    expect(mock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "failed", images: [], error: { code: "empty_image_response", retryable: false } });
    expect(result.estimatedCostUsd).toBeGreaterThan(1);
  });

  it("accepts optional nullable fields without changing the forced edit contract", async () => {
    mockResponse({ output: [{ ...imageCall, action: null, output_format: null, background: null }] });
    expect((await new OpenAIImageProvider(model).edit(request())).status).toBe("succeeded");
  });

  it("keeps the same abort signal while reading the response body and preserves request identity", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const bodyStarted = new Promise<void>(resolve => { started = resolve; });
    const mock = vi.fn<typeof fetch>(async (_url, init) => ({ ok: true, status: 200,
      headers: new Headers({ "x-request-id": "edit-body-timeout" }),
      json: () => new Promise((_resolve, reject) => { started(); init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }); }),
    }) as Response);
    vi.stubGlobal("fetch", mock);
    const pending = durableContext.run({ render: { id: "render-test" } as RenderDocument, token: "lease-test", signal: controller.signal },
      () => new OpenAIImageProvider(model).edit(request()));
    await bodyStarted;
    controller.abort(new DOMException("stopped", "AbortError"));
    const result = await pending;
    expect(mock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "failed", requestId: "edit-body-timeout", images: [], error: { code: "timeout" } });
    expect(result.estimatedCostUsd).toBeCloseTo(1.3524);
  });

  it("rejects a successful body completed after cancellation", async () => {
    const controller = new AbortController();
    const mock = vi.fn<typeof fetch>(async () => ({ ok: true, status: 200,
      headers: new Headers({ "x-request-id": "edit-body-late" }),
      json: async () => { controller.abort(new DOMException("late", "AbortError")); return response(); },
    }) as Response);
    vi.stubGlobal("fetch", mock);
    const result = await durableContext.run({ render: { id: "render-test" } as RenderDocument, token: "lease-test", signal: controller.signal },
      () => new OpenAIImageProvider(model).edit(request()));
    expect(mock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "failed", requestId: "edit-body-late", images: [] });
  });
});
