import { describe, expect, it } from "vitest";
import {
  canTransitionPipeline,
  type ImageGenerationProvider,
  normalizePoint,
  routeImageProvider,
  selectProvider,
  shouldRetryAttempt,
} from "../src/index";

const provider = (
  name: string,
  available: boolean,
): ImageGenerationProvider => ({
  name,
  model: name,
  isAvailable: () => available,
  generate: async () => ({
    provider: name,
    model: name,
    requestId: `${name}-request`,
    status: "succeeded",
    durationMs: 1,
    estimatedCostUsd: 0,
    images: [],
    safety: { blocked: false },
    attemptCount: 1,
  }),
});

describe("provider routing", () => {
  it("keeps the legacy selector backwards compatible", () => {
    expect(
      selectProvider(provider("openai", true), provider("mock", true)).name,
    ).toBe("openai");
    expect(
      selectProvider(provider("openai", false), provider("mock", true)).name,
    ).toBe("mock");
  });

  it("routes previews and finals to Google", () => {
    const config = {
      mockMode: false,
      googleAvailable: true,
      openAIAvailable: true,
      openAIEnabled: false,
    };
    expect(
      routeImageProvider({ mode: "insert", outputQuality: "preview" }, config),
    ).toMatchObject({ provider: "google", modelRole: "preview" });
    expect(
      routeImageProvider({ mode: "replace", outputQuality: "final" }, config),
    ).toMatchObject({ provider: "google", modelRole: "final" });
  });

  it("uses OpenAI only as an explicitly enabled degraded fallback", () => {
    expect(
      routeImageProvider(
        { mode: "replace", outputQuality: "final" },
        {
          mockMode: false,
          googleAvailable: false,
          openAIAvailable: true,
          openAIEnabled: true,
        },
      ),
    ).toMatchObject({
      provider: "openai",
      modelRole: "fallback",
      degradedMode: true,
    });
  });

  it("never performs a paid call in mock mode", () => {
    expect(
      routeImageProvider(
        { mode: "insert", outputQuality: "final" },
        {
          mockMode: true,
          googleAvailable: true,
          openAIAvailable: true,
          openAIEnabled: true,
        },
      ).provider,
    ).toBe("mock");
  });
});

describe("pipeline safety helpers", () => {
  it("normalizes finite coordinates", () => {
    expect(normalizePoint({ x: -0.2, y: 1.4 })).toEqual({ x: 0, y: 1 });
    expect(() => normalizePoint({ x: Number.NaN, y: 0.5 })).toThrow();
  });

  it("accepts only declared state transitions", () => {
    expect(canTransitionPipeline("uploaded", "analyzing_scene")).toBe(true);
    expect(canTransitionPipeline("analyzing_scene", "removing_target")).toBe(
      true,
    );
    expect(
      canTransitionPipeline("awaiting_mask_confirmation", "computing_geometry"),
    ).toBe(true);
    expect(canTransitionPipeline("uploaded", "completed")).toBe(false);
  });

  it("retries only retryable failures below the strict cap", () => {
    const base = {
      provider: "google",
      model: "gemini-3-pro-image",
      requestId: "request-1",
      status: "failed" as const,
      durationMs: 10,
      estimatedCostUsd: 0,
      images: [],
      safety: { blocked: false },
      attemptCount: 1,
    };
    expect(
      shouldRetryAttempt({
        ...base,
        error: { code: "rate_limit", message: "retry", retryable: true },
      }),
    ).toBe(true);
    expect(
      shouldRetryAttempt({
        ...base,
        attemptCount: 2,
        error: { code: "rate_limit", message: "retry", retryable: true },
      }),
    ).toBe(false);
    expect(
      shouldRetryAttempt({
        ...base,
        error: { code: "invalid", message: "fix input", retryable: false },
      }),
    ).toBe(false);
  });
});
