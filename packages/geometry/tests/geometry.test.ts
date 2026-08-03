import { describe, expect, it } from "vitest";
import {
  GeometryError,
  calibrateSegment,
  calibrateSurface,
  cmToPixels,
  pixelsToCm,
  pointInPolygon,
  projectPoint,
  rotatePoint,
  selectOutputSize,
  validatePlacementFit,
} from "../src/index";

describe("unit conversions", () => {
  it("converts centimeters and pixels in both directions", () => {
    expect(cmToPixels(40, 3.25)).toBe(130);
    expect(pixelsToCm(130, 3.25)).toBe(40);
  });

  it("rejects invalid dimensions", () => {
    expect(() => cmToPixels(0, 2)).toThrow(GeometryError);
  });
});

describe("wall calibration", () => {
  it("calculates scale and dominant axis", () => {
    const result = calibrateSegment({ x: 10, y: 20 }, { x: 210, y: 20 }, 100);
    expect(result.pixelsPerCentimeter).toBe(2);
    expect(result.axis).toBe("horizontal");
  });

  it("rejects degenerate segments", () => {
    expect(() =>
      calibrateSegment({ x: 1, y: 1 }, { x: 1.5, y: 1.5 }, 20),
    ).toThrowError(/at least two pixels/);
  });
});

describe("surface homography", () => {
  it("maps real surface coordinates into a perspective quad", () => {
    const calibration = calibrateSurface(
      [
        { x: 100, y: 100 },
        { x: 500, y: 120 },
        { x: 430, y: 380 },
        { x: 150, y: 360 },
      ],
      120,
      80,
    );
    const bottomRight = projectPoint(calibration.homography, { x: 120, y: 80 });
    expect(bottomRight.x).toBeCloseTo(430, 5);
    expect(bottomRight.y).toBeCloseTo(380, 5);
  });

  it("rejects degenerate surfaces", () => {
    expect(() =>
      calibrateSurface(
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 2, y: 0 },
          { x: 3, y: 0 },
        ],
        100,
        50,
      ),
    ).toThrowError(/degenerate/);
  });
});

describe("placement utilities", () => {
  it("tests surface bounds", () => {
    const polygon = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    expect(pointInPolygon({ x: 50, y: 50 }, polygon)).toBe(true);
    expect(pointInPolygon({ x: 150, y: 50 }, polygon)).toBe(false);
  });

  it("accepts a product that stays inside the available support volume", () => {
    const result = validatePlacementFit({
      imageWidth: 1600,
      imageHeight: 1000,
      productWidthCm: 20,
      productHeightCm: 30,
      xNormalized: 0.5,
      yNormalized: 0.72,
      scale: 0.12,
      fitBounds: { xMin: 0.35, yMin: 0.38, xMax: 0.65, yMax: 0.74 },
    });
    expect(result.fits).toBe(true);
    expect(result.productBounds.yMax).toBe(0.72);
  });

  it("accepts exact contact with the support bottom plane", () => {
    const result = validatePlacementFit({
      imageWidth: 1536,
      imageHeight: 1024,
      productWidthCm: 30,
      productHeightCm: 50,
      xNormalized: 0.52,
      yNormalized: 0.668,
      scale: 0.15,
      fitBounds: { xMin: 0.4, yMin: 0.2, xMax: 0.64, yMax: 0.668 },
      marginRatio: 0.006,
    });
    expect(result.fits).toBe(true);
    expect(result.violations).not.toContain("bottom");
  });

  it("accepts side contact within the analysis rounding tolerance", () => {
    const result = validatePlacementFit({
      imageWidth: 1536,
      imageHeight: 1024,
      productWidthCm: 40,
      productHeightCm: 60,
      xNormalized: 0.5135,
      yNormalized: 0.68,
      scale: 0.187,
      fitBounds: { xMin: 0.42, yMin: 0.2, xMax: 0.607, yMax: 0.68 },
      marginRatio: 0.006,
    });
    expect(result.fits).toBe(true);
    expect(result.violations).not.toContain("right");
  });

  it("rejects a product that would cross the top of a niche", () => {
    const result = validatePlacementFit({
      imageWidth: 1600,
      imageHeight: 1000,
      productWidthCm: 18,
      productHeightCm: 50,
      xNormalized: 0.5,
      yNormalized: 0.65,
      scale: 0.14,
      fitBounds: { xMin: 0.35, yMin: 0.35, xMax: 0.65, yMax: 0.67 },
    });
    expect(result.fits).toBe(false);
    expect(result.violations).toContain("top");
  });

  it("rejects a placement when the horizontal space is too narrow", () => {
    const result = validatePlacementFit({
      imageWidth: 1200,
      imageHeight: 1200,
      productWidthCm: 30,
      productHeightCm: 30,
      xNormalized: 0.5,
      yNormalized: 0.7,
      scale: 0.2,
      fitBounds: { xMin: 0.44, yMin: 0.3, xMax: 0.56, yMax: 0.72 },
    });
    expect(result.fits).toBe(false);
    expect(result.violations).toEqual(
      expect.arrayContaining(["left", "right"]),
    );
  });

  it("rotates around an anchor", () => {
    expect(rotatePoint({ x: 10, y: 0 }, { x: 0, y: 0 }, 90)).toEqual({
      x: expect.closeTo(0, 8),
      y: expect.closeTo(10, 8),
    });
  });

  it("chooses one of the allowed OpenAI sizes", () => {
    expect(selectOutputSize(1600, 900)).toBe("1536x1024");
    expect(selectOutputSize(900, 1600)).toBe("1024x1536");
    expect(selectOutputSize(1000, 950)).toBe("1024x1024");
  });
});
