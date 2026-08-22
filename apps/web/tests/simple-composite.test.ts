import { describe, expect, it } from "vitest";
import sharp from "sharp";

import {
  compositeObjectsOnScene,
  computeTargetPixelSize,
  createMultiEditMask,
  padCompositionForAspect,
  pasteBackOutsideMask,
} from "../lib/server/simple-composite";

async function solidImage(
  width: number,
  height: number,
  rgb: { r: number; g: number; b: number },
  format: "png" | "webp" = "png",
): Promise<Buffer> {
  const base = sharp({
    create: { width, height, channels: 4, background: { ...rgb, alpha: 1 } },
  });
  return format === "png" ? base.png().toBuffer() : base.webp().toBuffer();
}

async function pixelAt(
  image: Buffer,
  x: number,
  y: number,
): Promise<{ r: number; g: number; b: number }> {
  const { data, info } = await sharp(image)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * 3;
  return {
    r: data[offset] ?? 0,
    g: data[offset + 1] ?? 0,
    b: data[offset + 2] ?? 0,
  };
}

describe("computeTargetPixelSize", () => {
  it("converts real centimetres through pixels-per-cm and keeps the cutout aspect", () => {
    const size = computeTargetPixelSize(
      { mode: "height_length", heightCm: 40, lengthCm: 20 },
      2,
      0.5,
      1000,
      800,
    );
    expect(size.heightPx).toBe(80);
    expect(size.widthPx).toBe(40);
    expect(size.scaleSource).toBe("vision");
  });

  it("falls back to the assumed room width without calibration", () => {
    const size = computeTargetPixelSize(
      { mode: "height_length", heightCm: 60, lengthCm: 30 },
      null,
      0.5,
      600,
      800,
    );
    // 600 px / 300 cm = 2 px per cm.
    expect(size.heightPx).toBe(120);
    expect(size.widthPx).toBe(60);
    expect(size.scaleSource).toBe("assumed_room_width");
  });

  it("clamps oversized objects while preserving aspect", () => {
    const size = computeTargetPixelSize(
      { mode: "height_length", heightCm: 400, lengthCm: 400 },
      10,
      1,
      1000,
      800,
    );
    expect(size.widthPx).toBeLessThanOrEqual(600);
    expect(size.heightPx).toBeLessThanOrEqual(680);
    expect(Math.abs(size.widthPx / size.heightPx - 1)).toBeLessThanOrEqual(
      0.05,
    );
  });
});

describe("createMultiEditMask", () => {
  it("opens transparent windows only around the boxes", () => {
    const mask = createMultiEditMask(100, 100, [
      { left: 40, top: 40, width: 20, height: 20 },
    ]);
    const alphaAt = (x: number, y: number) => mask[(y * 100 + x) * 4 + 3];
    expect(alphaAt(50, 50)).toBe(0);
    expect(alphaAt(30, 50)).toBe(0); // padding (16px) around the box
    expect(alphaAt(5, 5)).toBe(255);
    expect(alphaAt(95, 95)).toBe(255);
  });
});

describe("composite pipeline", () => {
  it("pastes the cutout at the tapped point, base-anchored, with a scene-sized mask", async () => {
    const scene = await solidImage(300, 200, { r: 200, g: 30, b: 30 }, "webp");
    const cutout = await solidImage(40, 80, { r: 30, g: 30, b: 220 });
    const composition = await compositeObjectsOnScene(scene, 300, 200, [
      {
        cutout,
        point: { x: 0.5, y: 0.5 },
        dimensions: { mode: "height_length", heightCm: 40, lengthCm: 20 },
        pixelsPerCm: 1,
      },
    ]);
    const placement = composition.placements[0]!;
    expect(placement.heightPx).toBe(40);
    expect(placement.widthPx).toBe(20);
    // Base centred on the point: left = 150 - 10, top = 100 - 40.
    expect(placement.left).toBe(140);
    expect(placement.top).toBe(60);
    // The cutout's pixels are on the composite.
    const inside = await pixelAt(composition.imageWebp, 150, 80);
    expect(inside.b).toBeGreaterThan(150);
    const outside = await pixelAt(composition.imageWebp, 10, 10);
    expect(outside.r).toBeGreaterThan(150);
    expect(composition.maskRaw.length).toBe(300 * 200 * 4);
  });

  it("letterboxes to the requested aspect and restores it on paste-back", async () => {
    const scene = await solidImage(300, 200, { r: 200, g: 30, b: 30 }, "webp");
    const cutout = await solidImage(40, 80, { r: 30, g: 30, b: 220 });
    const composition = await compositeObjectsOnScene(scene, 300, 200, [
      {
        cutout,
        point: { x: 0.5, y: 0.5 },
        dimensions: { mode: "height_length", heightCm: 40, lengthCm: 20 },
        pixelsPerCm: 1,
      },
    ]);
    const padded = await padCompositionForAspect(composition, "1024x1024");
    expect(padded.padded).toBe(true);
    expect(padded.paddedWidth).toBe(300);
    expect(padded.paddedHeight).toBe(300);
    expect(padded.offsetY).toBe(50);

    // Model output: uniform green at the padded aspect.
    const modelOutput = await solidImage(
      512,
      512,
      { r: 20, g: 200, b: 20 },
      "webp",
    );
    const final = await pasteBackOutsideMask(composition, padded, modelOutput);
    const metadata = await sharp(final).metadata();
    expect(metadata.width).toBe(300);
    expect(metadata.height).toBe(200);
    // Outside the mask the model's green must be discarded: composite red wins.
    const corner = await pixelAt(final, 5, 5);
    expect(corner.r).toBeGreaterThan(150);
    expect(corner.g).toBeLessThan(90);
    // Inside the mask the model output wins.
    const inside = await pixelAt(final, 150, 80);
    expect(inside.g).toBeGreaterThan(150);
  });

  it("keeps the exact scene size when the aspect already matches", async () => {
    const scene = await solidImage(300, 200, { r: 200, g: 30, b: 30 }, "webp");
    const cutout = await solidImage(40, 80, { r: 30, g: 30, b: 220 });
    const composition = await compositeObjectsOnScene(scene, 300, 200, [
      {
        cutout,
        point: { x: 0.3, y: 0.8 },
        dimensions: { mode: "height_length", heightCm: 40, lengthCm: 20 },
        pixelsPerCm: 1,
      },
    ]);
    const padded = await padCompositionForAspect(composition, "1536x1024");
    expect(padded.padded).toBe(false);
    expect(padded.offsetX).toBe(0);
    expect(padded.offsetY).toBe(0);
  });
});
