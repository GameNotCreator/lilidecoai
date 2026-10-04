import { describe, expect, it } from "vitest";
import { fitManualProductBox, isManualPlaneValid, manualPlacementAnchor, manualPlacementQuad,
  manualPlacementTransform, moveManualPlacement, normalizeManualBox, projectManualPhotoPointToPlane,
  resizeManualPlacement, type ManualPlacement } from "../src/index";

const floor: NonNullable<ManualPlacement["plane"]> = [{ x: 0.3, y: 0.45 }, { x: 0.7, y: 0.45 },
  { x: 0.95, y: 0.95 }, { x: 0.05, y: 0.95 }];
const box = { xMin: 0.2, yMin: 0.3, xMax: 0.8, yMax: 0.8 };

describe("manual composition geometry shared by browser and server", () => {
  it("accepts opposite corners in either direction", () => {
    const a = { x: 0.8, y: 0.3 }; const b = { x: 0.2, y: 0.8 };
    expect(normalizeManualBox(a, b)).toEqual(box);
    expect(normalizeManualBox(b, a)).toEqual(box);
  });
  it("fits the actual product aspect inside the selected box at its bottom contact", () => {
    const fitted = fitManualProductBox({ box }, 0.5, 1200, 800, "standing");
    expect(fitted.box.yMax).toBeCloseTo(0.8);
    expect((fitted.box.xMax - fitted.box.xMin) * 1200 /
      ((fitted.box.yMax - fitted.box.yMin) * 800)).toBeCloseTo(0.5);
    expect(fitted.box.xMin).toBeGreaterThan(box.xMin);
    expect(manualPlacementAnchor(fitted)).toEqual({ x: 0.5, y: 0.8 });
  });
  it("projects a floor rug with perspective and reverses the same homography for raster samples", () => {
    const placement = { box, plane: floor };
    const quad = manualPlacementQuad(placement);
    expect(quad[1].x - quad[0].x).toBeLessThan(quad[2].x - quad[3].x);
    for (const [i, uv] of [[0, { x: 0.2, y: 0.3 }], [2, { x: 0.8, y: 0.8 }]] as const) {
      const inverse = projectManualPhotoPointToPlane(quad[i], floor)!;
      expect(inverse.x).toBeCloseTo(uv.x); expect(inverse.y).toBeCloseTo(uv.y);
    }
    const sourceUv = projectManualPhotoPointToPlane(quad[2], quad)!;
    expect(sourceUv.x).toBeCloseTo(1); expect(sourceUv.y).toBeCloseTo(1);
  });
  it("uses matching projected photo corners in the CSS perspective matrix", () => {
    const placement = fitManualProductBox({ box, plane: floor }, 1.4, 1000, 800, "flat");
    const quad = manualPlacementQuad(placement);
    const matrix = manualPlacementTransform(placement, 600, 480).slice(9, -1).split(",").map(Number);
    for (const [i, x, y] of [[0, 0, 0], [1, 1, 0], [2, 1, 1], [3, 0, 1]] as const) {
      const divisor = matrix[3]! * x + matrix[7]! * y + 1;
      expect((matrix[0]! * x + matrix[4]! * y + matrix[12]!) / divisor).toBeCloseTo(quad[i].x * 600);
      expect((matrix[1]! * x + matrix[5]! * y + matrix[13]!) / divisor).toBeCloseTo(quad[i].y * 480);
    }
  });
  it("rejects crossing and almost collinear four-point planes", () => {
    expect(isManualPlaneValid(floor)).toBe(true);
    expect(isManualPlaneValid([floor[0], floor[2], floor[1], floor[3]])).toBe(false);
    expect(isManualPlaneValid([{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }, { x: 0.3, y: 0.3 }, { x: 0.4, y: 0.4 }])).toBe(false);
  });
  it("moves freely without a replacement region and resizes within the image", () => {
    const fitted = fitManualProductBox({ box }, 0.5, 1000, 800);
    const moved = moveManualPlacement(fitted, { x: 0.98, y: 0.99 });
    expect(moved.box.xMax).toBeCloseTo(1);
    expect(moved.box.xMax - moved.box.xMin).toBeCloseTo(fitted.box.xMax - fitted.box.xMin);
    const enlarged = resizeManualPlacement(moved, 0.9);
    expect(enlarged.box.yMax).toBeCloseTo(moved.box.yMax);
    expect(enlarged.box.xMax).toBeLessThanOrEqual(1);
    expect(enlarged.box.yMin).toBeGreaterThanOrEqual(0);
  });
});
