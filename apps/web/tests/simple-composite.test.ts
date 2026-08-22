import { describe, expect, it } from "vitest";
import sharp from "sharp";

import {
  compositeObjectsOnScene,
  computeTargetPixelSize,
  createSilhouetteMask,
  padCompositionForAspect,
  pasteBackOutsideMask,
} from "../lib/server/simple-composite";

async function circleCutout(size: number, fill: string): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 2}" fill="${fill}"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

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

describe("createSilhouetteMask", () => {
  it("hugs the object silhouette instead of its bounding box", async () => {
    const mask = await createSilhouetteMask(300, 200, [
      {
        png: await circleCutout(80, "#1e1edc"),
        left: 110,
        top: 60,
        widthPx: 80,
        heightPx: 80,
      },
    ]);
    const alphaAt = (x: number, y: number) => mask[(y * 300 + x) * 4 + 3];
    // Centre of the circle: editable.
    expect(alphaAt(150, 100)).toBe(0);
    // Contact-shadow band under the base: editable.
    expect(alphaAt(150, 140)).toBe(0);
    // Bounding-box corner, far outside the circle: preserved — this is what
    // keeps neighbouring shelf items out of the model's reach.
    expect(alphaAt(111, 61)).toBe(255);
    // Far away: preserved.
    expect(alphaAt(20, 20)).toBe(255);
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
    // The silhouette mask stays tight: 15 px left of the object is preserved.
    expect(composition.maskRaw[(80 * 300 + 125) * 4 + 3]).toBe(255);
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
    // At the object's core the identity re-stamp wins: catalog blue, not the
    // model's green rendition.
    const core = await pixelAt(final, 150, 80);
    expect(core.b).toBeGreaterThan(150);
    expect(core.g).toBeLessThan(90);
    // In the blend ring just below the base, the model's output remains.
    const ring = await pixelAt(final, 150, 103);
    expect(ring.g).toBeGreaterThan(ring.r);
  });

  it("never stamps outside a non-rectangular silhouette", async () => {
    // Regression: a circular cutout has transparent bbox corners whose RGB is
    // black once the alpha is removed; a stamp-channel bug once painted that
    // black over the scene. The corners must stay untouched scene pixels.
    const scene = await solidImage(300, 200, { r: 200, g: 30, b: 30 }, "webp");
    const cutout = await circleCutout(80, "#1e1edc");
    const composition = await compositeObjectsOnScene(scene, 300, 200, [
      {
        cutout,
        point: { x: 0.5, y: 0.6 },
        dimensions: { mode: "height_length", heightCm: 60, lengthCm: 60 },
        pixelsPerCm: 1,
      },
    ]);
    const padded = await padCompositionForAspect(composition, "1536x1024");
    const modelOutput = await sharp(padded.imageWebp).webp().toBuffer();
    const final = await pasteBackOutsideMask(composition, padded, modelOutput);
    const placement = composition.placements[0]!;
    // Bounding-box top corners, inside the box but far outside the circle.
    for (const [x, y] of [
      [placement.left + 2, placement.top + 2],
      [placement.left + placement.widthPx - 3, placement.top + 2],
    ] as const) {
      const pixel = await pixelAt(final, x, y);
      expect(pixel.r).toBeGreaterThan(150);
      expect(pixel.g).toBeLessThan(90);
      expect(pixel.b).toBeLessThan(90);
    }
    // The circle core is still the catalog cutout.
    const core = await pixelAt(
      final,
      placement.left + Math.floor(placement.widthPx / 2),
      placement.top + Math.floor(placement.heightPx / 2),
    );
    expect(core.b).toBeGreaterThan(150);
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
