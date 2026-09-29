import { expect, it } from "vitest";
import { projectSpatialPlane } from "./spatial-plane";
const camera = {
  width: 800,
  height: 600,
  focalPx: 800,
  heightAboveSupportCm: 160,
  pitchDownDegrees: 30,
};
it("keeps physical width/depth and all four contacts on the floor", () => {
  const result = projectSpatialPlane(
    camera,
    { x: 400, y: 480 },
    { widthCm: 80, depthCm: 120 },
    35,
  );
  expect(result.world.every((p) => p.y === 0)).toBe(true);
  const [a, b, c] = result.world;
  expect(Math.hypot(a!.x - b!.x, a!.z - b!.z)).toBeCloseTo(80);
  expect(Math.hypot(b!.x - c!.x, b!.z - c!.z)).toBeCloseTo(120);
  expect(result.metricVerified).toBe(false);
});
it("foreshortens the far edge and makes an identical distant rug smaller", () => {
  const size = { widthCm: 40, depthCm: 60 };
  const near = projectSpatialPlane(camera, { x: 400, y: 500 }, size, 0),
    far = projectSpatialPlane(camera, { x: 400, y: 340 }, size, 0);
  const span = (p: typeof near) => p.corners[2].x - p.corners[3].x;
  expect(span(far)).toBeLessThan(span(near));
  expect(near.corners[1].x - near.corners[0].x).toBeLessThan(span(near));
});
it("reports overflow without shrinking and rejects cameras below the floor", () => {
  const size = { widthCm: 500, depthCm: 80 };
  const result = projectSpatialPlane(camera, { x: 400, y: 550 }, size, 0);
  expect(result.fits).toBe(false);
  expect(result.dimensions).toEqual(size);
  expect(() =>
    projectSpatialPlane(
      { ...camera, heightAboveSupportCm: -100 },
      { x: 400, y: 500 },
      size,
      0,
    ),
  ).toThrow();
});
