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

