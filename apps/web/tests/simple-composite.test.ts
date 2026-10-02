import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { readFile } from "node:fs/promises";

import {
  compositeObjectsOnScene,
  createSilhouetteMask,
  dilateBinary,
  MAX_CONTACT_DARKENING,
  MAX_RELIGHT_GAIN,
  MAX_SOURCE_SHADOW_DARKENING,
  softenBrightContour,
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

describe("local-edit aspect padding", () => {
  it("pads a near-matching local frame without resizing its room or mask and preserves the legacy tolerance", async () => {
    const width = 201, height = 300;
    const source = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      source.set([x % 256, y % 256, (x + y) % 256], offset);
    }
    const imageWebp = await sharp(source, { raw: { width, height, channels: 3 } })
      .webp({ lossless: true }).toBuffer();
    const maskRaw = Buffer.alloc(width * height * 4, 255);
    maskRaw[(240 * width + 100) * 4 + 3] = 0;
    const composition = { sceneWidth: width, sceneHeight: height, imageWebp,
      baseWebp: imageWebp, sceneWebp: imageWebp, maskRaw, overlays: [] };
    const legacy = await padCompositionForAspect(composition, "1024x1536");
    expect(legacy).toMatchObject({ padded: false, paddedWidth: 201, paddedHeight: 300, offsetX: 0, offsetY: 0 });
    expect(legacy.imageWebp).toBe(imageWebp);
    expect(await padCompositionForAspect(composition, "1024x1536", { exactAspect: false })).toEqual(legacy);

    const strict = await padCompositionForAspect(composition, "1024x1536", { exactAspect: true });
    expect(strict).toMatchObject({ padded: true, paddedWidth: 201, paddedHeight: 302, offsetX: 0, offsetY: 1 });
    expect(await sharp(strict.imageWebp).extract({ left: 0, top: 1, width, height }).removeAlpha().raw().toBuffer()).toEqual(source);
    expect(await sharp(strict.maskPng).extract({ left: 0, top: 1, width, height }).raw().toBuffer()).toEqual(maskRaw);
    const mask = await sharp(strict.maskPng).raw().toBuffer();
    expect(mask.subarray(0, width * 4)).toEqual(Buffer.alloc(width * 4, 255));
    expect(mask.subarray(301 * width * 4)).toEqual(Buffer.alloc(width * 4, 255));
    expect(await pixelAt(strict.imageWebp, 100, 0)).toEqual({ r: 118, g: 118, b: 118 });
    expect(await pixelAt(strict.imageWebp, 100, 301)).toEqual({ r: 118, g: 118, b: 118 });
  });
});

describe("contact-light insertion", () => {
  const rightLighting = {
    lightDirection: "right" as const,
    lightElevation: "high" as const,
    shadowSoftness: "soft" as const,
    colourTemperature: "neutral" as const,
    shadowDirection: "left" as const,
  };

  async function broadBaseScene(kind: "standing" | "wall" | "flat" = "standing", separatedFeet = false) {
    const width = 100, height = 120;
    const rgba = Buffer.alloc(width * height * 4);
    // A cylinder has a broad elliptical lower rim, unlike a sphere or point foot.
    for (let x = 2; x < 98; x++) {
      const lower = 109 + Math.floor(10 * Math.sqrt(1 - ((x - 49.5) / 48) ** 2));
      for (let y = 3; y <= lower; y++) {
        if (separatedFeet && y >= 96 && x >= 12 && x < 88) continue;
        rgba.set([35, 65, 110, 255], (y * width + x) * 4);
      }
    }
    const cutout = await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
    const scene = await solidImage(320, 280, { r: 220, g: 210, b: 200 });
    const composition = await compositeObjectsOnScene(scene, 320, 280, [{
      cutout, point: { x: 0.5, y: 0.75 }, kind,
      dimensions: { mode: "height_length", heightCm: height, lengthCm: width }, pixelsPerCm: 1,
    }], { lighting: rightLighting });
    const padded = await padCompositionForAspect(composition, "320x280");
    return { composition, padded };
  }

  it("anchors a broad curved rim above the bottom center while protecting texture, source pixels and mask", async () => {
    const { composition, padded } = await broadBaseScene();
    const before = await rgbRaw(composition.baseWebp);
    const after = await rgbRaw(await pasteBackOutsideMask(composition, padded, composition.baseWebp, { transferMode: "contact-light", relightStrength: 0 }));
    const placed = composition.overlays[0]!;
    const alpha = await sharp(placed.png).ensureAlpha().raw().toBuffer();
    let curvedContact = 0, protectedChanges = 0, attenuationViolations = 0;
    for (let y = 0; y < 280; y++) for (let x = 0; x < 320; x++) {
      const index = y * 320 + x;
      const ox = x - placed.left, oy = y - placed.top;
      const a = ox >= 0 && oy >= 0 && ox < placed.widthPx && oy < placed.heightPx ? alpha[(oy * placed.widthPx + ox) * 4 + 3]! : 0;
      if ((a === 255 || composition.maskRaw[index * 4 + 3] !== 0) &&
          !after.data.subarray(index * 3, index * 3 + 3).equals(before.data.subarray(index * 3, index * 3 + 3))) protectedChanges++;
      if (a === 0) {
        for (let c = 0; c < 3; c++) if (after.data[index * 3 + c]! < Math.floor(before.data[index * 3 + c]! * (1 - MAX_SOURCE_SHADOW_DARKENING))) attenuationViolations++;
        if (y < placed.baseY - 2 && after.data[index * 3]! < before.data[index * 3]! - 8) curvedContact++;
      }
    }
    expect(curvedContact).toBeGreaterThan(15);
    expect(protectedChanges).toBe(0);
    expect(attenuationViolations).toBe(0);
  });

  it("does not accumulate broad-base shadows when support windows overlap", async () => {
    const { composition, padded } = await broadBaseScene();
    const first = await pasteBackOutsideMask(composition, padded, composition.baseWebp, { transferMode: "contact-light", relightStrength: 0 });
    const overlapping = { ...composition, overlays: [...composition.overlays, { ...composition.overlays[0]!, objectIndex: 1 }] };
    const second = await pasteBackOutsideMask(overlapping, padded, composition.baseWebp, { transferMode: "contact-light", relightStrength: 0 });
    expect((await rgbRaw(second)).data).toEqual((await rgbRaw(first)).data);
  });

  it("does not infer a broad support from two separated feet", async () => {
    const { composition, padded } = await broadBaseScene("standing", true);
    const before = await rgbRaw(composition.baseWebp);
    const after = await rgbRaw(await pasteBackOutsideMask(composition, padded, composition.baseWebp, { transferMode: "contact-light", relightStrength: 0 }));
    const placed = composition.overlays[0]!;
    // The separated feet span the same wide body, but cannot justify the
    // raised, curved-rim support region used by a continuous resting base.
    for (let y = 0; y < placed.baseY - 2; y++) {
      const start = y * before.width * 3;
      expect(after.data.subarray(start, start + before.width * 3)).toEqual(before.data.subarray(start, start + before.width * 3));
    }
  });

  it.each(["wall", "flat"] as const)("does not treat a broad %s silhouette as a standing base", async kind => {
    const { composition, padded } = await broadBaseScene(kind);
    const result = await pasteBackOutsideMask(composition, padded, composition.baseWebp, { transferMode: "contact-light", relightStrength: 0 });
    expect((await rgbRaw(result)).data).toEqual((await rgbRaw(composition.baseWebp)).data);
  });

  it("uses scene direction after rejecting a displaced model without repainting details", async () => {
    const pixels = Buffer.alloc(80 * 80 * 4);
    for (let y = 0; y < 80; y++) for (let x = 0; x < 80; x++) {
      const i = (y * 80 + x) * 4;
      const detail = y % 2 === 0 ? 1 : 0.75;
      pixels.set([40 * detail, 80 * detail, 160 * detail, 255], i);
    }
    const cutout = await sharp(pixels, { raw: { width: 80, height: 80, channels: 4 } }).png().toBuffer();
    const scene = await solidImage(180, 160, { r: 200, g: 180, b: 160 });
    const composition = await compositeObjectsOnScene(scene, 180, 160, [{
      cutout, point: { x: 0.5, y: 0.75 },
      dimensions: { mode: "height_length", heightCm: 80, lengthCm: 80 }, pixelsPerCm: 1,
    }], { lighting: rightLighting });
    const padded = await padCompositionForAspect(composition, "180x160");
    const wrongModel = await solidImage(180, 160, { r: 200, g: 20, b: 20 });
    const render = async (light: typeof composition.lighting) => rgbRaw(await pasteBackOutsideMask(
      { ...composition, lighting: light }, padded, wrongModel, { transferMode: "contact-light" },
    ));
    const right = await render(rightLighting);
    const left = await render({ ...rightLighting, lightDirection: "left", shadowDirection: "right" });
    const neutral = await render({ ...rightLighting, lightDirection: "diffuse", shadowDirection: "none_visible" });
    const strict = await rgbRaw(await pasteBackOutsideMask(composition, padded, wrongModel, { transferMode: "contact-light", relightStrength: 0 }));
    const p = composition.overlays[0]!;
    for (let y = 0; y < 80; y++) for (let x = 0; x < 80; x++) {
      const i = ((p.top + y) * 180 + p.left + x) * 3;
      for (let c = 0; c < 3; c++) {
        const source = pixels[(y * 80 + x) * 4 + c]!;
        expect(Math.abs(right.data[i + c]! - source)).toBeLessThanOrEqual(source * MAX_RELIGHT_GAIN + 0.5);
        expect(neutral.data[i + c]).toBe(source);
        // Reversing the observed light reverses the correction, not the
        // printed stripe; rounding is the only asymmetry on unclipped RGB.
        expect(Math.abs(right.data[i + c]! + left.data[i + c]! - 2 * source)).toBeLessThanOrEqual(1);
      }
      expect(Math.abs(right.data[i]! * 4 - right.data[i + 2]!)).toBeLessThanOrEqual(2);
      if (x === 8) expect(right.data[i + 2]).toBeLessThan(strict.data[i + 2]! - 12);
      if (x === 71) expect(right.data[i + 2]).toBeGreaterThan(strict.data[i + 2]! + 12);
      if (y % 2 === 0 && y < 79) {
        const stripe = right.data[i + 180 * 3 + 2]!;
        expect(Math.abs(stripe / right.data[i + 2]! - 0.75)).toBeLessThan(0.012);
      }
    }
    for (let i = 0; i < 180 * 160; i++) {
      if (composition.maskRaw[i * 4 + 3] !== 0)
        expect(right.data.subarray(i * 3, i * 3 + 3)).toEqual(strict.data.subarray(i * 3, i * 3 + 3));
    }
  });

  it("caps the combined scene and accepted model light relative to source RGB", async () => {
    const scene = await solidImage(180, 160, { r: 200, g: 180, b: 160 });
    const composition = await compositeObjectsOnScene(scene, 180, 160, [{
      cutout: await solidImage(80, 80, { r: 40, g: 80, b: 160 }),
      point: { x: 0.5, y: 0.75 },
      dimensions: { mode: "height_length", heightCm: 80, lengthCm: 80 }, pixelsPerCm: 1,
    }], { lighting: rightLighting });
    const padded = await padCompositionForAspect(composition, "180x160");
    const p = composition.overlays[0]!;
    const output = await pasteBackOutsideMask(composition, padded,
      await solidImage(180, 160, { r: 50, g: 100, b: 200 }), { transferMode: "contact-light" });
    const pixel = await pixelAt(output, p.left + 70, p.top + 40);
    expect(pixel.b).toBe(179); // +12%, never two stacked +12% gains.
    expect(pixel.r / pixel.b).toBeCloseTo(0.25, 2);
  });

  it("cleans the real grenade flank without changing its black crown, core or RGB", async () => {
    // Public catalogue product, scaled73x80 from the frozen qualification
    // cutout. Its black crown occupies rows0..10; the ivory neck starts at11.
    const png = await readFile(
      new URL("./fixtures/catalogue/grenade-placed-alpha.png", import.meta.url),
    );
    const original = await sharp(png)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const refined = await sharp(await softenBrightContour(png))
      .ensureAlpha()
      .raw()
      .toBuffer();
    const { width, height } = original.info;
    expect([width, height]).toEqual([73, 80]);
    expect(refined.subarray(0, width * 11 * 4)).toEqual(
      original.data.subarray(0, width * 11 * 4),
    );
    let leftFlankChanges = 0,
      changed = 0;
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        expect(refined.subarray(i, i + 3)).toEqual(
          original.data.subarray(i, i + 3),
        );
        if (refined[i + 3] === original.data[i + 3]) continue;
        changed += 1;
        if (x < 15 && y >= 25 && y < 65) leftFlankChanges += 1;
        // Every changed pixel touches the alpha boundary: the printed pattern
        // and the ceramic's fully surrounded opaque core cannot be altered.
        let boundary = false;
        for (let dy = -1; dy <= 1; dy += 1)
          for (let dx = -1; dx <= 1; dx += 1) {
            const sx = x + dx,
              sy = y + dy;
            if (
              sx < 0 ||
              sy < 0 ||
              sx >= width ||
              sy >= height ||
              original.data[(sy * width + sx) * 4 + 3] !== 255
            )
              boundary = true;
          }
        expect(boundary).toBe(true);
      }
    expect(changed).toBeGreaterThan(100);
    expect(leftFlankChanges).toBeGreaterThan(20);
  });

  it("anchors the true foot and casts a source-shaped shadow away from lateral light", async () => {
    const scene = await solidImage(180, 160, { r: 200, g: 180, b: 160 });
    // A prepared cutout is tightly cropped to its actual bottom support.
    const cutout = await sharp(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="20" fill="#3040c0"/></svg>',
      ),
    )
      .png()
      .toBuffer();
    const composition = await compositeObjectsOnScene(
      scene,
      180,
      160,
      [
        {
          cutout,
          point: { x: 0.5, y: 0.65 },
          dimensions: { mode: "height_length", heightCm: 40, lengthCm: 40 },
          pixelsPerCm: 1,
        },
      ],
      { lighting: rightLighting },
    );
    const padded = await padCompositionForAspect(composition, "180x160");
    const base = await rgbRaw(composition.baseWebp);
    const result = await rgbRaw(
      await pasteBackOutsideMask(composition, padded, composition.baseWebp, {
        transferMode: "contact-light",
        relightStrength: 0,
      }),
    );
    const row = composition.overlays[0]!.baseY;
    expect(result.data[((row + 1) * 180 + 90) * 3]!).toBeLessThan(
      base.data[((row + 1) * 180 + 90) * 3]! - 25,
    );
    let leftShade = 0,
      rightShade = 0;
    for (let i = 0; i < 180 * 160; i += 1) {
      const x = i % 180,
        y = Math.floor(i / 180);
      if (composition.maskRaw[i * 4 + 3] !== 0 || y < row - 2)
        expect(result.data.subarray(i * 3, i * 3 + 3)).toEqual(
          base.data.subarray(i * 3, i * 3 + 3),
        );
      if (y >= row && y <= row + 8) {
        if (x < 82) leftShade += base.data[i * 3]! - result.data[i * 3]!;
        if (x > 98) rightShade += base.data[i * 3]! - result.data[i * 3]!;
        expect(result.data[i * 3]!).toBeGreaterThanOrEqual(
          Math.floor(base.data[i * 3]! * (1 - MAX_SOURCE_SHADOW_DARKENING)),
        );
      }
    }
    expect(leftShade).toBeGreaterThan(rightShade * 1.5);
    // The same geometry follows the opposite observed light, not a hardcoded
    // shadow on one side of the photograph.
    const opposite = {
      ...composition,
      lighting: {
        ...rightLighting,
        lightDirection: "left" as const,
        shadowDirection: "right" as const,
      },
    };
    opposite.maskRaw = await createSilhouetteMask(
      180,
      160,
      opposite.overlays,
      opposite.lighting,
    );
    const oppositeRgb = await rgbRaw(
      await pasteBackOutsideMask(opposite, padded, composition.baseWebp, {
        transferMode: "contact-light",
        relightStrength: 0,
      }),
    );
    let oppositeLeft = 0,
      oppositeRight = 0;
    for (let y = row; y <= row + 8; y += 1)
      for (let x = 40; x <= 140; x += 1) {
        const i = (y * 180 + x) * 3;
        if (x < 82) oppositeLeft += base.data[i]! - oppositeRgb.data[i]!;
        if (x > 98) oppositeRight += base.data[i]! - oppositeRgb.data[i]!;
      }
    expect(oppositeRight).toBeGreaterThan(oppositeLeft * 1.5);
  });

  it("keeps source RGB, core opacity and complete alpha for wires and handles", async () => {
    const cutout = await sharp(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="70"><rect x="10" y="25" width="20" height="45" fill="#2040b0"/><rect x="19" y="0" width="2" height="27" fill="#ffffff"/><circle cx="31" cy="37" r="7" stroke="#ffffff" stroke-width="2" fill="none"/><rect x="10" y="25" width="1" height="45" fill="#ffffff"/></svg>',
      ),
    )
      .png()
      .toBuffer();
    const scene = await solidImage(180, 160, { r: 190, g: 180, b: 170 });
    const composition = await compositeObjectsOnScene(
      scene,
      180,
      160,
      [
        {
          cutout,
          point: { x: 0.5, y: 0.65 },
          dimensions: { mode: "height_length", heightCm: 70, lengthCm: 40 },
          pixelsPerCm: 1,
        },
      ],
      { lighting: rightLighting },
    );
    const beforeTile = Buffer.from(composition.overlays[0]!.png);
    const padded = await padCompositionForAspect(composition, "180x160");
    const result = await rgbRaw(
      await pasteBackOutsideMask(composition, padded, composition.baseWebp, {
        transferMode: "contact-light",
        relightStrength: 0,
      }),
    );
    const base = await rgbRaw(composition.baseWebp);
    const placed = composition.overlays[0]!;
    const alpha = await sharp(placed.png)
      .extractChannel("alpha")
      .raw()
      .toBuffer({ resolveWithObject: true });
    const sourceRgba = await sharp(placed.png).ensureAlpha().raw().toBuffer();
    const refinedRgba = await sharp(await softenBrightContour(placed.png))
      .ensureAlpha()
      .raw()
      .toBuffer();
    let opaqueChecked = 0;
    for (let y = 0; y < alpha.info.height; y += 1)
      for (let x = 0; x < alpha.info.width; x += 1) {
        const ti = (y * alpha.info.width + x) * 4;
        expect(refinedRgba.subarray(ti, ti + 3)).toEqual(
          sourceRgba.subarray(ti, ti + 3),
        );
        // Disconnected handle rim and tall wire have no thick interior.
        if (y < 20 || x > 31)
          expect(refinedRgba[ti + 3]).toBe(sourceRgba[ti + 3]);
        if (
          alpha.data[y * alpha.info.width + x] !== 255 ||
          refinedRgba[ti + 3] !== 255
        )
          continue;
        const i = ((placed.top + y) * 180 + placed.left + x) * 3;
        expect(result.data.subarray(i, i + 3)).toEqual(
          base.data.subarray(i, i + 3),
        );
        opaqueChecked += 1;
      }
    expect(opaqueChecked).toBeGreaterThan(700);
    expect(placed.png).toEqual(beforeTile);
    // Wire and handle silhouette are never eroded to conceal a white halo.
    expect(
      await pixelAt(
        await sharp(result.data, {
          raw: { width: 180, height: 160, channels: 3 },
        })
          .png()
          .toBuffer(),
        placed.left + 19,
        placed.top + 3,
      ),
    ).toEqual({ r: 255, g: 255, b: 255 });
  });

  it("removes one bright boundary layer while preserving its RGB and opaque interior", async () => {
    const rgba = Buffer.alloc(24 * 24 * 4, 0);
    for (let y = 3; y < 21; y += 1)
      for (let x = 3; x < 21; x += 1) {
        const i = (y * 24 + x) * 4;
        rgba[i] = rgba[i + 1] = rgba[i + 2] = 235;
        rgba[i + 3] = 255;
      }
    // A dark right boundary must keep its full source alpha and colour.
    for (let y = 3; y < 21; y += 1)
      for (let c = 0; c < 3; c += 1) rgba[(y * 24 + 20) * 4 + c] = 30;
    const png = await sharp(rgba, {
      raw: { width: 24, height: 24, channels: 4 },
    })
      .png()
      .toBuffer();
    const clean = await sharp(await softenBrightContour(png))
      .ensureAlpha()
      .raw()
      .toBuffer();
    expect(clean[(12 * 24 + 3) * 4 + 3]).toBe(0);
    expect(clean[(12 * 24 + 4) * 4 + 3]).toBe(255);
    expect(clean[(12 * 24 + 20) * 4 + 3]).toBe(255);
    let changed = 0;
    for (let i = 0; i < 24 * 24; i += 1) {
      expect(clean.subarray(i * 4, i * 4 + 3)).toEqual(
        rgba.subarray(i * 4, i * 4 + 3),
      );
      if (clean[i * 4 + 3] !== rgba[i * 4 + 3]) changed += 1;
      if (
        i % 24 > 3 &&
        i % 24 < 20 &&
        Math.floor(i / 24) > 3 &&
        Math.floor(i / 24) < 20
      )
        expect(clean[i * 4 + 3]).toBe(rgba[i * 4 + 3]);
      expect(clean[i * 4 + 3]!).toBeLessThanOrEqual(rgba[i * 4 + 3]!);
    }
    expect(changed).toBeGreaterThan(30);
  });

  it.each([1, 2, 3, 6])("preserves the complete pixels of an isolated %ipx white stem", async (width) => {
    const source = Buffer.alloc(24 * 48 * 4);
    for (let y = 3; y < 45; y++) for (let x = 8; x < 8 + width; x++)
      source.set([245, 245, 245, 255], (y * 24 + x) * 4);
    const png = await sharp(source, { raw: { width: 24, height: 48, channels: 4 } }).png().toBuffer();
    const result = await sharp(await softenBrightContour(png)).ensureAlpha().raw().toBuffer();
    expect(result).toEqual(source);
  });

  it("keeps a round volume centred with at most one layer removed on each side", async () => {
    const png = await circleCutout(64, "#eeeeee");
    const original = await sharp(png).ensureAlpha().raw().toBuffer();
    const result = await sharp(await softenBrightContour(png)).ensureAlpha().raw().toBuffer();
    const bounds = (pixels: Buffer) => {
      let left = 64, right = -1, top = 64, bottom = -1;
      for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
        if (!pixels[(y * 64 + x) * 4 + 3]) continue;
        left = Math.min(left, x); right = Math.max(right, x);
        top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
      return { left, right, top, bottom };
    };
    const before = bounds(original), after = bounds(result);
    expect(after.left - before.left).toBeLessThanOrEqual(1);
    expect(before.right - after.right).toBeLessThanOrEqual(1);
    expect(after.top - before.top).toBeLessThanOrEqual(1);
    expect(before.bottom - after.bottom).toBeLessThanOrEqual(1);
    expect(after.left + after.right).toBe(before.left + before.right);
    expect(after.top + after.bottom).toBe(before.top + before.bottom);
    for (let i = 0; i < 64 * 64; i++) {
      expect(result.subarray(i * 4, i * 4 + 3)).toEqual(original.subarray(i * 4, i * 4 + 3));
      const x = i % 64, y = Math.floor(i / 64);
      if (Math.hypot(x - 31.5, y - 31.5) < 26)
        expect(result[i * 4 + 3]).toBe(255);
    }
  });

  it("does not invent a hidden room for an old checkpoint or a standing shadow for wall art", async () => {
    const scene = await solidImage(180, 160, { r: 200, g: 180, b: 160 });
    for (const kind of ["standing", "wall", "flat"] as const) {
      const composition = await compositeObjectsOnScene(
        scene,
        180,
        160,
        [
          {
            cutout: await circleCutout(40, "#3040c0"),
            point: { x: 0.5, y: 0.65 },
            kind,
            dimensions: { mode: "height_length", heightCm: 40, lengthCm: 40 },
            pixelsPerCm: 1,
          },
        ],
        { lighting: rightLighting },
      );
      const padded = await padCompositionForAspect(composition, "180x160");
      const compatible =
        kind === "standing"
          ? { ...composition, sceneWebp: undefined }
          : composition;
      const final = await pasteBackOutsideMask(
        compatible,
        padded,
        composition.baseWebp,
        { transferMode: "contact-light", relightStrength: 0 },
      );
      expect((await rgbRaw(final)).data).toEqual(
        (await rgbRaw(composition.baseWebp)).data,
      );
    }
  });

  it("discards a displaced model silhouette including its ring and preserves source alpha", async () => {
    const scene = await solidImage(180, 160, { r: 210, g: 190, b: 170 });
    // The antialiased boundary deliberately contains fractional alpha.
    const cutout = await circleCutout(40, "#202020");
    const composition = await compositeObjectsOnScene(scene, 180, 160, [
      {
        cutout,
        point: { x: 0.5, y: 0.65 },
        dimensions: { mode: "height_length", heightCm: 40, lengthCm: 40 },
        pixelsPerCm: 1,
      },
    ]);
    const placed = composition.overlays[0]!;
    const model = await sharp(scene)
      .composite([
        {
          input: placed.png,
          left: placed.left - 5,
          top: placed.top - 4,
        },
      ])
      .png()
      .toBuffer();
    const padded = await padCompositionForAspect(composition, "180x160");
    const legacy = await rgbRaw(
      await pasteBackOutsideMask(composition, padded, model, {
        relightStrength: 0,
      }),
    );
    const result = await rgbRaw(
      await pasteBackOutsideMask(composition, padded, model, {
        transferMode: "contact-light",
        relightStrength: 0,
      }),
    );
    const base = await rgbRaw(composition.baseWebp);
    const alpha = await sharp(placed.png)
      .extractChannel("alpha")
      .raw()
      .toBuffer();
    expect(alpha.some((value) => value > 0 && value < 255)).toBe(true);
    let legacyChanged = 0;
    for (let y = 0; y < placed.baseY - 2; y += 1) {
      for (let x = 0; x < 180; x += 1) {
        const offset = (y * 180 + x) * 3;
        if (
          !legacy.data
            .subarray(offset, offset + 3)
            .equals(base.data.subarray(offset, offset + 3))
        )
          legacyChanged += 1;
        // Includes the transparent bbox corners, alpha edge, full silhouette
        // ring and source product: none may inherit the displaced rendition.
        expect(result.data.subarray(offset, offset + 3)).toEqual(
          base.data.subarray(offset, offset + 3),
        );
      }
    }
    expect(legacyChanged).toBeGreaterThan(100);
  });

  it("transfers a bounded shadow without importing colour or replacing support texture", async () => {
    const scene = await sharp(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="160"><defs><pattern id="grain" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="4" fill="#c8b496"/><path d="M0 0h4M0 2h4" stroke="#a08c78"/></pattern></defs><rect width="180" height="160" fill="url(#grain)"/></svg>',
      ),
    )
      .png()
      .toBuffer();
    const composition = await compositeObjectsOnScene(scene, 180, 160, [
      {
        cutout: await circleCutout(40, "#3040c0"),
        point: { x: 0.5, y: 0.65 },
        dimensions: { mode: "height_length", heightCm: 40, lengthCm: 40 },
        pixelsPerCm: 1,
      },
    ]);
    const base = await rgbRaw(composition.baseWebp);
    const darkened = Buffer.from(
      base.data.map((value) => Math.round(value * 0.7)),
    );
    const model = await sharp(darkened, {
      raw: { width: 180, height: 160, channels: 3 },
    })
      .png()
      .toBuffer();
    const padded = await padCompositionForAspect(composition, "180x160");
    const result = await rgbRaw(
      await pasteBackOutsideMask(composition, padded, model, {
        transferMode: "contact-light",
        relightStrength: 0,
      }),
    );
    const placed = composition.overlays[0]!;
    const silhouette = await dilatedSilhouettes(
      180,
      160,
      composition.overlays,
      0,
    );
    let shaded = 0;
    for (let i = 0; i < 180 * 160; i += 1) {
      const before = base.data.subarray(i * 3, i * 3 + 3);
      const after = result.data.subarray(i * 3, i * 3 + 3);
      if (
        composition.maskRaw[i * 4 + 3] !== 0 ||
        silhouette[i] ||
        Math.floor(i / 180) < placed.baseY - 2
      ) {
        expect(after).toEqual(before);
      } else {
        if (after[0]! < before[0]! - 2) shaded += 1;
        for (let c = 0; c < 3; c += 1) {
          expect(after[c]!).toBeLessThanOrEqual(before[c]!);
          expect(after[c]!).toBeGreaterThanOrEqual(
            Math.floor(before[c]! * (1 - MAX_CONTACT_DARKENING)),
          );
        }
        expect(after[0]! / after[2]!).toBeCloseTo(before[0]! / before[2]!, 1);
      }
    }
    expect(shaded).toBeGreaterThan(60);

    // A green generated object inside the contact area must not become a
    // green patch, nor be interpreted as an achromatic support shadow.
    const coloured = await solidImage(180, 160, { r: 20, g: 190, b: 20 });
    const rejected = await rgbRaw(
      await pasteBackOutsideMask(composition, padded, coloured, {
        transferMode: "contact-light",
        relightStrength: 0,
      }),
    );
    expect(rejected.data).toEqual(base.data);
  });

  it.each(["wall", "flat"] as const)(
    "keeps a silhouette-shaped contact area for %s products",
    async (kind) => {
      const scene = await solidImage(180, 160, { r: 200, g: 180, b: 160 });
      const composition = await compositeObjectsOnScene(scene, 180, 160, [
        {
          cutout: await circleCutout(40, "#3040c0"),
          point: { x: 0.5, y: 0.65 },
          kind,
          dimensions: { mode: "height_length", heightCm: 40, lengthCm: 40 },
          pixelsPerCm: 1,
        },
      ]);
      const padded = await padCompositionForAspect(composition, "180x160");
      const model = await solidImage(180, 160, { r: 150, g: 135, b: 120 });
      const result = await rgbRaw(
        await pasteBackOutsideMask(composition, padded, model, {
          transferMode: "contact-light",
          relightStrength: 0,
        }),
      );
      const base = await rgbRaw(composition.baseWebp);
      const silhouette = await dilatedSilhouettes(
        180,
        160,
        composition.overlays,
        0,
      );
      let shadedAboveBase = 0;
      for (let i = 0; i < 180 * 160; i += 1) {
        if (silhouette[i] || composition.maskRaw[i * 4 + 3] !== 0)
          expect(result.data.subarray(i * 3, i * 3 + 3)).toEqual(
            base.data.subarray(i * 3, i * 3 + 3),
          );
        else if (
          Math.floor(i / 180) < composition.overlays[0]!.baseY - 2 &&
          result.data[i * 3]! < base.data[i * 3]! - 2
        )
          shadedAboveBase += 1;
      }
      expect(shadedAboveBase).toBeGreaterThan(30);
    },
  );

  it("keeps the nearer source intact when only a rear product accepts relighting", async () => {
    const scene = await solidImage(180, 160, { r: 200, g: 180, b: 160 });
    const composition = await compositeObjectsOnScene(scene, 180, 160, [
      {
        cutout: await circleCutout(60, "#2020c8"),
        point: { x: 0.5, y: 0.5 },
        dimensions: { mode: "height_length", heightCm: 60, lengthCm: 60 },
        pixelsPerCm: 1,
      },
      {
        cutout: await circleCutout(60, "#c82020"),
        point: { x: 0.5, y: 0.8 },
        dimensions: { mode: "height_length", heightCm: 60, lengthCm: 60 },
        pixelsPerCm: 1,
      },
    ]);
    const padded = await padCompositionForAspect(composition, "180x160");
    const model = await solidImage(180, 160, { r: 26, g: 26, b: 160 });
    const final = await pasteBackOutsideMask(composition, padded, model, {
      transferMode: "contact-light",
    });
    expect(await pixelAt(final, 90, 74)).toEqual(
      await pixelAt(composition.baseWebp, 90, 74),
    );
    expect((await pixelAt(final, 90, 50)).b).toBeLessThan(
      (await pixelAt(composition.baseWebp, 90, 50)).b - 10,
    );
  });

  it("leaves the existing masked RGB path available for obstacle removal", async () => {
    const source = await solidImage(90, 80, { r: 200, g: 180, b: 160 });
    const composition = {
      imageWebp: source,
      baseWebp: source,
      sceneWidth: 90,
      sceneHeight: 80,
      maskRaw: Buffer.alloc(90 * 80 * 4),
      overlays: [],
    };
    const padded = await padCompositionForAspect(composition, "90x80");
    const model = await solidImage(90, 80, { r: 20, g: 180, b: 30 });
    const legacy = await pasteBackOutsideMask(composition, padded, model);
    expect(
      await pasteBackOutsideMask(composition, padded, model, {
        transferMode: "masked-rgb",
      }),
    ).toEqual(legacy);
    expect(
      await pasteBackOutsideMask(composition, padded, model, {
        transferMode: "contact-light",
      }),
    ).toEqual(legacy);
    expect((await pixelAt(legacy, 45, 40)).g).toBeGreaterThan(150);
  });
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
