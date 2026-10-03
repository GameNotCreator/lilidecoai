import { describe, expect, it } from "vitest";
import {
  buildOrientedHarmonizationPrompt,
  buildPreparedViewPrompt,
  shouldRetryAttempt,
} from "../src/index";

describe("oriented operation prompt contracts", () => {
  it("never invents an image 2 in harmonization or single-source preparation", () => {
    expect(buildOrientedHarmonizationPrompt()).not.toMatch(/image 2/i);
    expect(
      buildPreparedViewPrompt({ azimuthDeg: 0, elevationDeg: 45, rollDeg: 0 }),
    ).not.toMatch(/image 2/i);
  });

  it("describes requested orientation without claiming measured coverage", () => {
    const prompt = buildPreparedViewPrompt(
      { azimuthDeg: -30, elevationDeg: 45, rollDeg: 0 },
      true,
    );
    expect(prompt).toContain(
      "Requested camera orientation: azimuth -30 degrees",
    );
    expect(prompt).toContain(
      "Do not treat the requested angle as a measurement",
    );
    expect(prompt).toContain("Image 2");
    expect(prompt).toContain("positive = camera moves to product left");
    expect(prompt).not.toContain("camera moves to product right");
    expect(prompt).toContain("PROMPT_VERSION: prepared-view-v2.0.0");
  });

  it.each(["unknown", "succeeded"])(
    "prevents regeneration for %s provider outcomes despite a retryable local error",
    (providerOutcome) => {
      expect(
        shouldRetryAttempt({
          provider: "myarchitectai",
          model: "edit-by-prompt",
          requestId: "test",
          status: "failed",
          durationMs: 1,
          estimatedCostUsd: 0.03,
          images: [],
          safety: { blocked: false },
          attemptCount: 1,
          usage: { providerOutcome },
          error: {
            code: "local_error",
            message: "Local validation failed",
            retryable: true,
          },
        }),
      ).toBe(false);
    },
  );
});
