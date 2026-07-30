import { describe, expect, it } from "vitest";
import {
  type ImageGenerationProvider,
  selectProvider,
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
    status: "succeeded",
    durationMs: 1,
    estimatedCostUsd: 0,
  }),
});

describe("provider selection", () => {
  it("uses OpenAI only when configured", () => {
    expect(selectProvider(provider("openai", true), provider("mock", true)).name).toBe(
      "openai",
    );
    expect(selectProvider(provider("openai", false), provider("mock", true)).name).toBe(
      "mock",
    );
  });
});

