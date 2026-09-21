import { describe, expect, it } from "vitest";
import sharp from "sharp";

import {
  compositeObjectsOnScene,
  createSilhouetteMask,
  dilateBinary,
  padCompositionForAspect,
  pasteBackOutsideMask,
  planSimplePlacements,
  SimpleCompositeError,
  type PlacedOverlay,
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

async function rgbRaw(
  image: Buffer,
): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(image)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Scene-sized binary map of the overlay silhouettes dilated by `radius`. */
async function dilatedSilhouettes(
  width: number,
  height: number,
  overlays: PlacedOverlay[],
  radius: number,
): Promise<Uint8Array> {
  // Stamp first, dilate once in scene space: dilating inside each overlay's
  // own tile would clip the ring at the bounding box and describe a mask the
  // implementation deliberately does not produce.
  const map = new Uint8Array(width * height);
  for (const overlay of overlays) {
    const { data, info } = await sharp(overlay.png)
      .ensureAlpha()
      .extractChannel("alpha")
      .raw()
      .toBuffer({ resolveWithObject: true });
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        const sx = overlay.left + x;
        const sy = overlay.top + y;
        if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
        if ((data[y * info.width + x] ?? 0) > 0) map[sy * width + sx] = 1;
      }
    }
  }
  return dilateBinary(map, width, height, radius);
}

const standingOverlay = async (
  png: Buffer,
  widthPx: number,
  heightPx: number,
  baseX: number,
  baseY: number,
  overrides: Partial<PlacedOverlay> = {},
): Promise<PlacedOverlay> => ({
  png,
  widthPx,
  heightPx,
  left: baseX - Math.round(widthPx / 2),
  top: baseY - heightPx,
  baseX,
  baseY,
  kind: "standing",
  depthKey: baseY,
  objectIndex: 0,
  ...overrides,
});

describe("planSimplePlacements", () => {
  it("keeps input order, anchors the base and flags box overlaps", () => {
    const placements = planSimplePlacements(300, 200, [
      {
        objectIndex: 0,
        point: { x: 0.5, y: 0.5 },
        dimensions: { mode: "height_length", heightCm: 40, lengthCm: 20 },
        pixelsPerCm: 1,
        cutout: { widthPx: 40, heightPx: 80 },
      },
      {
        objectIndex: 1,
        point: { x: 0.2, y: 0.9 },
        dimensions: { mode: "height_length", heightCm: 40, lengthCm: 20 },
        pixelsPerCm: 1,
        cutout: { widthPx: 40, heightPx: 80 },
      },
    ]);
    expect(placements.map((p) => p.objectIndex)).toEqual([0, 1]);
    const first = placements[0]!;
    expect(first.heightPx).toBe(40);
    expect(first.widthPx).toBe(20);
    expect(first.baseX).toBe(150);
    expect(first.baseY).toBe(100);
    expect(first.left).toBe(140);
    expect(first.top).toBe(60);
    expect(first.overlaps).toBe(false);
    expect(first.scaleSource).toBe("vision");
  });

  it("throws a 422 when two standing objects share the same spot", () => {
    const spec = (objectIndex: number, x: number) => ({
      objectIndex,
      point: { x, y: 0.8 },
      dimensions: {
        mode: "height_length" as const,
        heightCm: 60,
        lengthCm: 60,
      },
      pixelsPerCm: 1,
      cutout: { widthPx: 80, heightPx: 80 },
    });
    let error: unknown;
    try {
      planSimplePlacements(300, 200, [spec(0, 0.5), spec(1, 0.55)]);
    } catch (reason) {
      error = reason;
    }
    expect(error).toBeInstanceOf(SimpleCompositeError);
    expect((error as SimpleCompositeError).status).toBe(422);
    expect((error as SimpleCompositeError).message).toContain("objets 1 et 2");
  });

  it("throws a 422 when an object has no visible part", () => {
    expect(() =>
      planSimplePlacements(300, 200, [
        {
          objectIndex: 2,
          point: { x: 0.5, y: 0 },
          dimensions: { mode: "height_length", heightCm: 40, lengthCm: 20 },
          pixelsPerCm: 1,
          cutout: { widthPx: 40, heightPx: 80 },
        },
      ]),
    ).toThrow(/L’objet 3 ne tient pas dans le cadre/);
  });
});

describe("createSilhouetteMask", () => {
  it("scales the integration ring with scene resolution", async () => {
    const overlay = await standingOverlay(
      await solidImage(80, 80, { r: 20, g: 20, b: 150 }),
      80,
      80,
      500,
      600,
    );
    const mask = await createSilhouetteMask(1024, 1024, [overlay]);
    const alphaAt = (x: number, y: number) => mask[(y * 1024 + x) * 4 + 3];
    expect(alphaAt(455, 560)).toBe(0);
    expect(alphaAt(450, 560)).toBe(255);
  });

  it("opens a tight contact band around flat objects", async () => {
    const overlay: PlacedOverlay = {
      png: await solidImage(300, 300, { r: 20, g: 20, b: 150 }),
      widthPx: 300,
      heightPx: 300,
      left: 100,
      top: 100,
      baseX: 250,
      baseY: 250,
      kind: "flat",
      depthKey: 250,
      objectIndex: 0,
    };
    const mask = await createSilhouetteMask(500, 500, [overlay]);
    expect(mask[(250 * 500 + 94) * 4 + 3]).toBe(0);
    expect(mask[(250 * 500 + 85) * 4 + 3]).toBe(255);
  });

  it("hugs the object silhouette instead of its bounding box", async () => {
    const overlay = await standingOverlay(
      await circleCutout(80, "#1e1edc"),
      80,
      80,
      150,
      140,
    );
    const mask = await createSilhouetteMask(300, 200, [overlay]);
    const alphaAt = (x: number, y: number) => mask[(y * 300 + x) * 4 + 3];
    // Centre of the circle: editable.
    expect(alphaAt(150, 100)).toBe(0);
    // Contact-shadow band under the base: editable.
    expect(alphaAt(150, 145)).toBe(0);
    // Bounding-box corner, far outside the circle: preserved — this is what
    // keeps neighbouring shelf items out of the model's reach.
    expect(alphaAt(111, 61)).toBe(255);
    // Far away: preserved.
    expect(alphaAt(20, 20)).toBe(255);
  });

  it("never opens the window above the base and follows the light", async () => {
    const png = await solidImage(60, 100, { r: 30, g: 30, b: 220 });
    const overlay = await standingOverlay(png, 60, 100, 150, 150);
    const mask = await createSilhouetteMask(300, 200, [overlay], {
      lightDirection: "left",
      lightElevation: "low",
      shadowSoftness: "hard",
      colourTemperature: "neutral",
      shadowDirection: "right",
    });
    const ring = await dilatedSilhouettes(300, 200, [overlay], 3);
    for (let y = 0; y < overlay.baseY - 2; y += 1) {
      for (let x = 0; x < 300; x += 1) {
        if (ring[y * 300 + x] === 1) continue;
        expect(mask[(y * 300 + x) * 4 + 3]).toBe(255);
      }
    }
    const alphaAt = (x: number, y: number) => mask[(y * 300 + x) * 4 + 3];
    // Light from the left: the shadow side (right) is editable...
    expect(alphaAt(Math.round(150 + 0.6 * 60), 155)).toBe(0);
    // ...the lit side beyond the symmetric window is preserved.
    expect(alphaAt(Math.round(150 - 0.6 * 60), 155)).toBe(255);
  });

  it("gives wall objects a bounded directional cast-shadow window", async () => {
    const png = await solidImage(60, 40, { r: 30, g: 30, b: 220 });
    const overlay: PlacedOverlay = {
      png,
      widthPx: 60,
      heightPx: 40,
      left: 120,
      top: 60,
      baseX: 150,
      baseY: 80,
      kind: "wall",
      depthKey: 60,
      objectIndex: 0,
    };
    const mask = await createSilhouetteMask(300, 200, [overlay], {
      lightDirection: "left",
      lightElevation: "low",
      shadowSoftness: "hard",
      colourTemperature: "neutral",
      shadowDirection: "right",
    });
    for (let y = overlay.top + overlay.heightPx + 6; y < 200; y += 1) {
      for (let x = 0; x < 300; x += 1) {
        expect(mask[(y * 300 + x) * 4 + 3]).toBe(255);
      }
    }
    // The ring itself is editable.
    expect(
      mask[((overlay.top + overlay.heightPx + 1) * 300 + 150) * 4 + 3],
    ).toBe(0);
    expect(mask[(80 * 300 + 184) * 4 + 3]).toBe(0);
    expect(mask[(80 * 300 + 115) * 4 + 3]).toBe(255);
  });
});

describe("composite pipeline", () => {
  it("preserves a calibrated thin object even when erosion has no core", async () => {
    const scene = await solidImage(300, 200, { r: 190, g: 190, b: 190 });
    const composition = await compositeObjectsOnScene(scene, 300, 200, [
      {
        cutout: await solidImage(2, 40, { r: 20, g: 20, b: 220 }),
        point: { x: 0.5, y: 0.75 },
        dimensions: { mode: "height_length", heightCm: 40, lengthCm: 2 },
        pixelsPerCm: 1,
      },
    ]);
    expect(composition.placements[0]?.widthPx).toBe(2);
    const padded = await padCompositionForAspect(composition, "1536x1024");
    const result = await pasteBackOutsideMask(
      composition,
      padded,
      await solidImage(300, 200, { r: 180, g: 20, b: 20 }),
    );
    const pixel = await pixelAt(result, 150, 130);
    expect(pixel.b).toBeGreaterThan(pixel.r + 60);
  });

  it("transfers bounded broad lighting while preserving source detail and hue", async () => {
    const cutout = await sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="100"><rect width="80" height="100" fill="#5050c8"/><rect x="35" y="25" width="10" height="50" fill="#6464fa"/></svg>`,
      ),
    )
      .png()
      .toBuffer();
    const scene = await solidImage(300, 200, { r: 190, g: 190, b: 190 });
    const composition = await compositeObjectsOnScene(scene, 300, 200, [
      {
        cutout,
        point: { x: 0.5, y: 0.75 },
        dimensions: { mode: "height_length", heightCm: 100, lengthCm: 80 },
        pixelsPerCm: 1,
      },
    ]);
    const padded = await padCompositionForAspect(composition, "1536x1024");
    // Uniform darkened product: the generated image has LOST the bright stripe.
    const model = await solidImage(300, 200, { r: 64, g: 64, b: 160 });
    const result = await pasteBackOutsideMask(composition, padded, model);
    const strict = await pasteBackOutsideMask(composition, padded, model, {
      relightStrength: 0,
    });
    const field = await pixelAt(result, 130, 90);
    const detail = await pixelAt(result, 150, 90);
    const original = await pixelAt(strict, 130, 90);
    expect(field.b).toBeLessThan(original.b - 10);
    expect(field.b).toBeGreaterThanOrEqual(original.b * 0.86);
    expect(detail.b).toBeGreaterThan(field.b + 25);
    expect(field.r / field.b).toBeCloseTo(0.4, 1);
    const scenePixel = await pixelAt(result, 20, 20);
    expect(scenePixel.r).toBeGreaterThan(180);
  });

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
    expect(placement.baseX).toBe(150);
    expect(placement.baseY).toBe(100);
    // The cutout's pixels are on both composites.
    const inside = await pixelAt(composition.imageWebp, 150, 80);
    expect(inside.b).toBeGreaterThan(150);
    const insideBase = await pixelAt(composition.baseWebp, 150, 80);
    expect(insideBase.b).toBeGreaterThan(150);
    const outside = await pixelAt(composition.imageWebp, 10, 10);
    expect(outside.r).toBeGreaterThan(150);
    expect(composition.maskRaw.length).toBe(300 * 200 * 4);
    // The silhouette mask stays tight: 15 px left of the object is preserved.
    expect(composition.maskRaw[(80 * 300 + 125) * 4 + 3]).toBe(255);
    expect(composition.overlays).toHaveLength(1);
    expect(composition.lighting).toBeNull();
  });

  it("keeps every shadow placeholder pixel inside the editable window", async () => {
    const scene = await solidImage(300, 200, { r: 200, g: 30, b: 30 }, "webp");
    const cutout = await solidImage(40, 80, { r: 30, g: 30, b: 220 });
    const composition = await compositeObjectsOnScene(
      scene,
      300,
      200,
      [
        {
          cutout,
          point: { x: 0.5, y: 0.6 },
          dimensions: { mode: "height_length", heightCm: 60, lengthCm: 30 },
          pixelsPerCm: 1,
        },
      ],
      {
        lighting: {
          lightDirection: "left",
          lightElevation: "low",
          shadowSoftness: "soft",
          colourTemperature: "warm",
          shadowDirection: "right",
        },
      },
    );
    const model = await rgbRaw(composition.imageWebp);
    const base = await rgbRaw(composition.baseWebp);
    let placeholderPixels = 0;
    for (let i = 0; i < 300 * 200; i += 1) {
      const differs =
        Math.abs((model.data[i * 3] ?? 0) - (base.data[i * 3] ?? 0)) > 8 ||
        Math.abs((model.data[i * 3 + 1] ?? 0) - (base.data[i * 3 + 1] ?? 0)) >
          8 ||
        Math.abs((model.data[i * 3 + 2] ?? 0) - (base.data[i * 3 + 2] ?? 0)) >
          8;
      if (!differs) continue;
      placeholderPixels += 1;
      expect(composition.maskRaw[i * 4 + 3]).toBe(0);
    }
    // The placeholder actually exists.
    expect(placeholderPixels).toBeGreaterThan(20);
  });

  it("crops a tall object at the frame without relocating its base", async () => {
    const scene = await solidImage(300, 200, { r: 200, g: 30, b: 30 }, "webp");
    const cutout = await solidImage(40, 100, { r: 30, g: 30, b: 220 });
    const composition = await compositeObjectsOnScene(scene, 300, 200, [
      {
        cutout,
        point: { x: 0.5, y: 0.2 },
        dimensions: { mode: "height_length", heightCm: 100, lengthCm: 40 },
        pixelsPerCm: 1,
      },
    ]);
    const placement = composition.placements[0]!;
    expect(placement.top).toBeLessThan(0);
    expect(placement.baseY).toBe(Math.round(0.2 * 200));
    expect(placement.croppedByFrame).toBeGreaterThan(0);
    expect(placement.croppedByFrame).toBeLessThanOrEqual(0.85);
    const justAboveBase = await pixelAt(composition.baseWebp, 150, 38);
    expect(justAboveBase.b).toBeGreaterThan(150);
    const aboveFrame = await pixelAt(composition.baseWebp, 150, 2);
    expect(aboveFrame.b).toBeGreaterThan(150);
  });

  it("stamps the nearer object over the farther one whatever the input order", async () => {
    const scene = await solidImage(300, 200, { r: 200, g: 30, b: 30 }, "webp");
    const near = await circleCutout(80, "#1e1edc");
    const far = await circleCutout(80, "#1edc1e");
    const composition = await compositeObjectsOnScene(scene, 300, 200, [
      {
        cutout: near,
        point: { x: 0.5, y: 0.8 },
        dimensions: { mode: "height_length", heightCm: 60, lengthCm: 60 },
        pixelsPerCm: 1,
      },
      {
        cutout: far,
        point: { x: 0.5, y: 0.6 },
        dimensions: { mode: "height_length", heightCm: 60, lengthCm: 60 },
        pixelsPerCm: 1,
      },
    ]);
    expect(composition.placements.map((p) => p.objectIndex)).toEqual([0, 1]);
    expect(composition.placements[0]!.overlaps).toBe(true);
    expect(composition.overlays.map((o) => o.objectIndex)).toEqual([1, 0]);
    const last = composition.overlays[composition.overlays.length - 1]!;
    expect(last.depthKey).toBe(
      Math.max(...composition.overlays.map((o) => o.depthKey)),
    );
    const padded = await padCompositionForAspect(composition, "1536x1024");
    const modelOutput = await solidImage(
      1536,
      1024,
      { r: 128, g: 128, b: 128 },
      "webp",
    );
    const final = await pasteBackOutsideMask(composition, padded, modelOutput);
    // (150, 110) is inside both discs: near centre (150,130), far (150,90).
    const overlap = await pixelAt(final, 150, 110);
    expect(overlap.b).toBeGreaterThan(150);
    expect(overlap.g).toBeLessThan(90);
    // Far disc's own core is still green.
    const farCore = await pixelAt(final, 150, 75);
    expect(farCore.g).toBeGreaterThan(150);
    expect(farCore.b).toBeLessThan(90);
  });

  it("composites an object larger than the whole photograph", async () => {
    // sharp refuses a composite tile bigger than its base, and negative
    // offsets do not exempt it. A calibrated object may legitimately reach
    // 1.5x the frame, so the tile must be cropped before it ever reaches
    // composite() — otherwise the render dies after the paid calls.
    const scene = await solidImage(300, 200, { r: 200, g: 30, b: 30 }, "webp");
    const cutout = await solidImage(100, 100, { r: 30, g: 30, b: 220 });
    const composition = await compositeObjectsOnScene(scene, 300, 200, [
      {
        cutout,
        point: { x: 0.5, y: 0.9 },
        // 90 cm at 4 px/cm = 360 px: wider and taller than the 300x200 scene.
        dimensions: { mode: "height_length", heightCm: 90, lengthCm: 90 },
        pixelsPerCm: 4,
      },
    ]);
    const placement = composition.placements[0]!;
    // Capped at 1.5x the frame's short side, so still taller than the scene.
    expect(placement.heightPx).toBe(300);
    expect(placement.top).toBeLessThan(0);
    expect(placement.croppedByFrame).toBeGreaterThan(0);
    // The overlay was clipped to the frame, while the shadow geometry keeps
    // the object's full footprint.
    const overlay = composition.overlays[0]!;
    expect(overlay.left).toBeGreaterThanOrEqual(0);
    expect(overlay.top).toBeGreaterThanOrEqual(0);
    expect(overlay.heightPx).toBe(300);
    const tile = await sharp(overlay.png).metadata();
    expect(tile.width).toBeLessThanOrEqual(300);
    expect(tile.height).toBeLessThanOrEqual(200);
    // The object really is on the composite, and its base is still the tap.
    expect(placement.baseY).toBe(180);
    const inside = await pixelAt(composition.baseWebp, 150, 150);
    expect(inside.b).toBeGreaterThan(150);
    const padded = await padCompositionForAspect(composition, "1536x1024");
    const final = await pasteBackOutsideMask(
      composition,
      padded,
      await sharp(padded.imageWebp).webp().toBuffer(),
    );
    expect((await sharp(final).metadata()).width).toBe(300);
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

  it("pastes back from the placeholder-free base, not the model input", async () => {
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
    // Simulate an opaque placeholder region on the model input: the whole
    // model input is painted green. Nothing of it may reach the output.
    const tampered = {
      ...composition,
      imageWebp: await solidImage(300, 200, { r: 20, g: 200, b: 20 }, "webp"),
    };
    const padded = await padCompositionForAspect(tampered, "1536x1024");
    const modelOutput = await solidImage(
      1536,
      1024,
      { r: 20, g: 200, b: 20 },
      "webp",
    );
    const final = await pasteBackOutsideMask(tampered, padded, modelOutput);
    // Under the base but outside the mask: the original scene.
    const underBase = await pixelAt(final, 150, 150);
    expect(composition.maskRaw[(150 * 300 + 150) * 4 + 3]).toBe(255);
    expect(underBase.r).toBeGreaterThan(150);
    expect(underBase.g).toBeLessThan(90);
    const corner = await pixelAt(final, 5, 5);
    expect(corner.r).toBeGreaterThan(150);
    expect(corner.g).toBeLessThan(90);
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

  it("rejects colliding standing objects before compositing", async () => {
    const scene = await solidImage(300, 200, { r: 200, g: 30, b: 30 }, "webp");
    const cutout = await circleCutout(80, "#1e1edc");
    await expect(
      compositeObjectsOnScene(scene, 300, 200, [
        {
          cutout,
          point: { x: 0.5, y: 0.8 },
          dimensions: { mode: "height_length", heightCm: 60, lengthCm: 60 },
          pixelsPerCm: 1,
        },
        {
          cutout,
          point: { x: 0.55, y: 0.81 },
          dimensions: { mode: "height_length", heightCm: 60, lengthCm: 60 },
          pixelsPerCm: 1,
        },
      ]),
    ).rejects.toMatchObject({ status: 422 });
  });
});
