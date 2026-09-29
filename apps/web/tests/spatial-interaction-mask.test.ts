import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  convexHull,
  spatialInteractionMask,
} from "../lib/server/spatial-interaction-mask";
import { isFreeSupport } from "../lib/spatial-scene";
import sharp from "sharp";
import { projectPlanarTexture } from "../lib/server/spatial-planar";
const rectangle = (x: number, y: number, w: number, h: number) => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];
const input = () => ({
  width: 100,
  height: 100,
  volume: [
    { x: 50, y: 20 },
    { x: 75, y: 50 },
    { x: 50, y: 80 },
    { x: 25, y: 50 },
  ],
  footprint: rectangle(40, 65, 20, 10),
  support: {
    boundary: rectangle(0, 0.6, 1, 0.4),
    holes: [rectangle(0.25, 0.7, 0.08, 0.1)],
    obstacles: [rectangle(0.65, 0.7, 0.1, 0.1)],
  },
  reflectiveRegions: [rectangle(0.35, 0.8, 0.3, 0.1)],
});
it("builds the convex outline independently of point ordering and rejects degeneracy", () => {
  const points = [...rectangle(0, 0, 10, 10), { x: 5, y: 5 }];
  expect(convexHull(points)).toEqual(convexHull([...points].reverse()));
  expect(convexHull(points)).toHaveLength(4);
  expect(() =>
    convexHull([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ]),
  ).toThrow();
});
it("removes the rug contact gap and fades only the exterior boundary, preserving v6 masks", async () => {
  const footprint = rectangle(30, 30, 40, 40);
  const args = {
    width: 100,
    height: 100,
    volume: footprint,
    footprint,
    support: { boundary: rectangle(0, 0, 1, 1), holes: [], obstacles: [] },
    reflectiveRegions: [],
  };
  const legacy = await spatialInteractionMask(args);
  const planar = await spatialInteractionMask({ ...args, planarContact: true });
  const at = (x: number) => 50 * 100 + x;
  expect(legacy.contactOpacity).toBeUndefined();
  expect(legacy.contactMask[at(29)]).toBe(0);
  expect(legacy.objectMask[at(29)]).toBe(255);
  expect(planar.objectMask[at(29)]).toBe(0);
  expect(planar.contactMask[at(29)]).toBe(255);
  expect(planar.contactOpacity![at(29)]).toBe(255);
  expect(planar.contactOpacity![at(20)]).toBe(0);
  expect(planar.contactOpacity![at(21)]).toBeGreaterThan(0);
  expect(planar.contactOpacity![at(21)]).toBeLessThan(
    planar.contactOpacity![at(22)]!,
  );
  expect(planar.contactOpacity![at(23)]).toBe(255);
  expect(planar.metadata).toMatchObject({
    policy: "plane-and-contact-v1",
    objectMarginPx: 0,
    contactFeatherPx: 3,
  });
});
it("matches projected texture coverage on oblique edges instead of leaving an antialiased gap", async () => {
  const corners = [
    { x: 45.2, y: 24.7 },
    { x: 78.8, y: 42.2 },
    { x: 62.4, y: 81.1 },
    { x: 22.6, y: 63.8 },
  ] as const;
  const support = {
    boundary: rectangle(0, 0, 1, 1),
    holes: [],
    obstacles: [],
    kind: "floor" as const,
    label: "floor",
    heightAboveSupportCm: { min: 150, estimate: 150, max: 150 },
    yawDegrees: 0,
    scaleEvidence: "synthetic",
  };
  const room = await sharp({
    create: { width: 100, height: 100, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  const texture = await sharp({
    create: { width: 100, height: 100, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const projected = await projectPlanarTexture({
    room,
    texture,
    support,
    sourceCorners: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ],
    targetCorners: corners,
  });
  const alpha = await sharp(projected.mask).greyscale().raw().toBuffer();
  const mask = await spatialInteractionMask({
    width: 100,
    height: 100,
    volume: [...corners],
    footprint: [...corners],
    support,
    reflectiveRegions: [],
    planarContact: true,
  });
  for (let i = 0; i < alpha.length; i++) {
    expect(Boolean(mask.objectMask[i])).toBe(Boolean(alpha[i]));
    if (!alpha[i] && mask.maskRaw[i * 4 + 3] === 0)
      expect(mask.contactMask[i]).toBe(255);
  }
});
it("clips and fades planar contact around obstacles, holes, reflections and the frame", async () => {
  const footprint = rectangle(4, 30, 40, 40);
  const args = {
    width: 100,
    height: 100,
    volume: footprint,
    footprint,
    planarContact: true,
    support: {
      boundary: rectangle(0, 0, 0.5, 1),
      holes: [rectangle(0.46, 0.4, 0.03, 0.1)],
      obstacles: [rectangle(0.2, 0.72, 0.05, 0.05)],
    },
    reflectiveRegions: [rectangle(0.2, 0.23, 0.04, 0.03)],
  };
  const result = await spatialInteractionMask(args);
  expect(result.contactMask[50 * 100]).toBe(255);
  expect(result.contactOpacity![50 * 100]).toBe(0);
  expect(result.contactMask[45 * 100 + 47]).toBe(0);
  expect(result.contactMask[74 * 100 + 22]).toBe(0);
  expect(result.contactMask[24 * 100 + 22]).toBe(0);
  for (let i = 0; i < 10000; i++) {
    if (result.contactOpacity![i]) {
      expect(result.contactMask[i]).toBe(255);
      expect(result.maskRaw[i * 4 + 3]).toBe(0);
      expect(
        isFreeSupport(
          { x: ((i % 100) + 0.5) / 100, y: (Math.floor(i / 100) + 0.5) / 100 },
          {
            ...args.support,
            kind: "floor",
            label: "floor",
            heightAboveSupportCm: { min: 100, estimate: 150, max: 180 },
            yawDegrees: 0,
            scaleEvidence: "test",
          },
        ),
      ).toBe(true);
    }
  }
});
it("preserves rectangle corners and separates object from contact on free support", async () => {
  const args = input();
  args.reflectiveRegions = [];
  const result = await spatialInteractionMask(args);
  expect(result.maskRaw[(20 * 100 + 25) * 4 + 3]).toBe(255);
  expect(result.objectMask[50 * 100 + 50]).toBe(255);
  expect(result.metadata.contactPixels).toBeGreaterThan(0);
  for (let i = 0; i < 10000; i++) {
    expect(Boolean(result.objectMask[i] && result.contactMask[i])).toBe(false);
    expect(result.maskRaw[i * 4 + 3] === 0).toBe(
      Boolean(result.objectMask[i] || result.contactMask[i]),
    );
    if (result.contactMask[i])
      expect(
        isFreeSupport(
          { x: ((i % 100) + 0.5) / 100, y: (Math.floor(i / 100) + 0.5) / 100 },
          {
            ...args.support,
            kind: "floor",
            label: "floor",
            heightAboveSupportCm: { min: 100, estimate: 150, max: 180 },
            yawDegrees: 0,
            scaleEvidence: "test",
          },
        ),
      ).toBe(true);
  }
});
it("protects reflective pixels from contact edits and refuses an overlapping object", async () => {
  const args = input();
  args.reflectiveRegions = [rectangle(0.6, 0.78, 0.1, 0.1)];
  const result = await spatialInteractionMask(args);
  expect(result.maskRaw[(82 * 100 + 65) * 4 + 3]).toBe(255);
  await expect(
    spatialInteractionMask({
      ...args,
      reflectiveRegions: [rectangle(0.45, 0.45, 0.1, 0.1)],
    }),
  ).rejects.toThrow(/réfléchissante/);
});
