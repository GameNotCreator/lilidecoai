import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageEditingRequest, ImageReference } from "@lili/ai-router";
import type { RenderDocument } from "../lib/server/types";

vi.mock("server-only", () => ({}));
vi.mock("../lib/server/config", () => ({ serverConfig: {
  openaiApiKey: "test-only", openaiBaseUrl: "https://invalid.test/v1",
  openaiModel: "gpt-image-2.5-sunburst-2026-09-08", openAIImageEnabled: true, aiMockMode: false,
} }));
import { OpenAIImageProvider } from "../lib/server/ai/openai";
import { durableContext } from "../lib/server/durable-context";

const model = "gpt-image-2.5-sunburst-2026-09-08";
const reference = (role: ImageReference["role"], bytes: number[]): ImageReference => ({
  role, data: new Uint8Array(bytes), mimeType: "image/png",
});
const baselineRequest = (): ImageEditingRequest => ({
  scene: new Uint8Array([1]), productCutout: new Uint8Array([2]), composition: new Uint8Array([3]),
  protectionMask: new Uint8Array([4]), targetMask: reference("target_mask", [5]),
  references: [reference("composition", [31, 32]), reference("product_front", [11, 12]), reference("spatial_guide", [21, 22])],
  prompt: "Edit the actual local room photograph and its physical support without moving the product's anchor.",
  quality: "high", size: "1024x1024", storefrontRoomRefinement: true,
  lighting: { direction: "automatic", temperature: "neutral", hardness: "balanced" }, placement: { x: 0.5, y: 0.8 },
  mode: "insert", outputQuality: "final", preserveBackground: true, idempotencyKey: "room-refinement-test-only",
  deadlineMs: Date.now() + 180_000,
});
function successfulFetch() {
  const mock = vi.fn<typeof fetch>(async () => Response.json({ data: [{ b64_json: "AQID" }] },
    { headers: { "x-request-id": "room-refinement-response" } }));
  vi.stubGlobal("fetch", mock);
  return mock;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe.each([false, true])("single opaque OpenAI refinement with native contact guide = %s", contactGuide => {
  const request = (): ImageEditingRequest => {
    const input = baselineRequest();
    if (contactGuide) {
      input.storefrontRoomRefinementContactGuide = true;
      input.references!.splice(2, 0, reference("placement_guide", [41, 42]));
    }
    return input;
  };
  it("posts the real composition, original catalogue and full-room guide in order with the matching mask", async () => {
    const mock = successfulFetch();
    const result = await new OpenAIImageProvider(model).edit(request());
    expect(result).toMatchObject({ provider: "openai", model, status: "succeeded", attemptCount: 1,
      requestId: "room-refinement-response", estimatedCostUsd: 1 });
    expect(mock).toHaveBeenCalledOnce();
    expect(mock.mock.calls[0]![0]).toBe("https://invalid.test/v1/images/edits");
    const body = mock.mock.calls[0]![1]!.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    const images = await Promise.all(body.getAll("image[]").map(async image => [...new Uint8Array(await (image as Blob).arrayBuffer())]));
    expect(images).toEqual(contactGuide ? [[31, 32], [11, 12], [41, 42], [21, 22]] : [[31, 32], [11, 12], [21, 22]]);
    expect([...new Uint8Array(await (body.get("mask") as Blob).arrayBuffer())]).toEqual([5]);
    expect(body.get("background")).toBe("opaque");
    expect(body.get("model")).toBe(model);
    expect(body.get("quality")).toBe("high");
    expect(body.get("output_format")).toBe("webp");
    expect(result.productViewUsage).toBeUndefined();
  });

  it.each([[180_000, 85_000], [100_000, 55_000]])("limits the full edit and body to the image allowance while reserving final QA (%i ms)", async (remaining, timeout) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const timer = vi.spyOn(AbortSignal, "timeout");
    successfulFetch();
    await new OpenAIImageProvider(model).edit({ ...request(), deadlineMs: Date.now() + remaining });
    expect(timer).toHaveBeenCalledWith(timeout);
  });

  it("refuses too little remaining time before starting another paid image", async () => {
    const mock = successfulFetch();
    const result = await new OpenAIImageProvider(model).edit({ ...request(), deadlineMs: Date.now() + 54_000 });
    expect(mock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "failed", estimatedCostUsd: 0, error: { code: "render_deadline", retryable: false } });
  });

  it.each(["composition", "product_front", "spatial_guide", "target_mask"] as const)("rejects missing %s evidence locally without substituting a cutout", async role => {
    const mock = successfulFetch();
    const input = request();
    input.references = input.references!.filter(reference => reference.role !== role);
    if (role === "target_mask") input.targetMask = undefined;
    const result = await new OpenAIImageProvider(model).edit(input);
    expect(mock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "failed", estimatedCostUsd: 0, error: { code: "invalid_input", retryable: false } });
  });

  it.each(["productIsolation", "generateProductView"] as const)("rejects conflicting %s mode before selecting any provider endpoint", async key => {
    const mock = successfulFetch();
    const result = await new OpenAIImageProvider(model).edit({ ...request(), [key]: true });
    expect(mock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "failed", estimatedCostUsd: 0, error: { code: "invalid_input", retryable: false } });
  });

  it.each(["composition", "target_mask"] as const)("rejects a non-PNG %s so mask and base cannot silently use incompatible encodings", async role => {
    const mock = successfulFetch();
    const input = request();
    if (role === "target_mask") input.targetMask = { ...input.targetMask!, mimeType: "image/webp" };
    else input.references = input.references!.map(reference => reference.role === role ? { ...reference, mimeType: "image/webp" } : reference);
    const result = await new OpenAIImageProvider(model).edit(input);
    expect(mock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "failed", estimatedCostUsd: 0, error: { code: "invalid_input" } });
  });

  if (contactGuide) it.each(["missing", "empty", "wrong-format", "duplicate", "disabled-room-refinement"])(
    "refuses invalid native placement evidence (%s) before a paid call", async defect => {
      const mock = successfulFetch();
      const input = request();
      const guide = input.references!.find(item => item.role === "placement_guide")!;
      if (defect === "missing") input.references = input.references!.filter(item => item !== guide);
      if (defect === "empty") guide.data = new Uint8Array();
      if (defect === "wrong-format") guide.mimeType = "image/webp";
      if (defect === "duplicate") input.references!.push({ ...guide });
      if (defect === "disabled-room-refinement") input.storefrontRoomRefinement = false;
      const result = await new OpenAIImageProvider(model).edit(input);
      expect(mock).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: "failed", estimatedCostUsd: 0, error: { code: "invalid_input", retryable: false } });
    },
  );

  it.each([
    { data: [] }, { data: [{ b64_json: "" }] }, { data: [{ b64_json: "invalid!base64" }] },
    { data: [{ b64_json: "AQID" }, { b64_json: "AQID" }] },
  ])("rejects missing or ambiguous successful image responses without another call (%j)", async ({ data }) => {
    const mock = vi.fn<typeof fetch>(async () => Response.json({ data }));
    vi.stubGlobal("fetch", mock);
    const result = await new OpenAIImageProvider(model).edit(request());
    expect(result).toMatchObject({ status: "failed", estimatedCostUsd: 1, images: [], error: { retryable: false } });
    expect(mock).toHaveBeenCalledOnce();
  });

  it.each(["network", "timeout"])("does not retry or switch API after an uncertain %s outcome", async kind => {
    const mock = vi.fn<typeof fetch>(async () => { throw kind === "timeout" ? new DOMException("late", "TimeoutError") : new Error("connection lost"); });
    vi.stubGlobal("fetch", mock);
    const result = await new OpenAIImageProvider(model).edit(request());
    expect(mock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "failed", estimatedCostUsd: 1, images: [], attemptCount: 1 });
  });

  it.each([400, 429, 502])("never issues a second image request after HTTP %i", async status => {
    const mock = vi.fn<typeof fetch>(async () => Response.json({ error: { code: "test_failure" } }, { status }));
    vi.stubGlobal("fetch", mock);
    const result = await new OpenAIImageProvider(model).edit(request());
    expect(result.status).toBe("failed");
    expect(result.estimatedCostUsd).toBe(status === 502 ? 1 : 0);
    expect(mock).toHaveBeenCalledOnce();
  });

  it("retains the request identity and uncertain image cost when the response body is interrupted", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const bodyStarted = new Promise<void>(resolve => { started = resolve; });
    const mock = vi.fn<typeof fetch>(async (_url, init) => ({
      ok: true, status: 200, headers: new Headers({ "x-request-id": "room-body-interrupted" }),
      json: () => new Promise((_resolve, reject) => {
        started();
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      }),
    }) as Response);
    vi.stubGlobal("fetch", mock);
    const pending = durableContext.run({ render: { id: "render-test" } as RenderDocument, token: "lease-test", signal: controller.signal },
      () => new OpenAIImageProvider(model).edit(request()));
    await bodyStarted;
    controller.abort(new DOMException("worker stopped", "AbortError"));
    const result = await pending;
    expect(result).toMatchObject({ status: "failed", estimatedCostUsd: 1, requestId: "room-body-interrupted", error: { code: "timeout" } });
    expect(result.images).toEqual([]);
    expect(mock).toHaveBeenCalledOnce();
  });

  it("rejects a late successful body instead of letting an aborted job publish it", async () => {
    const controller = new AbortController();
    const mock = vi.fn<typeof fetch>(async () => ({
      ok: true, status: 200, headers: new Headers({ "x-request-id": "room-late-body" }),
      json: async () => { controller.abort(new DOMException("late", "AbortError")); return { data: [{ b64_json: "AQID" }] }; },
    }) as Response);
    vi.stubGlobal("fetch", mock);
    const result = await durableContext.run({ render: { id: "render-test" } as RenderDocument, token: "lease-test", signal: controller.signal },
      () => new OpenAIImageProvider(model).edit(request()));
    expect(result).toMatchObject({ status: "failed", estimatedCostUsd: 1, requestId: "room-late-body", images: [] });
    expect(mock).toHaveBeenCalledOnce();
  });
});
