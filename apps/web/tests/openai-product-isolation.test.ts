import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageEditingRequest, ImageReference } from "@lili/ai-router";
import type { RenderDocument } from "../lib/server/types";

vi.mock("server-only", () => ({}));
vi.mock("../lib/server/config", () => ({ serverConfig: {
  openaiApiKey: "test-only", openaiBaseUrl: "https://invalid.test/v1",
  openaiModel: "gpt-image-2.5-sunburst", openAIImageEnabled: true, aiMockMode: false,
} }));

import { durableContext, DurableExecutionError } from "../lib/server/durable-context";
import { OpenAIImageProvider, estimateOpenAICost } from "../lib/server/ai/openai";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const reference = (
  role: ImageReference["role"],
  bytes: number[],
  mimeType: ImageReference["mimeType"] = "image/webp",
): ImageReference => ({ role, data: new Uint8Array(bytes), mimeType });

const request = (): ImageEditingRequest => ({
  scene: new Uint8Array([1]), productCutout: new Uint8Array([2]),
  composition: new Uint8Array([3]), protectionMask: new Uint8Array([4]),
  targetMask: reference("target_mask", [5], "image/png"),
  prompt: "Isolate the exact catalogue product", quality: "max", size: "1536x1024",
  lighting: { direction: "left", temperature: "neutral", hardness: "soft" },
  placement: { x: 0.5, y: 0.7 }, idempotencyKey: "isolation-test-only",
  mode: "insert", outputQuality: "final", preserveBackground: true,
  deadlineMs: Date.now() + 135_000,
});

const reportedUsage = {
  input_tokens_details: { text_tokens: 1_000, image_tokens: 2_000 },
  output_tokens: 10_000,
};

function successfulFetch() {
  const fetchMock = vi.fn<typeof globalThis.fetch>(async () => Response.json({
    data: [{ b64_json: "AQID" }], usage: reportedUsage,
  }, { headers: { "x-request-id": "isolation-provider-request" } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function postedBody(fetchMock: ReturnType<typeof successfulFetch>): FormData {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const body = fetchMock.mock.calls[0]![1]!.body;
  expect(body).toBeInstanceOf(FormData);
  return body as FormData;
}

async function postedImages(body: FormData) {
  return Promise.all(body.getAll("image[]").map(async (value) => {
    expect(value).toBeInstanceOf(Blob);
    const image = value as Blob;
    return { bytes: [...new Uint8Array(await image.arrayBuffer())], mimeType: image.type };
  }));
}

describe("OpenAI catalogue product isolation", () => {
  it("uses the first catalogue product as base, preserves every repeated product in order, then sends rooms and guides", async () => {
    const fetchMock = successfulFetch();
    await new OpenAIImageProvider().edit({
      ...request(), productIsolation: true,
      references: [
        reference("spatial_guide", [61]),
        reference("room_original", [41], "image/png"),
        reference("composition", [91]),
        reference("product_detail", [11, 12]),
        reference("target_mask", [93], "image/png"),
        reference("intermediate", [92]),
        { ...reference("product_front", [11, 12]), data: new Uint8Array([0, 11, 12, 0]).subarray(1, 3) },
        reference("product_side", [21, 22], "image/png"),
        reference("room_original", [42], "image/jpeg"),
        reference("product_back", [11, 12], "image/png"),
        reference("spatial_guide", [62], "image/png"),
        reference("product_three_quarter", [31, 32], "image/jpeg"),
        reference("product_detail", [21, 22], "image/png"),
      ],
    });
    expect(await postedImages(postedBody(fetchMock))).toEqual([
      { bytes: [11, 12], mimeType: "image/webp" },
      { bytes: [11, 12], mimeType: "image/webp" },
      { bytes: [21, 22], mimeType: "image/png" },
      { bytes: [11, 12], mimeType: "image/png" },
      { bytes: [31, 32], mimeType: "image/jpeg" },
      { bytes: [21, 22], mimeType: "image/png" },
      { bytes: [41], mimeType: "image/png" },
      { bytes: [42], mimeType: "image/jpeg" },
      { bytes: [61], mimeType: "image/webp" },
      { bytes: [62], mimeType: "image/png" },
    ]);
  });

  it("requests transparent lossless WebP and omits every mask even when a target mask is supplied", async () => {
    const fetchMock = successfulFetch();
    await new OpenAIImageProvider().edit({
      ...request(), productIsolation: true,
      references: [reference("product_front", [11]), reference("target_mask", [93], "image/png")],
    });
    const body = postedBody(fetchMock);
    expect(body.get("background")).toBe("transparent");
    expect(body.get("output_format")).toBe("webp");
    expect(body.get("output_compression")).toBe("100");
    expect(body.get("quality")).toBe("max");
    expect(body.get("model")).toBe("gpt-image-2.5-sunburst");
    expect(body.get("size")).toBe("1536x1024");
    expect(body.has("mask")).toBe(false);
    expect(body.getAll("image[]")).toHaveLength(1);
    expect(await postedImages(body)).toEqual([{ bytes: [11], mimeType: "image/webp" }]);
  });

  it.each([
    undefined,
    [],
    [reference("room_original", [41]), reference("composition", [91]), reference("intermediate", [92])],
  ])("rejects isolation without a catalogue product locally, without spending or using the fallback cutout (%j)", async (references) => {
    const fetchMock = successfulFetch();
    const result = await new OpenAIImageProvider().edit({ ...request(), productIsolation: true, references });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "invalid_input", retryable: false });
    expect(result.images).toEqual([]);
    expect(result.estimatedCostUsd).toBe(0);
  });

  it("retains actual provider usage and request identity for an isolation call", async () => {
    const fetchMock = successfulFetch();
    const result = await new OpenAIImageProvider().edit({
      ...request(), productIsolation: true, references: [reference("product_front", [11])],
    });
    expect(result.status).toBe("succeeded");
    expect(result.requestId).toBe("isolation-provider-request");
    expect(result.estimatedCostUsd).toBeCloseTo(0.321);
    expect(result.usage).toEqual(reportedUsage);
    expect(result.images).toEqual([{ data: new Uint8Array([1, 2, 3]), mimeType: "image/webp" }]);
    expect(result.attemptCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([false, undefined])("preserves legacy composition, first product, guides and remaining products without deduplication (%s)", async (productIsolation) => {
    const fetchMock = successfulFetch();
    await new OpenAIImageProvider().edit({
      ...request(), productIsolation,
      references: [
        reference("spatial_guide", [61]), reference("room_original", [41]),
        reference("product_front", [11]), reference("composition", [91]),
        reference("product_detail", [11]), reference("spatial_guide", [62]),
        reference("product_side", [21]), reference("target_mask", [93], "image/png"),
        reference("intermediate", [92]),
      ],
    });
    const body = postedBody(fetchMock);
    expect((await postedImages(body)).map((image) => image.bytes)).toEqual([[91], [11], [61], [62], [11], [21]]);
    expect(body.get("background")).toBe("opaque");
    expect(body.get("output_format")).toBe("webp");
    expect(body.get("output_compression")).toBe("100");
    expect([...new Uint8Array(await (body.get("mask") as Blob).arrayBuffer())]).toEqual([5]);
  });

  it.each([false, undefined])("preserves legacy room and cutout fallbacks and a reference mask (%s)", async (productIsolation) => {
    const fetchMock = successfulFetch();
    await new OpenAIImageProvider().edit({
      ...request(), productIsolation, targetMask: undefined,
      references: [reference("room_original", [41], "image/jpeg"), reference("spatial_guide", [61]), reference("target_mask", [93], "image/png")],
    });
    const body = postedBody(fetchMock);
    expect(await postedImages(body)).toEqual([
      { bytes: [41], mimeType: "image/jpeg" },
      { bytes: [2], mimeType: "image/webp" },
      { bytes: [61], mimeType: "image/webp" },
    ]);
    expect(body.get("background")).toBe("opaque");
    expect([...new Uint8Array(await (body.get("mask") as Blob).arrayBuffer())]).toEqual([93]);
  });

  it.each([false, undefined])("preserves the legacy raw composition and cutout when no references exist (%s)", async (productIsolation) => {
    const fetchMock = successfulFetch();
    await new OpenAIImageProvider().edit({ ...request(), productIsolation, references: undefined, targetMask: undefined });
    const body = postedBody(fetchMock);
    expect((await postedImages(body)).map((image) => image.bytes)).toEqual([[3], [2]]);
    expect(body.get("background")).toBe("opaque");
    expect(body.has("mask")).toBe(false);
  });

  it("keeps standard generation on the legacy room, product and guide order with an opaque background", async () => {
    const fetchMock = successfulFetch();
    await new OpenAIImageProvider().generate({
      ...request(),
      references: [reference("spatial_guide", [61]), reference("product_front", [11]), reference("room_original", [41]), reference("product_side", [21])],
    });
    const body = postedBody(fetchMock);
    expect((await postedImages(body)).map((image) => image.bytes)).toEqual([[41], [11], [61], [21]]);
    expect(body.get("background")).toBe("opaque");
  });

  it.each([
    [new DOMException("Storefront deadline reached", "AbortError"), "timeout"],
    [new DurableExecutionError("Storefront deadline reached", "deadline"), "network_error"],
  ])("forwards durable abort to isolation and keeps unknown cost without retrying (%s)", async (reason, errorCode) => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let started!: () => void;
    const called = new Promise<void>((resolve) => { started = resolve; });
    const fetchMock = vi.fn<typeof globalThis.fetch>(async (...args) => {
      observedSignal = args[1]?.signal ?? undefined;
      started();
      return new Promise<Response>((_resolve, reject) => {
        observedSignal!.addEventListener("abort", () => reject(observedSignal!.reason), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const input = { ...request(), productIsolation: true, references: [reference("product_front", [11])] };
    const pending = durableContext.run({
      render: { id: "isolation-render-test" } as RenderDocument,
      token: "isolation-lease-test", signal: controller.signal,
    }, () => new OpenAIImageProvider().edit(input));
    await called;
    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(false);
    controller.abort(reason);
    const result = await pending;
    expect(observedSignal?.aborted).toBe(true);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe(errorCode);
    expect(result.images).toEqual([]);
    expect(result.estimatedCostUsd).toBe(estimateOpenAICost(input.quality, input.size));
    expect(result.estimatedCostUsd).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reserves 45 seconds for review and caps the bounded isolation call at 90 seconds", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = successfulFetch();
    const result = await new OpenAIImageProvider().edit({
      ...request(), productIsolation: true, references: [reference("product_front", [11])],
    });
    expect(result.status).toBe("succeeded");
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout.mock.calls[0]![0]).toBe(90_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not spend on isolation when the remaining deadline would consume the review reserve", async () => {
    const fetchMock = successfulFetch();
    const result = await new OpenAIImageProvider().edit({
      ...request(), productIsolation: true, references: [reference("product_front", [11])], deadlineMs: Date.now() + 40_000,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("render_deadline");
    expect(result.estimatedCostUsd).toBe(0);
  });

  it("makes one isolation request on a retryable provider failure and preserves the uncertain cost", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => Response.json({
      error: { code: "provider_unavailable", message: "Provider unavailable" },
    }, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const input = { ...request(), productIsolation: true, references: [reference("product_front", [11])] };
    const result = await new OpenAIImageProvider().edit(input);
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "provider_unavailable", retryable: true });
    expect(result.estimatedCostUsd).toBe(estimateOpenAICost(input.quality, input.size));
    expect(result.attemptCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function cameraFirstRequest(): ImageEditingRequest {
  return {
    ...request(), quality: "medium", productIsolation: true, productIsolationCameraFirst: true,
    references: [reference("product_front", [11]), reference("room_original", [41], "image/jpeg"), reference("spatial_guide", [61], "image/png")],
  };
}

describe("OpenAI internal camera-first product isolation", () => {
  it.each([1, 2, 3])("sends guide, room and %i products in exact catalogue order, preserving repeated bytes", async count => {
    const fetchMock = successfulFetch();
    const products = [reference("product_detail", [11, 12]), reference("product_side", [21, 22], "image/png"), reference("product_front", [11, 12])].slice(0, count);
    const result = await new OpenAIImageProvider().edit({
      ...cameraFirstRequest(),
      references: [reference("composition", [91]), products[0]!, reference("room_original", [41], "image/jpeg"),
        reference("target_mask", [93], "image/png"), ...products.slice(1),
        reference("intermediate", [92]), reference("spatial_guide", [61], "image/png")],
    });
    expect(result.status).toBe("succeeded");
    const body = postedBody(fetchMock);
    expect(await postedImages(body)).toEqual([
      { bytes: [61], mimeType: "image/png" }, { bytes: [41], mimeType: "image/jpeg" },
      ...products.map(product => ({ bytes: [...product.data], mimeType: product.mimeType })),
    ]);
    expect((body.getAll("image[]") as File[]).map(file => file.name)).toEqual([
      "spatial-guide.png", "room-original.jpg", ...products.map((product, index) => `product-${index + 3}.${product.mimeType === "image/png" ? "png" : "webp"}`),
    ]);
    expect(body.get("background")).toBe("transparent");
    expect(body.get("output_format")).toBe("webp");
    expect(body.get("output_compression")).toBe("100");
    expect(body.has("mask")).toBe(false);
  });

  it.each([
    ["missing guide", [reference("product_front", [11]), reference("room_original", [41])]],
    ["missing room", [reference("product_front", [11]), reference("spatial_guide", [61])]],
    ["multiple guides", [reference("product_front", [11]), reference("room_original", [41]), reference("spatial_guide", [61]), reference("spatial_guide", [62])]],
    ["multiple rooms", [reference("product_front", [11]), reference("room_original", [41]), reference("room_original", [42]), reference("spatial_guide", [61])]],
    ["both camera references missing", [reference("product_front", [11]), reference("composition", [91])]],
    ["product missing", [reference("room_original", [41]), reference("spatial_guide", [61]), reference("composition", [91])]],
  ] as const)("rejects %s locally, without a provider call or fallback product", async (_name, references) => {
    const fetchMock = successfulFetch();
    const result = await new OpenAIImageProvider().edit({ ...cameraFirstRequest(), references: [...references] });
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "invalid_input", retryable: false });
    expect(result.estimatedCostUsd).toBe(0);
    expect(result.images).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([false, undefined])("keeps product-first isolation and accepts multiple camera references when camera-first is %s", async productIsolationCameraFirst => {
    const fetchMock = successfulFetch();
    await new OpenAIImageProvider().edit({
      ...cameraFirstRequest(), productIsolationCameraFirst,
      references: [reference("spatial_guide", [61]), reference("room_original", [41]), reference("product_front", [11]),
        reference("product_detail", [11]), reference("room_original", [42]), reference("spatial_guide", [62])],
    });
    const body = postedBody(fetchMock);
    expect((await postedImages(body)).map(image => image.bytes)).toEqual([[11], [11], [41], [42], [61], [62]]);
    expect(body.get("background")).toBe("transparent");
    expect(body.has("mask")).toBe(false);
  });

  it.each([false, undefined])("ignores camera-first and keeps opaque legacy order with multiple rooms and guides when isolation is %s", async productIsolation => {
    const fetchMock = successfulFetch();
    await new OpenAIImageProvider().edit({
      ...cameraFirstRequest(), productIsolation,
      references: [reference("spatial_guide", [61]), reference("room_original", [41]), reference("product_front", [11]),
        reference("composition", [91]), reference("room_original", [42]), reference("product_detail", [11]), reference("spatial_guide", [62])],
    });
    const body = postedBody(fetchMock);
    expect((await postedImages(body)).map(image => image.bytes)).toEqual([[91], [11], [61], [62], [11]]);
    expect(body.get("background")).toBe("opaque");
    expect([...new Uint8Array(await (body.get("mask") as Blob).arrayBuffer())]).toEqual([5]);
  });

  it.each([false, undefined])("ignores camera-first and keeps composition/cutout fallback without camera references when isolation is %s", async productIsolation => {
    const fetchMock = successfulFetch();
    await new OpenAIImageProvider().edit({ ...cameraFirstRequest(), productIsolation, references: undefined, targetMask: undefined });
    const body = postedBody(fetchMock);
    expect((await postedImages(body)).map(image => image.bytes)).toEqual([[3], [2]]);
    expect(body.get("background")).toBe("opaque");
    expect(body.has("mask")).toBe(false);
  });

  it("keeps standard generation on the legacy path when only the camera-first flag is present", async () => {
    const fetchMock = successfulFetch();
    const input = { ...cameraFirstRequest(), productIsolation: undefined, references: undefined };
    await new OpenAIImageProvider().generate(input);
    const body = postedBody(fetchMock);
    expect((await postedImages(body)).map(image => image.bytes)).toEqual([[3], [2]]);
    expect(body.get("background")).toBe("opaque");
  });

  it("preserves medium quality, the 90-second signal and actual usage for camera-first isolation", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = successfulFetch();
    const result = await new OpenAIImageProvider().edit(cameraFirstRequest());
    const body = postedBody(fetchMock);
    expect(body.get("quality")).toBe("medium");
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout.mock.calls[0]![0]).toBe(90_000);
    expect(fetchMock.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal);
    expect(result.estimatedCostUsd).toBeCloseTo(0.321);
    expect(result.usage).toEqual(reportedUsage);
    expect(result.requestId).toBe("isolation-provider-request");
    expect(result.attemptCount).toBe(1);
  });

  it("forwards durable abort through the camera-first call without retrying or claiming zero cost", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let started!: () => void;
    const called = new Promise<void>((resolve) => { started = resolve; });
    const fetchMock = vi.fn<typeof globalThis.fetch>(async (...args) => {
      observedSignal = args[1]?.signal ?? undefined;
      started();
      return new Promise<Response>((_resolve, reject) => {
        observedSignal!.addEventListener("abort", () => reject(observedSignal!.reason), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const input = cameraFirstRequest();
    const pending = durableContext.run({ render: { id: "camera-first-render" } as RenderDocument,
      token: "camera-first-lease", signal: controller.signal }, () => new OpenAIImageProvider().edit(input));
    await called;
    expect(observedSignal?.aborted).toBe(false);
    controller.abort(new DOMException("Storefront deadline reached", "AbortError"));
    const result = await pending;
    expect(observedSignal?.aborted).toBe(true);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("timeout");
    expect(result.estimatedCostUsd).toBe(estimateOpenAICost(input.quality, input.size));
    expect(result.estimatedCostUsd).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a camera-first request after a retryable provider failure", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => Response.json({ error: { code: "provider_unavailable" } }, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const input = cameraFirstRequest();
    const result = await new OpenAIImageProvider().edit(input);
    expect(result.error).toMatchObject({ code: "provider_unavailable", retryable: true });
    expect(result.estimatedCostUsd).toBe(estimateOpenAICost(input.quality, input.size));
    expect(result.attemptCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
