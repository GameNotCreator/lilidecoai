import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  globalSpatialSceneSchema,
  planSpatialPlacement,
  footprintOnSupport,
  segmentOnSupport,
} from "../lib/spatial-scene";
import { globalRoom } from "./fixtures/spatial-room";
const input = {
  scene: globalRoom,
  fingerprint: "a".repeat(64),
  width: 600,
  height: 400,
  point: { x: 0.5, y: 0.8 },
  kind: "floor" as const,
  size: { widthCm: 42, heightCm: 80, depthCm: 45 },
};
describe("global room planning", () => {
  it("previews a rug in its floor plane without using thickness as extent", () => {
    const thin = planSpatialPlacement({
      ...input,
      shape: "plane",
      size: { ...input.size, heightCm: 1 },
    });
    const thicker = planSpatialPlacement({
      ...input,
      shape: "plane",
      size: { ...input.size, heightCm: 3 },
    });
    expect(thin.projection.points).toEqual(thicker.projection.points);
    expect(thin.projection.points.slice(0, 4)).toEqual(
      thin.projection.points.slice(4),
    );
    expect(thin.projection.world.every((p) => p.y === 0)).toBe(true);
    expect(thin.supportFits).toBe(true);
    expect(thin.projection.metricVerified).toBe(false);
  });
  it("recomputes point and orientation with one unchanged room analysis", () => {
    const near = planSpatialPlacement(input);
    const far = planSpatialPlacement({
      ...input,
      point: { x: 0.5, y: 0.55 },
      yawDegrees: 35,
    });
    expect(far.projection.origin.z).toBeGreaterThan(near.projection.origin.z);
    expect(far.projection.yawDegrees).toBe(35);
    expect(input.size.heightCm).toBe(80);
    expect(near.supportFits).toBe(true);
  });
  it("never claims complete camera calibration from a known segment", () => {
    const plan = planSpatialPlacement({
      ...input,
      reference: {
        surfaceId: "surface-0",
        sceneFingerprint: input.fingerprint,
        points: [
          { x: 0.25, y: 0.7 },
          { x: 0.75, y: 0.7 },
        ],
        lengthCm: 100,
      },
    });
    expect(plan.calibration).toBe("reference_scaled");
    expect(plan.projection.metricVerified).toBe(false);
    expect(plan.projection.size).toEqual(input.size);
    expect(() =>
      planSpatialPlacement({
        ...input,
        reference: {
          surfaceId: "surface-1",
          sceneFingerprint: input.fingerprint,
          points: [
            { x: 0.25, y: 0.7 },
            { x: 0.75, y: 0.7 },
          ],
          lengthCm: 100,
        },
      }),
    ).toThrow(/même support/);
  });
  it("refuses a footprint enclosing a hole, and a reference crossing a hole", () => {
    const square = (a: number, b: number) => [
      { x: a, y: a },
      { x: b, y: a },
      { x: b, y: b },
      { x: a, y: b },
    ];
    const surface = { ...globalRoom.surfaces[0]!, holes: [square(0.45, 0.55)] };
    expect(footprintOnSupport(square(0.3, 0.7), surface)).toBe(false);
    expect(
      segmentOnSupport({ x: 0.3, y: 0.5 }, { x: 0.7, y: 0.5 }, surface),
    ).toBe(false);
  });
  it("does not guess between overlapping supports or reinterpret floor as table", () => {
    expect(() =>
      planSpatialPlacement({
        ...input,
        scene: {
          ...globalRoom,
          surfaces: [...globalRoom.surfaces, ...globalRoom.surfaces],
        },
      }),
    ).toThrow(/Plusieurs/);
    expect(() => planSpatialPlacement({ ...input, kind: "table" })).toThrow(
      /support/,
    );
  });
  it("validates model intervals and serializes a strict provider schema", () => {
    expect(() =>
      globalSpatialSceneSchema.parse({
        ...globalRoom,
        pitchDownDegrees: { min: 35, estimate: 30, max: 25 },
      }),
    ).toThrow();
    expect(z.toJSONSchema(globalSpatialSceneSchema).additionalProperties).toBe(
      false,
    );
  });
});
