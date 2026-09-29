import { describe, it, expect } from "vitest";
import {
  intersectSupport,
  projectSpatialPoint,
  projectSpatialBox,
  calibrateSpatialSupport,
} from "./spatial-projection";
const camera = {
  width: 1000,
  height: 800,
  focalPx: 800,
  heightAboveSupportCm: 150,
  pitchDownDegrees: 30,
};
describe("spatial projection", () => {
  it("recovers known support scale from a measured horizontal segment", () => {
    const calibrated = calibrateSpatialSupport(
      { ...camera, pitchDownDegrees: 0, heightAboveSupportCm: 90 },
      [
        { x: 300, y: 700 },
        { x: 700, y: 700 },
      ],
      200,
    );
    // For a level camera: length = pixelSpan * H / (pixelY - cy).
    expect(calibrated.camera.heightAboveSupportCm).toBeCloseTo(150);
    expect(calibrated.metricVerified).toBe(false);
    expect(() =>
      calibrateSpatialSupport(
        camera,
        [
          { x: 400, y: 500 },
          { x: 402, y: 500 },
        ],
        20,
      ),
    ).toThrow();
  });
  it("round-trips support clicks through a real ray-plane intersection", () => {
    for (const pixel of [
      { x: 300, y: 500 },
      { x: 650, y: 680 },
    ]) {
      const p = projectSpatialPoint(camera, intersectSupport(camera, pixel));
      expect(p.x).toBeCloseTo(pixel.x, 8);
      expect(p.y).toBeCloseTo(pixel.y, 8);
    }
  });
  it("makes the same physical chair smaller at greater depth", () => {
    const size = { widthCm: 42, heightCm: 80, depthCm: 45 };
    const near = projectSpatialBox(camera, { x: 500, y: 650 }, size, 0),
      far = projectSpatialBox(camera, { x: 500, y: 400 }, size, 0);
    expect(far.origin.z).toBeGreaterThan(near.origin.z);
    expect(far.bounds.right - far.bounds.left).toBeLessThan(
      near.bounds.right - near.bounds.left,
    );
    expect(far.bounds.bottom - far.bounds.top).toBeLessThan(
      near.bounds.bottom - near.bounds.top,
    );
  });
  it("projects a floor rectangle with depth foreshortening and converging edges", () => {
    const p = projectSpatialBox(
      camera,
      { x: 500, y: 550 },
      { widthCm: 100, heightCm: 0.5, depthCm: 150 },
      0,
    ).footprint;
    expect(p[1]!.x - p[0]!.x).toBeGreaterThan(p[2]!.x - p[3]!.x);
    expect(p[0]!.y).toBeGreaterThan(p[3]!.y);
  });
  it("rejects impossible rays and geometry rather than clamping them onto a surface", () => {
    expect(() =>
      intersectSupport({ ...camera, pitchDownDegrees: 0 }, { x: 500, y: 200 }),
    ).toThrow();
    expect(() =>
      projectSpatialPoint(camera, { x: 0, y: 150, z: -10 }),
    ).toThrow();
    expect(() =>
      projectSpatialBox(
        camera,
        { x: 500, y: 600 },
        { widthCm: 0, heightCm: 80, depthCm: 40 },
        0,
      ),
    ).toThrow();
  });
  it("also supports a camera below a raised support looking upwards", () => {
    const low = {
      ...camera,
      heightAboveSupportCm: -100,
      pitchDownDegrees: -25,
    };
    const p = intersectSupport(low, { x: 500, y: 400 });
    expect(p.z).toBeGreaterThan(0);
    expect(projectSpatialPoint(low, p).y).toBeCloseTo(400);
  });
});
