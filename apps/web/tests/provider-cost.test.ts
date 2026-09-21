import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: {
    openaiApiKey: "test-only",
    openaiModel: "gpt-image-2",
    openaiBaseUrl: "https://invalid.test/v1",
    openAIImageEnabled: true,
    aiMockMode: false,
    openaiServiceTier: "fast",
  },
}));
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/config", () => ({ serverConfig: mocks.config }));

import { OpenAIImageProvider } from "../lib/server/ai/openai";

/**
 * A13 of the audit: a provider failure used to be reported as costing nothing.
 * A request that reached the model and then timed out was very likely run and
 * billed, so recording it as free both understated the cost per accepted render
 * and let a job that kept timing out run for ever under its budget ceiling.
 *
 * Zero is now reserved for calls the provider refused before running.
 */
const request = {
  scene: new Uint8Array([1, 2, 3]),
  productCutout: new Uint8Array([1, 2, 3]),
  composition: new Uint8Array([1, 2, 3]),
  protectionMask: new Uint8Array(),
  prompt: "test",
  quality: "high" as const,
  size: "1536x1024" as const,
  lighting: {
    direction: "automatic" as const,
    temperature: "neutral" as const,
    hardness: "balanced" as const,
  },
  placement: { x: 0.5, y: 0.7, operation: "place" as const, objectCount: 1 },
  idempotencyKey: "test-key",
  references: [],
  mode: "insert" as const,
  outputQuality: "final" as const,
  preserveBackground: true,
};

/** The rate card for this request: high quality, 1536x1024. */
const BILLED_USD = 0.165;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function abort(name: "TimeoutError" | "AbortError" | "TypeError"): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

describe("the cost of a call that failed", () => {
  it("prices a timeout: the request reached the model", async () => {
    fetchMock.mockRejectedValue(abort("TimeoutError"));
    const result = await new OpenAIImageProvider().edit(request);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("timeout");
    expect(result.estimatedCostUsd).toBeCloseTo(BILLED_USD);
  });

  it("prices an empty answer to HTTP 200: the model ran", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "x-request-id": "req-1" }),
      json: async () => ({ data: [] }),
    });
    const result = await new OpenAIImageProvider().edit(request);
    expect(result.error?.code).toBe("empty_image_response");
    expect(result.estimatedCostUsd).toBeCloseTo(BILLED_USD);
  });

  it("reserves cost when a network failure cannot prove the request never landed", async () => {
    fetchMock.mockRejectedValue(abort("TypeError"));
    const result = await new OpenAIImageProvider().edit(request);
    expect(result.error?.code).toBe("network_error");
    expect(result.estimatedCostUsd).toBeCloseTo(BILLED_USD);
  });

  it("leaves a refusal before generation at zero", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      headers: new Headers(),
      json: async () => ({ error: { code: "moderation_blocked" } }),
    });
    const result = await new OpenAIImageProvider().edit(request);
    expect(result.safety?.blocked).toBe(true);
    expect(result.estimatedCostUsd).toBe(0);
  });

  it("still prices a success at the same rate", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        data: [{ b64_json: Buffer.from([1, 2, 3]).toString("base64") }],
      }),
    });
    const result = await new OpenAIImageProvider().edit(request);
    expect(result.status).toBe("succeeded");
    expect(result.estimatedCostUsd).toBeCloseTo(BILLED_USD);
  });
});
