import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
vi.mock("server-only", () => ({}));
import {
  extractSpatialGeneratedLayer,
  spatialExtractionInteractionBlockers,
} from "../lib/server/spatial-generated-layer";

function sample() {
  const width = 6,
    height = 5;
  const original = Buffer.alloc(width * height * 3);
  const generated = Buffer.alloc(original.length);
  for (let i = 0; i < original.length; i++) {
    original[i] = (i * 3) % 256;
    generated[i] = 255 - original[i]!;
  }
  const envelope = Buffer.alloc(width * height);
  for (let y = 1; y < 4; y++)
    for (let x = 1; x < 5; x++) envelope[y * width + x] = 255;
  return {
    original,
    generated,
    envelope,
    width,
    height,
    mask: {
      data: Buffer.from([0, 255, 128, 0, 255, 0, 0, 255, 0, 1, 255, 0]),
      crop: { left: 1, top: 1, width: 4, height: 3 },
      generatedFingerprint: createHash("sha256")
        .update(generated)
        .digest("hex"),
    },
  };
}
describe("experimental extraction of the generated viewpoint", () => {
  it("keeps an unreviewed refinement blocked even when its crop and authorization are clean", () => {
    expect(
      spatialExtractionInteractionBlockers({
        clippedOpaquePixels: 0,
        cropEdgePixels: 0,
        interactionBlockers: [
          "unreviewed-seeded-refinement",
          "unreviewed-seeded-refinement",
        ],
      }),
    ).toEqual(["unreviewed-seeded-refinement"]);
  });
  it.each([null, "approved", [""], [1]])(
    "fails closed for invalid inherited blockers %s",
    (interactionBlockers) => {
      expect(
        spatialExtractionInteractionBlockers({
          clippedOpaquePixels: 0,
          cropEdgePixels: 0,
          interactionBlockers,
        }),
      ).toEqual(["invalid-extraction-evidence"]);
    },
  );
  it("blocks interactions with a truncated or unrelated foreground even when composition conserves protected pixels", () => {
    const input = sample();
    input.envelope[8] = 0;
    const result = extractSpatialGeneratedLayer(input);
    expect(result.candidate.subarray(24, 27)).toEqual(
      input.original.subarray(24, 27),
    );
    expect(spatialExtractionInteractionBlockers(result.evidence)).toEqual([
      "opaque-foreground-outside-authorization",
      "foreground-touches-crop-edge",
    ]);
  });
  it("does not treat a bounded mask as qualified or weak excluded alpha as opaque foreground", () => {
    const input = sample();
    input.mask.data.fill(0);
    input.mask.data[5] = 255;
    input.mask.data[6] = 2;
    input.envelope[15] = 0;
    const result = extractSpatialGeneratedLayer(input);
    expect(result.evidence).toMatchObject({
      clippedPixels: 1,
      clippedOpaquePixels: 0,
      maximumClippedAlpha: 2,
    });
    expect(spatialExtractionInteractionBlockers(result.evidence)).toEqual([]);
    expect(result.evidence.qualification).toBe("not-qualified");
    expect(
      spatialExtractionInteractionBlockers({
        clippedOpaquePixels: 0,
        cropEdgePixels: 0,
      }),
    ).toEqual([]);
  });
  it.each([undefined, NaN, -1, 0.5, Infinity])(
    "blocks interactions with invalid evidence %s",
    (count) => {
      expect(
        spatialExtractionInteractionBlockers({
          clippedOpaquePixels: count as number,
          cropEdgePixels: 0,
        }),
      ).toEqual(["invalid-extraction-evidence"]);
      expect(
        spatialExtractionInteractionBlockers({
          clippedOpaquePixels: 0,
          cropEdgePixels: count as number,
        }),
      ).toEqual(["invalid-extraction-evidence"]);
    },
  );
  it("keeps original decor in holes, exact generated RGB in opaque parts and the crop offset", () => {
    const input = sample();
    const before = structuredClone(input);
    const result = extractSpatialGeneratedLayer(input);
    expect(result.evidence.qualification).toBe("not-qualified");
    expect(result.alpha[8]).toBe(255);
    expect(result.alpha[14]).toBe(0); // Hole inside the object envelope.
    for (let i = 0; i < input.width * input.height; i++) {
      const actual = result.candidate.subarray(i * 3, i * 3 + 3);
      if (!result.alpha[i])
        expect(actual).toEqual(input.original.subarray(i * 3, i * 3 + 3));
      if (result.alpha[i] === 255)
        expect(actual).toEqual(input.generated.subarray(i * 3, i * 3 + 3));
      for (let c = 0; c < 3; c++)
        if (result.alpha[i])
          expect(result.layer[i * 4 + c]).toBe(input.generated[i * 3 + c]);
    }
    expect(structuredClone(input)).toEqual(before);
  });
  it("keeps even one-alpha thin detail without eroding or thresholding the mask", () => {
    const input = sample(),
      result = extractSpatialGeneratedLayer(input);
    expect(result.alpha[20]).toBe(1);
    expect(result.evidence.softPixels).toBe(2);
    expect(result.candidate[9 * 3]).toBe(
      Math.round(
        (input.generated[9 * 3]! * 128 + input.original[9 * 3]! * 127) / 255,
      ),
    );
  });
  it("reports excluded foreground and crop truncation without editing protected pixels", () => {
    const input = sample();
    input.envelope[8] = 0;
    const result = extractSpatialGeneratedLayer(input);
    expect(result.evidence).toMatchObject({
      qualification: "not-qualified",
      clippedPixels: 1,
      clippedOpaquePixels: 1,
      maximumClippedAlpha: 255,
    });
    expect(result.evidence.cropEdgePixels).toBeGreaterThan(0);
    expect(result.alpha[8]).toBe(0);
    expect(result.candidate.subarray(24, 27)).toEqual(
      input.original.subarray(24, 27),
    );
  });
  it("rejects a mask bound to another generated image", () => {
    const input = sample();
    input.generated[0] = 0;
    expect(() => extractSpatialGeneratedLayer(input)).toThrow(
      /another generated image/,
    );
  });
  it.each(["dimensions", "offset", "outside", "mask", "envelope", "empty"])(
    "refuses invalid %s rather than stretching or guessing",
    (scenario) => {
      const input = sample();
      if (scenario === "dimensions") input.width = NaN;
      if (scenario === "offset") input.mask.crop.left = 0.5;
      if (scenario === "outside") input.mask.crop.top = 4;
      if (scenario === "mask") input.mask.data = Buffer.alloc(3);
      if (scenario === "envelope") input.envelope[0] = 127;
      if (scenario === "empty") input.mask.data.fill(0);
      expect(() => extractSpatialGeneratedLayer(input)).toThrow();
    },
  );
});
