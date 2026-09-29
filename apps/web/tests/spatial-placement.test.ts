import { describe, it, expect, vi } from "vitest";
import sharp from "sharp";
vi.mock("server-only", () => ({}));
import {
  prepareSpatialEdit,
  spatialRenderPrompt,
  type SpatialSceneEstimate,
  validSupportPoint,
} from "../lib/server/ai/spatial-placement";
const estimate: SpatialSceneEstimate = {
  camera: {
    focalLengthInImageWidths: 1,
    heightAboveSupportCm: 150,
    pitchDownDegrees: 30,
  },
  yawDegrees: 0,
  support: "floor",
  cameraEvidence: "estimated camera",
  scaleReference: "estimated radiator height",
  visibleFaces: "front, side and seat top",
  lighting: "left window",
  occlusions: "none",
  hiddenGeometryAssumptions: "rear joints inferred",
  confidence: 0.8,
};
describe("experimental spatial insertion", () => {
  it("rejects sink holes, occupied points and the wrong support plane", () => {
    const boundary = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    const hole = [
      { x: 0.4, y: 0.4 },
      { x: 0.6, y: 0.4 },
      { x: 0.6, y: 0.6 },
      { x: 0.4, y: 0.6 },
    ];
    const support = {
      kind: "table" as const,
      pointOnVisibleSupport: true,
      occupied: false,
      boundary,
      holes: [hole],
      evidence: "sink",
    };
    expect(validSupportPoint({ x: 0.5, y: 0.5 }, support, "table")).toBe(false);
    expect(validSupportPoint({ x: 0.2, y: 0.2 }, support, "table")).toBe(true);
    expect(validSupportPoint({ x: 0.2, y: 0.2 }, support, "floor")).toBe(false);
    expect(
      validSupportPoint(
        { x: 0.2, y: 0.2 },
        { ...support, occupied: true },
        "table",
      ),
    ).toBe(false);
  });
  it.each([false, true])(
    "keeps guide and edit mask registered to the padded canvas (volume mask: %s)",
    async (volumeMask) => {
      const room = await sharp({
        create: { width: 736, height: 552, channels: 3, background: "#123456" },
      })
        .png()
        .toBuffer();
      const prepared = await prepareSpatialEdit(
        room,
        { x: 0.5, y: 0.8 },
        { widthCm: 42, heightCm: 80, depthCm: 45 },
        estimate,
        volumeMask
          ? {
              support: {
                boundary: [
                  { x: 0, y: 0 },
                  { x: 1, y: 0 },
                  { x: 1, y: 1 },
                  { x: 0, y: 1 },
                ],
                holes: [],
                obstacles: [],
              },
              reflectiveRegions: [],
            }
          : undefined,
      );
      const guide = await sharp(prepared.guideForModel).metadata();
      expect(guide.width).toBe(prepared.padded.paddedWidth);
      expect(guide.height).toBe(prepared.padded.paddedHeight);
      expect(prepared.padded.offsetX).toBeGreaterThan(0);
      const border = await sharp(prepared.guideForModel)
        .extract({ left: 0, top: 0, width: 1, height: 1 })
        .removeAlpha()
        .raw()
        .toBuffer();
      expect([...border]).toEqual([118, 118, 118]);
      const mask = await sharp(prepared.padded.maskPng)
        .ensureAlpha()
        .raw()
        .toBuffer();
      const { offsetX, offsetY, paddedWidth } = prepared.padded;
      for (let y = 0; y < 552; y++)
        for (let x = 0; x < 736; x++) {
          if (
            mask[((y + offsetY) * paddedWidth + x + offsetX) * 4 + 3] !==
            prepared.composition.maskRaw[(y * 736 + x) * 4 + 3]
          )
            throw new Error("Mask alignment changed");
        }
    },
  );
  it("keeps generated object pixels instead of restoring its old 2D view, while preserving distant room pixels", async () => {
    const room = await sharp({
      create: {
        width: 600,
        height: 400,
        channels: 3,
        background: { r: 10, g: 20, b: 30 },
      },
    })
      .png()
      .toBuffer();
    const prepared = await prepareSpatialEdit(
      room,
      { x: 0.5, y: 0.8 },
      { widthCm: 42, heightCm: 80, depthCm: 45 },
      estimate,
    );
    expect(prepared.composition.overlays).toEqual([]);
    const generated = await sharp({
      create: {
        width: prepared.padded.paddedWidth,
        height: prepared.padded.paddedHeight,
        channels: 3,
        background: { r: 0, g: 255, b: 0 },
      },
    })
      .png()
      .toBuffer();
    const output = await sharp(await prepared.finish(generated))
      .removeAlpha()
      .raw()
      .toBuffer();
    expect([...output.subarray(0, 3)]).toEqual([10, 20, 30]);
    const b = prepared.projection.bounds,
      x = Math.round((b.left + b.right) / 2),
      y = Math.round((b.top + b.bottom) / 2),
      offset = (y * 600 + x) * 3;
    expect([...output.subarray(offset, offset + 3)]).toEqual([0, 255, 0]);
    const prompt = spatialRenderPrompt(
      "chair",
      { widthCm: 42, heightCm: 80, depthCm: 45 },
      estimate,
      prepared.projection,
    );
    expect(prompt).toContain("MUST change the apparent viewpoint");
    expect(prompt).not.toContain("never move, resize, rotate");
  });
});
