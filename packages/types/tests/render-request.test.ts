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

  it("accepts up to three numbered placements in the simple demo workflow", () => {
    const parsed = renderRequestSchema.parse({
      ...base,
      workflow: "simple_point",
      placementPoint: { x: 0.4, y: 0.8 },
      simplePlacements: [
        {
          productId: "22222222-2222-4222-8222-222222222222",
          placementPoint: { x: 0.4, y: 0.8 },
          dimensionPair: {
            mode: "height_length",
            heightCm: 42,
            lengthCm: 24,
          },
        },
        {
          productId: "33333333-3333-4333-8333-333333333333",
          placementPoint: { x: 0.7, y: 0.75 },
          dimensionPair: {
            mode: "length_width",
            lengthCm: 30,
            widthCm: 18,
          },
        },
      ],
    });
    expect(parsed.mode).toBe("insert");
    expect(parsed.simplePlacements).toHaveLength(2);
    expect(parsed.simplePlacements?.[1]?.placementPoint).toEqual({
      x: 0.7,
      y: 0.75,
    });
  });

  it("requires both values of the selected dimension pair", () => {
    expect(() =>
      renderRequestSchema.parse({
        ...base,
        workflow: "simple_point",
        placementPoint: { x: 0.4, y: 0.8 },
        simplePlacements: [
          {
            productId: "22222222-2222-4222-8222-222222222222",
            placementPoint: { x: 0.4, y: 0.8 },
            dimensionPair: {
              mode: "height_length",
              heightCm: 42,
            },
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects more than three simple placements", () => {
    const placement = {
      productId: "22222222-2222-4222-8222-222222222222",
      placementPoint: { x: 0.4, y: 0.8 },
      dimensionReference: { axis: "height" as const, valueCm: 42 },
    };
    expect(() =>
      renderRequestSchema.parse({
        ...base,
        workflow: "simple_point",
        simplePlacements: [placement, placement, placement, placement],
      }),
    ).toThrow();
  });
});
