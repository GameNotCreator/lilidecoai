import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  SPATIAL_CONTACT_SHADOW_POLICY as policy,
  transferSpatialContactShadow,
} from "../lib/server/spatial-contact-shadow";

function sample(exposure = 1, shadow = 1) {
  const width = 192,
    height = 160,
    length = width * height;
  const original = Buffer.alloc(length * 3),
    generated = Buffer.alloc(length * 3);
  const authorization = Buffer.alloc(length),
    freeSupport = Buffer.alloc(length, 255),
    objectAlpha = Buffer.alloc(length);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      authorization[i] = x >= 40 && x < 152 && y >= 48 && y < 137 ? 255 : 0;
      objectAlpha[i] = x >= 88 && x < 104 && y >= 60 && y < 111 ? 255 : 0;
      for (let c = 0; c < 3; c++) {
        original[i * 3 + c] = [140, 100, 60][c]!;
        generated[i * 3 + c] = Math.round(
          original[i * 3 + c]! *
            exposure *
            (authorization[i] && !objectAlpha[i] ? shadow : 1),
        );
      }
    }
  return {
    original,
    generated,
    authorization,
    freeSupport,
    objectAlpha,
    width,
    height,
  };
}
const pixel = (input: ReturnType<typeof sample>, x: number, y: number) =>
  y * input.width + x;
const at = (image: Buffer, i: number) => image.subarray(i * 3, i * 3 + 3);
/** Check every support channel without constructing a matcher for each pixel. */
function changedSupportChannels(
  candidate: Buffer,
  input: ReturnType<typeof sample>,
) {
  let differences = 0;
  for (let i = 0; i < input.objectAlpha.length; i++)
    if (!input.objectAlpha[i])
      for (let c = 0; c < 3; c++)
        if (candidate[i * 3 + c] !== input.original[i * 3 + c]) differences++;
  return differences;
}

describe("experimental contact shadow transfer", () => {
  it.each([1, 0.75, 1.25])(
    "does not invent shadows for uniform exposure %s",
    (exposure) => {
      const input = sample(exposure),
        result = transferSpatialContactShadow(input);
      expect(result.evidence).toMatchObject({
        status: "experimental",
        qualification: "not-qualified",
        modifiedPixels: 0,
      });
      expect(result.evidence.exposureGain).toBeCloseTo(exposure, 2);
      expect(result.candidate.length).toBe(input.original.length);
      expect(changedSupportChannels(result.candidate, input)).toBe(0);
    },
  );
  it("keeps source parquet colors, product pixels, holes and authorization unchanged", () => {
    const input = sample(1, 0.7);
    const hole = pixel(input, 120, 115),
      soft = pixel(input, 87, 85);
    input.freeSupport[hole] = 0;
    input.objectAlpha[soft] = 1;
    for (let c = 0; c < 3; c++)
      input.generated[soft * 3 + c] = [255, 20, 180][c]!;
    const before = structuredClone(input),
      result = transferSpatialContactShadow(input);
    for (const key of [
      "original",
      "generated",
      "authorization",
      "freeSupport",
      "objectAlpha",
    ] as const)
      expect(input[key].equals(Buffer.from(before[key]))).toBe(true);
    expect(input.width).toBe(before.width);
    expect(input.height).toBe(before.height);
    expect(result.evidence.modifiedPixels).toBeGreaterThan(0);
    expect(result.candidate.length).toBe(input.original.length);
    expect(result.gain.length).toBe(input.objectAlpha.length);
    let productChannelDifferences = 0,
      protectedChannelDifferences = 0,
      checkedChannels = 0,
      minSupportGain = Infinity,
      maxSupportGain = -Infinity,
      maxSupportChannelError = 0;
    for (let i = 0; i < input.objectAlpha.length; i++) {
      const alpha = input.objectAlpha[i]!;
      if (alpha) {
        for (let c = 0; c < 3; c++)
          if (
            result.candidate[i * 3 + c] !==
            Math.round(
              (input.generated[i * 3 + c]! * alpha +
                input.original[i * 3 + c]! * (255 - alpha)) /
                255,
            )
          )
            productChannelDifferences++;
      } else if (!input.authorization[i] || !input.freeSupport[i]) {
        for (let c = 0; c < 3; c++)
          if (result.candidate[i * 3 + c] !== input.original[i * 3 + c])
            protectedChannelDifferences++;
      } else {
        minSupportGain = Math.min(minSupportGain, result.gain[i]!);
        maxSupportGain = Math.max(maxSupportGain, result.gain[i]!);
        for (let c = 0; c < 3; c++)
          maxSupportChannelError = Math.max(
            maxSupportChannelError,
            Math.abs(
              result.candidate[i * 3 + c]! -
                input.original[i * 3 + c]! * result.gain[i]!,
            ),
          );
      }
      checkedChannels += 3;
    }
    expect(checkedChannels).toBe(input.width * input.height * 3);
    expect(productChannelDifferences).toBe(0);
    expect(protectedChannelDifferences).toBe(0);
    expect(minSupportGain).toBeGreaterThanOrEqual(policy.minimumGain - 1e-6);
    expect(maxSupportGain).toBeLessThanOrEqual(1);
    expect(maxSupportChannelError).toBeLessThanOrEqual(0.501);
    expect(result.gain[pixel(input, 40, 85)]).toBe(1); // Outer boundary fade.
    expect(result.gain[pixel(input, 145, 130)]).toBe(1); // Too far from the object.
    expect(result.gain[pixel(input, 75, 90)]).toBeLessThan(0.9);
  });
  it("caps darkening after compensating a global exposure drift", () => {
    const result = transferSpatialContactShadow(sample(1.2, 0.4));
    expect(result.evidence.exposureGain).toBeCloseTo(1.2, 2);
    expect(result.gain[90 * 192 + 75]).toBeCloseTo(0.65, 5);
  });
  it("does not transfer a generated blue tint into the floor", () => {
    const input = sample();
    for (let i = 0; i < input.objectAlpha.length; i++)
      if (input.authorization[i] && !input.objectAlpha[i]) {
        input.generated.set([15, 20, 90], i * 3);
      }
    const result = transferSpatialContactShadow(input),
      actual = at(result.candidate, pixel(input, 75, 90));
    expect(result.evidence.modifiedPixels).toBeGreaterThan(0);
    expect(actual[0]).toBeGreaterThan(actual[1]!);
    expect(actual[1]).toBeGreaterThan(actual[2]!);
  });
  it.each([
    "missing-reference",
    "noisy-reference",
    "dark-reference",
    "missing-object",
    "excess-exposure",
    "no-shadow-samples",
  ])("leaves the support unchanged when evidence is %s", (scenario) => {
    const input = sample(1, 0.7);
    if (scenario === "missing-reference")
      input.freeSupport.set(input.authorization);
    if (scenario === "missing-object") input.objectAlpha.fill(0);
    if (scenario === "dark-reference") input.original.fill(0);
    if (scenario === "no-shadow-samples")
      for (let i = 0; i < input.authorization.length; i++)
        if (input.authorization[i] && !input.objectAlpha[i])
          input.freeSupport[i] = 0;
    if (scenario === "noisy-reference" || scenario === "excess-exposure")
      for (let i = 0; i < input.authorization.length; i++)
        if (!input.authorization[i]) {
          for (let c = 0; c < 3; c++)
            input.generated[i * 3 + c] =
              scenario === "excess-exposure"
                ? 255
                : Math.round(input.original[i * 3 + c]! * (i % 2 ? 0.5 : 1.5));
        }
    const result = transferSpatialContactShadow(input);
    expect(result.evidence).toMatchObject({
      status: "insufficient-evidence",
      modifiedPixels: 0,
      qualification: "not-qualified",
    });
    expect(result.candidate.length).toBe(input.original.length);
    expect(changedSupportChannels(result.candidate, input)).toBe(0);
  });
  it("averages signed texture residuals rather than only the dark pixels", () => {
    const input = sample();
    for (let y = 0; y < input.height; y++)
      for (let x = 0; x < input.width; x++) {
        const i = pixel(input, x, y),
          value = (x + y) % 2 ? 80 : 160;
        input.original.fill(value, i * 3, i * 3 + 3);
        input.generated.fill(
          input.authorization[i] && !input.objectAlpha[i] ? 240 - value : value,
          i * 3,
          i * 3 + 3,
        );
      }
    const result = transferSpatialContactShadow(input);
    expect(result.gain[pixel(input, 75, 90)]).toBe(1);
  });
  it.each([
    "fractional",
    "oversized",
    "missing-rgb",
    "mask-length",
    "soft-authorization",
    "soft-support",
    "unauthorized-object",
  ])("refuses an invalid %s input", (scenario) => {
    const input = sample();
    if (scenario === "fractional") input.width = 2.5;
    if (scenario === "oversized") input.width = 4_000_001;
    if (scenario === "missing-rgb") input.generated = Buffer.alloc(0);
    if (scenario === "mask-length") input.objectAlpha = Buffer.alloc(0);
    if (scenario === "soft-authorization") input.authorization[0] = 128;
    if (scenario === "soft-support") input.freeSupport[0] = 128;
    if (scenario === "unauthorized-object") input.objectAlpha[0] = 255;
    expect(() => transferSpatialContactShadow(input)).toThrow(/Invalid shadow/);
  });
});
