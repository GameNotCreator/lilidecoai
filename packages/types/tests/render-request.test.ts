import { describe, expect, it } from "vitest";
import { renderRequestSchema } from "../src/index";

const base = {
  placement: {
    sceneId: "11111111-1111-4111-8111-111111111111",
    productId: "22222222-2222-4222-8222-222222222222",
    xNormalized: 0.4,
    yNormalized: 0.7,
  },
  idempotencyKey: "request-1",
};

describe("render request schema", () => {
  it("keeps the legacy insert request compatible", () => {
    const parsed = renderRequestSchema.parse(base);
    expect(parsed.mode).toBe("insert");
    expect(parsed.outputQuality).toBe("final");
    expect(parsed.preserveBackground).toBe(true);
  });

  it("requires a confirmed mask for replacement", () => {
    expect(() =>
      renderRequestSchema.parse({ ...base, mode: "replace" }),
    ).toThrow(/Sélectionnez|masque/);
  });

  it("accepts a complete calibrated replacement request", () => {
    expect(
      renderRequestSchema.parse({
        ...base,
        mode: "replace",
        placementPoint: { x: 0.4, y: 0.8 },
        targetPoint: { x: 0.42, y: 0.72 },
        targetMaskId: "33333333-3333-4333-8333-333333333333",
        surfaceType: "existing_object",
        dimensionsCm: { width: 80, height: 90, depth: 75, unit: "cm" },
        calibration: {
          realLength: 120,
          referencePoints: [
            { x: 0.2, y: 0.8 },
            { x: 0.7, y: 0.8 },
          ],
          unit: "cm",
          source: "manual",
        },
      }).mode,
    ).toBe("replace");
  });
});
