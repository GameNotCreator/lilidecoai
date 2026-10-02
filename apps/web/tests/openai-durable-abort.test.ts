import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageEditingRequest } from "@lili/ai-router";
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

const request = (): ImageEditingRequest => ({
  scene: new Uint8Array([1]), productCutout: new Uint8Array([2]),
  composition: new Uint8Array([3]), protectionMask: new Uint8Array([4]),
  prompt: "Preserve placement and identity", quality: "medium", size: "1024x1024",
  lighting: { direction: "left", temperature: "neutral", hardness: "soft" },
  placement: { x: 0.5, y: 0.7 }, idempotencyKey: "abort-test-only",
  mode: "insert", outputQuality: "final", preserveBackground: true,
  deadlineMs: Date.now() + 135_000,
});

describe("OpenAI image edit deadline cancellation", () => {
  it.each([
    [new DOMException("Storefront deadline reached", "AbortError"), "timeout"],
    [new DurableExecutionError("Storefront deadline reached", "deadline"), "network_error"],
  ])("aborts the in-flight HTTP request when the worker stops (%s), without retrying or claiming zero cost", async (reason, errorCode) => {
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
    const input = request();
    const pending = durableContext.run({
      render: { id: "render-test" } as RenderDocument,
      token: "lease-test", signal: controller.signal,
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.estimatedCostUsd).toBe(estimateOpenAICost(input.quality, input.size));
    expect(result.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("retains the 45-second review reserve and a maximum 90-second image window for the bounded caller", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ data: [{ b64_json: "AQID" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect((await new OpenAIImageProvider().edit(request())).status).toBe("succeeded");
    expect(timeout).toHaveBeenCalledTimes(1);
    const milliseconds = timeout.mock.calls[0]![0];
    expect(milliseconds).toBeLessThanOrEqual(90_000);
    expect(milliseconds).toBeGreaterThan(89_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
