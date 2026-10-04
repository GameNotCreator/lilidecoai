import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { padCompositionForAspect, type SimpleComposition } from "../lib/server/simple-composite";
import type { StorefrontPerspectiveGuideObject } from "../lib/server/storefront-perspective-guide";
import { buildStorefrontPerspectiveGuide } from "../lib/server/storefront-perspective-guide";
import {
  roomIntegrationEditComposition,
  restoreRoomIntegrationBackground,
  STOREFRONT_ROOM_INTEGRATION_COMPOSITE_VERSION,
  STOREFRONT_LOCAL_ROOM_INTEGRATION_COMPOSITE_VERSION,
  localiseRoomIntegration,
  restoreLocalRoomIntegrationBackground,
  roomRefinementEditComposition,
  prepareRoomRefinementBase,
  prepareNativeRoomRefinementFrame,
  buildNativeRoomRefinementGuide,
  STOREFRONT_ROOM_REFINEMENT_COMPOSITE_VERSION,
  STOREFRONT_NATIVE_ROOM_REFINEMENT_FRAME_VERSION,
  STOREFRONT_NATIVE_ROOM_REFINEMENT_GUIDE_VERSION,
} from "../lib/server/storefront-room-integration";

const object = (index = 0, x = 0.5, y = 0.8): StorefrontPerspectiveGuideObject => ({
  index, point: { x, y }, kind: "standing", dimensionsCm: { width: 10, height: 20, depth: 10 },
  pixelsPerCm: 2, widthPixelsPerCm: 3,
  pose: { cameraElevationDegrees: 30, cameraRollDegrees: 0 },
});

describe("storefront local-room integration", () => {
  async function localFixture(objects: StorefrontPerspectiveGuideObject[] = [{ ...object(0, 0.2, 0.8), pixelsPerCm: 2.5 }]) {
    const width = 400, height = 300;
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      pixels[offset] = (x * 7 + y * 3) % 256; pixels[offset + 1] = x % 256; pixels[offset + 2] = y % 256;
    }
    const room = await sharp(pixels, { raw: { width, height, channels: 3 } }).webp({ lossless: true }).toBuffer();
    const original = { ...await fixture(), sceneWebp: room, sceneWidth: width, sceneHeight: height,
      maskRaw: Buffer.alloc(width * height * 4, 255) };
    const composition = roomIntegrationEditComposition(original, objects);
    const guide = await buildStorefrontPerspectiveGuide({ room, width, height, objects });
    return { composition, objects, guide };
  }

  it("crops the room, guide and editable mask at the same original pixels with contextual room around the complete volume", async () => {
    const { composition, objects, guide } = await localFixture();
    const beforeRoom = Buffer.from(composition.sceneWebp!);
    const beforeMask = Buffer.from(composition.maskRaw);
    const local = await localiseRoomIntegration(composition, objects, guide);
    expect(STOREFRONT_LOCAL_ROOM_INTEGRATION_COMPOSITE_VERSION).toBe("storefront-room-local-integration-v6");
    expect(local.originalFrame).toEqual({ width: 400, height: 300 });
    expect(local.window).toEqual({ left: 29, top: 139, width: 102, height: 137 });
    expect(local.composition.sceneWidth).toBe(102);
    expect(local.composition.sceneHeight).toBe(137);
    expect(local.composition.imageWebp).toBe(local.composition.sceneWebp);
    expect(local.composition.baseWebp).toBe(local.composition.sceneWebp);
    const expectedRoom = await sharp(composition.sceneWebp!).extract(local.window).removeAlpha().raw().toBuffer();
    const expectedGuide = await sharp(guide).extract(local.window).removeAlpha().raw().toBuffer();
    expect(await sharp(local.composition.sceneWebp!).removeAlpha().raw().toBuffer()).toEqual(expectedRoom);
    expect(await sharp(local.guide).removeAlpha().raw().toBuffer()).toEqual(expectedGuide);
    const expectedMask = await sharp(composition.maskRaw, { raw: { width: 400, height: 300, channels: 4 } }).extract(local.window).raw().toBuffer();
    expect(local.composition.maskRaw).toEqual(expectedMask);
    expect(alpha(local.composition, 80 - local.window.left, 240 - local.window.top)).toBe(0);
    expect(alpha(local.composition, 0, 0)).toBe(255);
    expect(composition.sceneWebp).toEqual(beforeRoom);
    expect(composition.maskRaw).toEqual(beforeMask);
  });

  it("includes every repeated-product placement in a three-object window, including contact shading and scene edges", async () => {
    const { composition, objects, guide } = await localFixture([
      { ...object(0, 0.1, 0.85), kind: "flat" },
      { ...object(1, 0.5, 0.5), kind: "wall" },
      object(2, 0.95, 0.98),
    ]);
    const local = await localiseRoomIntegration(composition, objects, guide);
    expect(local.window.left).toBe(0);
    expect(local.window.top).toBeGreaterThan(0);
    expect(local.window.width).toBe(400);
    expect(local.window.top + local.window.height).toBe(300);
    for (let y = 0; y < 300; y++) for (let x = 0; x < 400; x++) {
      if (alpha(composition, x, y) !== 0) continue;
      expect(x).toBeGreaterThanOrEqual(local.window.left);
      expect(x).toBeLessThan(local.window.left + local.window.width);
      expect(y).toBeGreaterThanOrEqual(local.window.top);
      expect(y).toBeLessThan(local.window.top + local.window.height);
      expect(alpha(local.composition, x - local.window.left, y - local.window.top)).toBe(0);
    }
  });

  it("translates placement metadata and anchors without changing shape, depth order or measurement scale", async () => {
    const { composition, objects, guide } = await localFixture();
    composition.placements = [{ objectIndex: 0, kind: "standing", left: 65, top: 190, widthPx: 30, heightPx: 50,
      baseX: 80, baseY: 240, visible: { left: 65, top: 190, width: 30, height: 50 }, croppedByFrame: 0,
      sizeFactor: 1, clamped: false, scaleSource: "vision", pixelsPerCm: 2.5, impliedWidthCm: 10,
      impliedHeightCm: 20, dimensionConsistency: null, depthKey: 0.8, overlaps: false }];
    const local = await localiseRoomIntegration(composition, objects, guide);
    expect(local.composition.placements[0]).toMatchObject({ left: 36, top: 51, baseX: 51, baseY: 101,
      widthPx: 30, heightPx: 50, pixelsPerCm: 2.5, depthKey: 0.8,
      visible: { left: 36, top: 51, width: 30, height: 50 } });
    expect(composition.placements[0]).toMatchObject({ left: 65, top: 190, baseX: 80, baseY: 240 });
  });

  it("keeps a complete full-frame window when edit regions already fill the photograph", async () => {
    const { composition, objects, guide } = await localFixture();
    composition.maskRaw = Buffer.alloc(400 * 300 * 4, 255);
    for (let pixel = 0; pixel < 400 * 300; pixel++) composition.maskRaw[pixel * 4 + 3] = 0;
    const local = await localiseRoomIntegration(composition, objects, guide);
    expect(local.window).toEqual({ left: 0, top: 0, width: 400, height: 300 });
    expect(await sharp(local.composition.sceneWebp!).raw().toBuffer()).toEqual(await sharp(composition.sceneWebp!).raw().toBuffer());
  });

  it("clamps normalized edge contacts to visible pixels and retains every edit and contact patch", async () => {
    const { composition, objects, guide } = await localFixture([
      object(0, 0, 1), object(1, 1, 1), { ...object(2, 0.5, 0), kind: "wall" },
    ]);
    const local = await localiseRoomIntegration(composition, objects, guide);
    expect(local.window).toEqual({ left: 0, top: 0, width: 400, height: 300 });
    const pixels = await sharp(local.guide).removeAlpha().raw().toBuffer();
    for (const [x, y] of [[0, 299], [399, 299], [200, 0]]) {
      expect(alpha(local.composition, x!, y!)).toBe(0);
      expect(rgb(pixels, 400, x!, y!)).toEqual([229, 35, 43]);
    }
    expect(local.composition.maskRaw).toEqual(composition.maskRaw);
  });

  it("aligns a uniformly enlarged local edit and copies only global allowed RGB, preserving every other room pixel", async () => {
    const { composition, objects, guide } = await localFixture();
    const local = await localiseRoomIntegration(composition, objects, guide);
    const padded = await padCompositionForAspect(local.composition, "1024x1536");
    const generated = await sharp({ create: { width: padded.paddedWidth * 2, height: padded.paddedHeight * 2,
      channels: 3, background: "#0099ee" } }).png().toBuffer();
    const output = await restoreLocalRoomIntegrationBackground(composition, local.window, padded, generated);
    expect(await sharp(output).metadata()).toMatchObject({ width: 400, height: 300, hasAlpha: false });
    const pixels = await sharp(output).raw().toBuffer();
    const room = await sharp(composition.sceneWebp!).raw().toBuffer();
    expect(rgb(pixels, 400, 80, 210)).toEqual([0, 153, 238]);
    expect(rgb(pixels, 400, 80, 241)).toEqual([0, 153, 238]);
    const changedProtectedPixels: number[] = [];
    for (let pixel = 0; pixel < 400 * 300; pixel++) {
      if (composition.maskRaw[pixel * 4 + 3] === 0) continue;
      const offset = pixel * 3;
      if (pixels[offset] !== room[offset] || pixels[offset + 1] !== room[offset + 1] || pixels[offset + 2] !== room[offset + 2])
        changedProtectedPixels.push(pixel);
    }
    expect(changedProtectedPixels).toEqual([]);
  });

  it("refuses transparent or wrong-aspect local outputs and windows that omit any global edit region", async () => {
    const { composition, objects, guide } = await localFixture();
    const local = await localiseRoomIntegration(composition, objects, guide);
    const padded = await padCompositionForAspect(local.composition, "1024x1536");
    const transparent = await sharp({ create: { width: padded.paddedWidth, height: padded.paddedHeight,
      channels: 4, background: "#00000000" } }).png().toBuffer();
    await expect(restoreLocalRoomIntegrationBackground(composition, local.window, padded, transparent)).rejects.toThrow("opaque");
    const square = await sharp({ create: { width: 100, height: 100, channels: 3, background: "#abcdef" } }).png().toBuffer();
    await expect(restoreLocalRoomIntegrationBackground(composition, local.window, padded, square)).rejects.toThrow();
    await expect(restoreLocalRoomIntegrationBackground(composition, { left: 70, top: 200, width: 20, height: 20 }, padded, padded.imageWebp)).rejects.toThrow();
    await expect(restoreLocalRoomIntegrationBackground(composition, { ...local.window, left: -1 }, padded, padded.imageWebp)).rejects.toThrow();
  });

  it("restores a native portrait response for a near-ratio local crop when exact padding is requested", async () => {
    const width = 201, height = 300;
    const room = await sharp({ create: { width, height, channels: 3, background: "#526578" } })
      .webp({ lossless: true }).toBuffer();
    const maskRaw = Buffer.alloc(width * height * 4, 255);
    for (let y = 130; y <= 170; y++) for (let x = 80; x <= 120; x++) maskRaw[(y * width + x) * 4 + 3] = 0;
    const composition = { ...await fixture(), sceneWidth: width, sceneHeight: height,
      sceneWebp: room, imageWebp: room, baseWebp: room, maskRaw };
    const window = { left: 0, top: 0, width, height };
    const generated = await sharp({ create: { width: 1024, height: 1536, channels: 3, background: "#0099ee" } }).png().toBuffer();
    const legacy = await padCompositionForAspect(composition, "1024x1536");
    await expect(restoreLocalRoomIntegrationBackground(composition, window, legacy, generated)).rejects.toThrow();
    const padded = await padCompositionForAspect(composition, "1024x1536", { exactAspect: true });
    const output = await restoreLocalRoomIntegrationBackground(composition, window, padded, generated);
    expect(await sharp(output).metadata()).toMatchObject({ width, height, hasAlpha: false });
    const pixels = await sharp(output).raw().toBuffer();
    expect(rgb(pixels, width, 100, 150)).toEqual([0, 153, 238]);
    expect(rgb(pixels, width, 100, 0)).toEqual([82, 101, 120]);
    expect(rgb(pixels, width, 100, 299)).toEqual([82, 101, 120]);
  });

  it("refuses missing/unreadable or mismatched guides, empty/bad masks and invalid objects locally", async () => {
    const { composition, objects, guide } = await localFixture();
    const wrongGuide = await sharp({ create: { width: 200, height: 300, channels: 3, background: "#abcdef" } }).webp().toBuffer();
    for (const badGuide of [Buffer.alloc(0), Buffer.from("bad"), wrongGuide])
      await expect(localiseRoomIntegration(composition, objects, badGuide)).rejects.toThrow();
    await expect(localiseRoomIntegration({ ...composition, maskRaw: Buffer.alloc(400 * 300 * 4, 255) }, objects, guide)).rejects.toThrow();
    const partialMask = Buffer.from(composition.maskRaw); partialMask[3] = 128;
    await expect(localiseRoomIntegration({ ...composition, maskRaw: partialMask }, objects, guide)).rejects.toThrow();
    await expect(localiseRoomIntegration(composition, [objects[0]!, objects[0]!], guide)).rejects.toThrow();
    await expect(localiseRoomIntegration(composition, [{ ...objects[0]!, point: { x: 0.9, y: 0.1 } }], guide)).rejects.toThrow();
  });
});
async function fixture(): Promise<SimpleComposition> {
  const room = await sharp({ create: { width: 160, height: 120, channels: 3, background: "#526578" } })
    .webp({ lossless: true }).toBuffer();
  const sprite = await sharp({ create: { width: 160, height: 120, channels: 3, background: "#aa4400" } })
    .webp({ lossless: true }).toBuffer();
  return { sceneWebp: room, imageWebp: sprite, baseWebp: sprite,
    maskRaw: Buffer.alloc(160 * 120 * 4, 255), sceneWidth: 160, sceneHeight: 120,
    placements: [], overlays: [], lighting: null };
}
const alpha = (composition: SimpleComposition, x: number, y: number) =>
  composition.maskRaw[(y * composition.sceneWidth + x) * 4 + 3];
const rgb = (data: Buffer, width: number, x: number, y: number) =>
  [...data.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)];

describe("complete local photographic refinement", () => {
  it("keeps historical versions and input buffers intact while giving the entire product and support room to be corrected", async () => {
    const original = await fixture(), objects = [object(0, 0.5, 0.7)];
    const beforeMask = Buffer.from(original.maskRaw), beforeImage = Buffer.from(original.imageWebp);
    const historical = roomIntegrationEditComposition(original, objects);
    const expanded = roomRefinementEditComposition(original, objects);
    expect(STOREFRONT_ROOM_REFINEMENT_COMPOSITE_VERSION).toBe("storefront-room-refinement-region-v1");
    expect(STOREFRONT_ROOM_INTEGRATION_COMPOSITE_VERSION).toBe("storefront-room-integration-v5");
    expect(STOREFRONT_LOCAL_ROOM_INTEGRATION_COMPOSITE_VERSION).toBe("storefront-room-local-integration-v6");
    expect(expanded.imageWebp).toBe(original.sceneWebp);
    expect(expanded.baseWebp).toBe(original.sceneWebp);
    expect(alpha(historical, 80, 103)).toBe(255);
    expect(alpha(expanded, 80, 103)).toBe(0);
    expect(alpha(expanded, 5, 5)).toBe(255);
    for (let pixel = 0; pixel < 160 * 120; pixel++)
      if (historical.maskRaw[pixel * 4 + 3] === 0) expect(expanded.maskRaw[pixel * 4 + 3]).toBe(0);
    expect(original.maskRaw).toEqual(beforeMask);
    expect(original.imageWebp).toEqual(beforeImage);
  });

  it("expands distant products separately without unlocking the room between them", async () => {
    const room = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#56789a" } }).webp({ lossless: true }).toBuffer();
    const original = { ...await fixture(), sceneWebp: room, sceneWidth: 400, sceneHeight: 300,
      maskRaw: Buffer.alloc(400 * 300 * 4, 255) };
    const expanded = roomRefinementEditComposition(original, [object(0, 0.1, 0.8), object(1, 0.9, 0.8)]);
    expect(alpha(expanded, 40, 250)).toBe(0);
    expect(alpha(expanded, 360, 250)).toBe(0);
    expect(alpha(expanded, 200, 230)).toBe(255);
    expect(alpha(expanded, 200, 150)).toBe(255);
  });

  it("includes confirmed old-object boundaries and their immediate support but no unconfirmed removal region", async () => {
    const original = await fixture(), objects = [object(0, 0.2, 0.7)];
    const box = { xMin: 0.7, yMin: 0.3, xMax: 0.9, yMax: 0.6 };
    const insertion = roomRefinementEditComposition(original, objects);
    const replacement = roomRefinementEditComposition(original, objects, [box]);
    expect(alpha(insertion, 108, 75)).toBe(255);
    expect(alpha(replacement, 108, 75)).toBe(0);
    expect(alpha(replacement, 128, 54)).toBe(0);
    expect(alpha(replacement, 88, 80)).toBe(255);
    expect(() => roomRefinementEditComposition(original, objects, [box, box])).toThrow();
    expect(() => roomRefinementEditComposition(original, objects, [{ xMin: 0, yMin: 0, xMax: 1, yMax: 1 }])).toThrow();
  });

  it("retains the corrected body, base and contact below the old mask and preserves every exterior room pixel", async () => {
    const original = await fixture(), objects = [object(0, 0.5, 0.7)];
    const edit = roomRefinementEditComposition(original, objects);
    const local = await localiseRoomIntegration(edit, objects, original.sceneWebp!);
    const padded = await padCompositionForAspect(local.composition, "1536x1024", { exactAspect: true });
    const generated = await sharp({ create: { width: padded.paddedWidth * 2, height: padded.paddedHeight * 2,
      channels: 3, background: "#0099ee" } }).png().toBuffer();
    const restored = await sharp(await restoreLocalRoomIntegrationBackground(edit, local.window, padded, generated)).raw().toBuffer();
    const source = await sharp(original.sceneWebp!).raw().toBuffer();
    expect(rgb(restored, 160, 80, 55)).toEqual([0, 153, 238]);
    expect(rgb(restored, 160, 80, 84)).toEqual([0, 153, 238]);
    expect(rgb(restored, 160, 80, 103)).toEqual([0, 153, 238]);
    let unchanged = 0;
    for (let pixel = 0; pixel < 160 * 120; pixel++) {
      if (edit.maskRaw[pixel * 4 + 3] === 0) continue;
      expect(restored.subarray(pixel * 3, pixel * 3 + 3)).toEqual(source.subarray(pixel * 3, pixel * 3 + 3));
      unchanged++;
    }
    expect(unchanged).toBeGreaterThan(9000);
  });

  it("keeps flat, wall and edge regions bounded to the photograph", async () => {
    const original = await fixture();
    const expanded = roomRefinementEditComposition(original, [
      { ...object(0, 0, 1), kind: "flat" }, { ...object(1, 1, 0), kind: "wall" },
    ]);
    expect(expanded.maskRaw.length).toBe(160 * 120 * 4);
    expect(alpha(expanded, 0, 119)).toBe(0);
    expect(alpha(expanded, 159, 0)).toBe(0);
    expect(alpha(expanded, 80, 60)).toBe(255);
    expect(() => roomRefinementEditComposition(original, [object(), object()])).toThrow();
  });

  it("normalizes the opaque provider photograph uniformly to the exact padded mask canvas and emits PNG", async () => {
    const padded = await padCompositionForAspect(await fixture(), "1536x1024", { exactAspect: true });
    const bytes = Buffer.alloc(padded.paddedWidth * 2 * padded.paddedHeight * 2 * 3);
    const width = padded.paddedWidth * 2, height = padded.paddedHeight * 2;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      bytes[i] = x % 255; bytes[i + 1] = y % 255; bytes[i + 2] = 170;
    }
    const generated = await sharp(bytes, { raw: { width, height, channels: 3 } }).png().toBuffer();
    const output = await prepareRoomRefinementBase(padded, generated);
    expect(await sharp(output).metadata()).toMatchObject({ format: "png", width: padded.paddedWidth, height: padded.paddedHeight, hasAlpha: false });
    expect(await sharp(output).raw().toBuffer()).toEqual(await sharp(generated).resize({ width: padded.paddedWidth }).raw().toBuffer());
  });

  it("accepts fully opaque alpha and harmless subpixel aspect rounding without stretching", async () => {
    const padded = { ...await padCompositionForAspect(await fixture(), "1536x1024"), paddedWidth: 101, paddedHeight: 67, offsetX: 0, offsetY: 0 };
    const generated = await sharp({ create: { width: 1024, height: 683, channels: 4, background: "#123456ff" } }).png().toBuffer();
    const output = await prepareRoomRefinementBase(padded, generated);
    expect(await sharp(output).metadata()).toMatchObject({ width: 101, height: 67, hasAlpha: false, format: "png" });
    expect(rgb(await sharp(output).raw().toBuffer(), 101, 50, 30)).toEqual([18, 52, 86]);
  });

  it("refuses transparent, differently cropped or rotated provider output instead of adapting its geometry", async () => {
    const padded = await padCompositionForAspect(await fixture(), "1536x1024", { exactAspect: true });
    const create = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: "#56789a" } });
    const transparent = await sharp({ create: { width: padded.paddedWidth, height: padded.paddedHeight,
      channels: 4, background: "#56789a80" } }).png().toBuffer();
    await expect(prepareRoomRefinementBase(padded, transparent)).rejects.toThrow("opaque");
    await expect(prepareRoomRefinementBase(padded, await create(100, 100).png().toBuffer())).rejects.toThrow();
    await expect(prepareRoomRefinementBase(padded, await create(padded.paddedWidth, padded.paddedHeight).withMetadata({ orientation: 6 }).jpeg().toBuffer())).rejects.toThrow();
    await expect(prepareRoomRefinementBase(padded, Buffer.alloc(0))).rejects.toThrow();
    await expect(prepareRoomRefinementBase({ ...padded, paddedWidth: 0 }, padded.imageWebp)).rejects.toThrow();
    await expect(prepareRoomRefinementBase({ ...padded, offsetX: padded.paddedWidth }, padded.imageWebp)).rejects.toThrow();
  });
});

describe("native-resolution room refinement bridge", () => {
  async function frameFixture(size = "1536x1024") {
    const composition = roomRefinementEditComposition(await fixture(), [object(0, 0.5, 0.7)]);
    return padCompositionForAspect(composition, size, { exactAspect: true });
  }

  it.each([
    { width: 152, height: 101, size: "1536x1024", outputWidth: 153, outputHeight: 102 },
    { width: 101, height: 152, size: "1024x1536", outputWidth: 102, outputHeight: 153 },
    { width: 153, height: 102, size: "1536x1024", outputWidth: 153, outputHeight: 102 },
    { width: 151, height: 103, size: "1024x1024", outputWidth: 151, outputHeight: 151 },
  ])("pads $width×$height to exact raster ratio $size without resizing any photograph or mask pixel", async input => {
    const { width, height } = input;
    const raw = Buffer.alloc(width * height * 3), maskRaw = Buffer.alloc(width * height * 4, 255);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const pixel = y * width + x;
      raw[pixel * 3] = x % 256; raw[pixel * 3 + 1] = y % 256; raw[pixel * 3 + 2] = (x + y) % 2 * 255;
      maskRaw[pixel * 4 + 3] = x > 10 && x < 40 && y > 20 && y < 60 ? 0 : 255;
    }
    const photo = await sharp(raw, { raw: { width, height, channels: 3 } }).webp({ lossless: true }).toBuffer();
    const composition = { ...await fixture(), sceneWebp: photo, imageWebp: photo, maskRaw, sceneWidth: width, sceneHeight: height };
    const beforeMask = Buffer.from(maskRaw), beforePhoto = Buffer.from(photo);
    const padded = await padCompositionForAspect(composition, input.size, { exactRasterAspect: true });
    expect(padded.paddedWidth).toBe(input.outputWidth);
    expect(padded.paddedHeight).toBe(input.outputHeight);
    const [requestedWidth, requestedHeight] = input.size.split("x").map(Number);
    expect(padded.paddedWidth * requestedHeight!).toBe(padded.paddedHeight * requestedWidth!);
    const image = await sharp(padded.imageWebp).removeAlpha().raw().toBuffer();
    const mask = await sharp(padded.maskPng).ensureAlpha().raw().toBuffer();
    let imageDifferences = 0, maskDifferences = 0;
    for (let y = 0; y < padded.paddedHeight; y++) for (let x = 0; x < padded.paddedWidth; x++) {
      const originalX = x - padded.offsetX, originalY = y - padded.offsetY;
      const inside = originalX >= 0 && originalX < width && originalY >= 0 && originalY < height;
      const pixel = y * padded.paddedWidth + x, originalPixel = originalY * width + originalX;
      for (let channel = 0; channel < 3; channel++)
        if (image[pixel * 3 + channel] !== (inside ? raw[originalPixel * 3 + channel] : 118)) imageDifferences++;
      if (mask[pixel * 4 + 3] !== (inside ? maskRaw[originalPixel * 4 + 3] : 255)) maskDifferences++;
    }
    expect(imageDifferences).toBe(0);
    expect(maskDifferences).toBe(0);
    expect(maskRaw).toEqual(beforeMask);
    expect(photo).toEqual(beforePhoto);
    const nativePhoto = await sharp({ create: { width: requestedWidth!, height: requestedHeight!, channels: 3, background: "#456789" } }).png().toBuffer();
    const native = await prepareNativeRoomRefinementFrame(padded, nativePhoto);
    expect(native.frame).toEqual({ width: requestedWidth, height: requestedHeight });
  });

  it("leaves historical approximate padding untouched and rejects invalid exact-raster dimensions", async () => {
    const width = 152, height = 101;
    const photo = await sharp({ create: { width, height, channels: 3, background: "#456789" } }).png().toBuffer();
    const composition = { ...await fixture(), imageWebp: photo, sceneWidth: width, sceneHeight: height, maskRaw: Buffer.alloc(width * height * 4, 255) };
    for (const options of [{}, { exactAspect: true }, { exactRasterAspect: false }]) {
      const old = await padCompositionForAspect(composition, "1536x1024", options);
      expect([old.paddedWidth, old.paddedHeight]).toEqual([152, 101]);
    }
    for (const size of ["0x0", "bad", "1.5x1", "99999999x1"])
      await expect(padCompositionForAspect(composition, size, { exactRasterAspect: true })).rejects.toThrow();
  });

  it("retains native photograph pixels without downsampling, crop or aspect adaptation", async () => {
    const padded = await frameFixture();
    const width = padded.paddedWidth * 4, height = padded.paddedHeight * 4;
    const raw = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      raw[offset] = x % 256; raw[offset + 1] = y % 256; raw[offset + 2] = (x + y) % 2 * 255;
    }
    const source = await sharp(raw, { raw: { width, height, channels: 3 } }).webp({ lossless: true }).toBuffer();
    const beforeSource = Buffer.from(source), beforeMask = Buffer.from(padded.maskPng);
    const result = await prepareNativeRoomRefinementFrame(padded, source);
    expect(STOREFRONT_NATIVE_ROOM_REFINEMENT_FRAME_VERSION).toBe("storefront-room-refinement-native-frame-v1");
    expect(result.frame).toEqual({ width, height });
    expect(result.scale).toBe(4);
    expect(result.padding).toEqual({ x: padded.offsetX * 4, y: padded.offsetY * 4 });
    expect(await sharp(result.image).metadata()).toMatchObject({ width, height, format: "png", hasAlpha: false });
    expect(await sharp(result.image).raw().toBuffer()).toEqual(raw);
    expect(source).toEqual(beforeSource);
    expect(padded.maskPng).toEqual(beforeMask);
  });

  it("maps every edit and protection pixel to the identical native rectangle with binary alpha", async () => {
    const padded = await frameFixture();
    const source = await sharp({ create: { width: padded.paddedWidth * 3, height: padded.paddedHeight * 3,
      channels: 3, background: "#234567" } }).png().toBuffer();
    const result = await prepareNativeRoomRefinementFrame(padded, source);
    const original = await sharp(padded.maskPng).ensureAlpha().raw().toBuffer();
    const mask = await sharp(result.maskPng).ensureAlpha().raw().toBuffer();
    expect(await sharp(result.maskPng).metadata()).toMatchObject({ ...result.frame, format: "png", hasAlpha: true });
    let failures = 0;
    for (let y = 0; y < result.frame.height; y++) for (let x = 0; x < result.frame.width; x++) {
      const expected = original[(Math.floor(y / 3) * padded.paddedWidth + Math.floor(x / 3)) * 4 + 3];
      if (mask[(y * result.frame.width + x) * 4 + 3] !== expected) failures++;
    }
    expect(failures).toBe(0);
  });

  it("keeps fractional padding and contact transforms uniform and normalized coordinates unchanged", async () => {
    const padded = await frameFixture("1024x1024");
    const source = await sharp({ create: { width: 257, height: 257, channels: 3, background: "#234567" } }).png().toBuffer();
    const result = await prepareNativeRoomRefinementFrame(padded, source);
    expect(result.scale).toBe(257 / padded.paddedWidth);
    expect(result.padding.y).not.toBe(Math.round(result.padding.y));
    const sourcePoint = { x: 80, y: 84 };
    const contact = { x: sourcePoint.x * result.scale + result.padding.x,
      y: sourcePoint.y * result.scale + result.padding.y };
    expect(contact.x / result.frame.width).toBeCloseTo((sourcePoint.x + padded.offsetX) / padded.paddedWidth, 14);
    expect(contact.y / result.frame.height).toBeCloseTo((sourcePoint.y + padded.offsetY) / padded.paddedHeight, 14);
    const mask = await sharp(result.maskPng).ensureAlpha().raw().toBuffer();
    expect(mask[(Math.round(contact.y) * result.frame.width + Math.round(contact.x)) * 4 + 3]).toBe(0);
  });

  it("allows at most half a native raster pixel of aspect rounding and never stretches the photograph", async () => {
    const old = await frameFixture();
    const mask = await sharp({ create: { width: 101, height: 67, channels: 4, background: "#ffffffff" } }).png().toBuffer();
    const padded = { ...old, maskPng: mask, paddedWidth: 101, paddedHeight: 67, offsetX: 0, offsetY: 0 };
    const source = await sharp({ create: { width: 1024, height: 679, channels: 4, background: "#123456ff" } }).png().toBuffer();
    const result = await prepareNativeRoomRefinementFrame(padded, source);
    expect(result.frame).toEqual({ width: 1024, height: 679 });
    expect(await sharp(result.image).removeAlpha().raw().toBuffer()).toEqual(await sharp(source).removeAlpha().raw().toBuffer());
    const wrong = await sharp(source).resize({ width: 1024, height: 683, fit: "fill" }).png().toBuffer();
    await expect(prepareNativeRoomRefinementFrame(padded, wrong)).rejects.toThrow();
  });

  it("restores a native edit using the original room transform and preserves every pixel outside the region", async () => {
    const original = await fixture(), objects = [object(0, 0.5, 0.7)];
    const edit = roomRefinementEditComposition(original, objects);
    const local = await localiseRoomIntegration(edit, objects, original.sceneWebp!);
    const padded = await padCompositionForAspect(local.composition, "1024x1024", { exactAspect: true });
    const generated = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#0099ee" } }).png().toBuffer();
    const native = await prepareNativeRoomRefinementFrame(padded, generated);
    const contact = { x: (80 - local.window.left) * native.scale + native.padding.x,
      y: (84 - local.window.top) * native.scale + native.padding.y };
    expect((contact.x - native.padding.x) / native.scale + local.window.left).toBeCloseTo(80, 12);
    expect((contact.y - native.padding.y) / native.scale + local.window.top).toBeCloseTo(84, 12);
    const restored = await sharp(await restoreLocalRoomIntegrationBackground(edit, local.window, padded, native.image)).raw().toBuffer();
    const source = await sharp(original.sceneWebp!).raw().toBuffer();
    expect(rgb(restored, 160, 80, 84)).toEqual([0, 153, 238]);
    let changedOutside = 0;
    for (let pixel = 0; pixel < 160 * 120; pixel++)
      if (edit.maskRaw[pixel * 4 + 3] !== 0 && !restored.subarray(pixel * 3, pixel * 3 + 3).equals(source.subarray(pixel * 3, pixel * 3 + 3))) changedOutside++;
    expect(changedOutside).toBe(0);
  });

  it("rejects a missing, mismatched, opaque-only or non-binary edit mask", async () => {
    const padded = await frameFixture(), source = padded.imageWebp;
    const wrongSize = await sharp({ create: { width: 2, height: 2, channels: 4, background: "white" } }).png().toBuffer();
    const noAlpha = await sharp(padded.maskPng).removeAlpha().png().toBuffer();
    const raw = await sharp(padded.maskPng).ensureAlpha().raw().toBuffer(); raw[3] = 127;
    const nonBinary = await sharp(raw, { raw: { width: padded.paddedWidth, height: padded.paddedHeight, channels: 4 } }).png().toBuffer();
    for (const maskPng of [Buffer.alloc(0), wrongSize, noAlpha, nonBinary])
      await expect(prepareNativeRoomRefinementFrame({ ...padded, maskPng }, source)).rejects.toThrow();
  });

  it("rejects transparent, rotated, reframed or invalid photograph inputs without changing the original frame", async () => {
    const padded = await frameFixture();
    const transparent = await sharp(padded.imageWebp).ensureAlpha(0.5).png().toBuffer();
    const rotated = await sharp(padded.imageWebp).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const wrongAspect = await sharp({ create: { width: 500, height: 500, channels: 3, background: "white" } }).png().toBuffer();
    for (const source of [transparent, rotated, wrongAspect, Buffer.alloc(0), Buffer.from("not an image")])
      await expect(prepareNativeRoomRefinementFrame(padded, source)).rejects.toThrow();
    await expect(prepareNativeRoomRefinementFrame({ ...padded, offsetX: padded.paddedWidth }, padded.imageWebp)).rejects.toThrow();
  });
});

describe("native room placement reference guide", () => {
  const isRed = (value: number[]) => value[0]! > 150 && value[1]! < 70 && value[2]! < 110;
  const isBlue = (value: number[]) => value[0]! < 80 && value[1]! < 140 && value[2]! > 150;
  async function guideFixture() {
    const image = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#687868" } }).png().toBuffer();
    return { image, frame: { width: 1024, height: 1024 }, contactPixel: { x: 504.2424242424, y: 674.9090909091 }, physicalWidthPx: 238.9333333333 };
  }

  it("marks the exact native contact and lateral width without adding a shape, recentering or changing the input", async () => {
    const input = await guideFixture(), before = Buffer.from(input.image);
    const output = await buildNativeRoomRefinementGuide(input);
    expect(STOREFRONT_NATIVE_ROOM_REFINEMENT_GUIDE_VERSION).toBe("storefront-room-refinement-native-guide-v2");
    expect(await sharp(output).metadata()).toMatchObject({ format: "png", width: 1024, height: 1024, hasAlpha: false });
    const raw = await sharp(output).raw().toBuffer();
    const { x, y } = input.contactPixel;
    expect(isRed(rgb(raw, 1024, Math.round(x), Math.round(y)))).toBe(true);
    expect(isRed(rgb(raw, 1024, Math.round(x + 15), Math.round(y)))).toBe(true);
    expect(isRed(rgb(raw, 1024, Math.round(x), Math.round(y - 15)))).toBe(true);
    expect(isBlue(rgb(raw, 1024, Math.round(x - input.physicalWidthPx / 2), Math.round(y)))).toBe(true);
    expect(isBlue(rgb(raw, 1024, Math.round(x + input.physicalWidthPx / 2), Math.round(y)))).toBe(true);
    // No box/cylinder or line joining ticks into a false product silhouette.
    for (const [px, py] of [[x - 65, y], [x + 65, y], [x, y - 70], [x, y + 70]])
      expect(rgb(raw, 1024, Math.round(px!), Math.round(py!))).toEqual([104, 120, 104]);
    let outsideChanges = 0;
    for (let py = 0; py < 1024; py++) for (let px = 0; px < 1024; px++)
      if (px < x - input.physicalWidthPx / 2 - 8 || px > x + input.physicalWidthPx / 2 + 8 || py < y - 54 || py > y + 44)
        if (!rgb(raw, 1024, px, py).every((value, channel) => value === [104, 120, 104][channel])) outsideChanges++;
    expect(outsideChanges).toBe(0);
    expect(input.image).toEqual(before);
  });

  it("uses the documented original-to-native mapping exactly once, including padding", async () => {
    const base = await guideFixture();
    const scale = 1024 / 132, window = { left: 514, top: 369 }, padding = { x: 5 * scale, y: 0 };
    const contactPixel = { x: (574 - window.left) * scale + padding.x, y: (456 - window.top) * scale + padding.y };
    const output = await buildNativeRoomRefinementGuide({ ...base, contactPixel, physicalWidthPx: 30.8 * scale });
    const raw = await sharp(output).raw().toBuffer();
    expect(isRed(rgb(raw, 1024, Math.round(contactPixel.x), Math.round(contactPixel.y)))).toBe(true);
    // Neither the original room point nor the low-resolution crop contact is marked.
    expect(rgb(raw, 1024, 574, 456)).toEqual([104, 120, 104]);
    expect(rgb(raw, 1024, 65, 87)).toEqual([104, 120, 104]);
  });

  it("uses fixed vector labels with no system-font or SVG text dependency", async () => {
    const source = await readFile(new URL("../lib/server/storefront-room-integration.ts", import.meta.url), "utf8");
    const guideSource = source.slice(source.indexOf("export async function buildNativeRoomRefinementGuide"), source.indexOf("/** Restore only the allowed full-scene edit"));
    expect(guideSource).not.toMatch(/<text\b|font-family|font-size|foreignObject|@font-face/);
    const input = await guideFixture();
    const raw = await sharp(await buildNativeRoomRefinementGuide(input)).raw().toBuffer();
    let redLabel = 0, blueLabel = 0;
    for (let y = 624; y < 653; y++) for (let x = 465; x < 544; x++)
      if (isBlue(rgb(raw, 1024, x, y))) blueLabel++;
    for (let y = 693; y < 720; y++) for (let x = 470; x < 540; x++)
      if (isRed(rgb(raw, 1024, x, y))) redLabel++;
    expect(blueLabel).toBeGreaterThan(100);
    expect(redLabel).toBeGreaterThan(100);
  });

  it("keeps the marker fixed at canvas edges and distinguishes centre anchors without shifting the photograph", async () => {
    const input = await guideFixture();
    for (const contactPixel of [{ x: 0, y: 0 }, { x: 1023, y: 1023 }]) {
      const output = await buildNativeRoomRefinementGuide({ ...input, contactPixel, kind: "wall" });
      expect(isRed(rgb(await sharp(output).raw().toBuffer(), 1024, contactPixel.x, contactPixel.y))).toBe(true);
      expect(await sharp(output).metadata()).toMatchObject({ width: 1024, height: 1024 });
    }
    const standing = await buildNativeRoomRefinementGuide(input);
    const wall = await buildNativeRoomRefinementGuide({ ...input, kind: "wall" });
    const flat = await buildNativeRoomRefinementGuide({ ...input, kind: "flat" });
    expect(wall).toEqual(flat);
    expect(standing).not.toEqual(wall);
  });

  it("rejects frame mismatches, invalid geometry and transparent input before constructing a guide", async () => {
    const input = await guideFixture();
    for (const partial of [{ frame: { width: 512, height: 1024 } }, { contactPixel: { x: NaN, y: 100 } },
      { contactPixel: { x: -1, y: 100 } }, { contactPixel: { x: 10, y: 1025 } }, { physicalWidthPx: 0 }, { physicalWidthPx: 1025 }])
      await expect(buildNativeRoomRefinementGuide({ ...input, ...partial })).rejects.toThrow();
    const transparent = await sharp(input.image).ensureAlpha(0.5).png().toBuffer();
    await expect(buildNativeRoomRefinementGuide({ ...input, image: transparent })).rejects.toThrow("opaque");
  });
});

describe("storefront full-room integration", () => {
  it("widens the editable area only when confirmed replacement boxes are supplied, without mutating the original room or mask", async () => {
    const original = await fixture();
    const originalMask = Buffer.from(original.maskRaw);
    const originalPhoto = Buffer.from(original.sceneWebp!);
    const insertion = roomIntegrationEditComposition(original, [object()]);
    const replacement = { xMin: 0.15, yMin: 0.45, xMax: 0.65, yMax: 0.85 };
    const confirmed = roomIntegrationEditComposition(original, [object()], [replacement]);
    expect(alpha(insertion, 35, 75)).toBe(255);
    expect(alpha(confirmed, 35, 75)).toBe(0);
    expect(alpha(confirmed, 10, 10)).toBe(255);
    for (let y = 0; y < original.sceneHeight; y++) for (let x = 0; x < original.sceneWidth; x++) {
      const insideConfirmed = x >= 24 && x < 104 && y >= 54 && y < 102;
      if (!insideConfirmed) expect(alpha(confirmed, x, y)).toBe(alpha(insertion, x, y));
    }
    expect(original.sceneWebp).toEqual(originalPhoto);
    expect(original.maskRaw).toEqual(originalMask);
  });

  it("retains the generated replacement background while preserving unrelated room pixels", async () => {
    const replacement = { xMin: 0.15, yMin: 0.45, xMax: 0.65, yMax: 0.85 };
    const composition = roomIntegrationEditComposition(await fixture(), [object()], [replacement]);
    const padded = await padCompositionForAspect(composition, "1536x1024");
    const generated = await sharp({ create: { width: padded.paddedWidth, height: padded.paddedHeight, channels: 3, background: "#0099ee" } }).png().toBuffer();
    const restored = await sharp(await restoreRoomIntegrationBackground(composition, padded, generated)).raw().toBuffer();
    const original = await sharp(composition.sceneWebp!).raw().toBuffer();
    expect(rgb(restored, 160, 35, 75)).toEqual([0, 153, 238]);
    expect(rgb(restored, 160, 10, 10)).toEqual(rgb(original, 160, 10, 10));
    for (let pixel = 0; pixel < 160 * 120; pixel++) {
      if (composition.maskRaw[pixel * 4 + 3] !== 255) continue;
      expect(restored.subarray(pixel * 3, pixel * 3 + 3)).toEqual(original.subarray(pixel * 3, pixel * 3 + 3));
    }
  });

  it.each([
    {}, { xMin: 0.1, yMin: 0.2, xMax: 0.4 },
    { xMin: -0.1, yMin: 0.2, xMax: 0.4, yMax: 0.5 },
    { xMin: 0.1, yMin: 0.2, xMax: NaN, yMax: 0.5 },
    { xMin: 0.4, yMin: 0.2, xMax: 0.1, yMax: 0.5 },
    { xMin: 0, yMin: 0, xMax: 1, yMax: 1 },
  ])("refuses invalid or overbroad replacement geometry before a model can edit it (%j)", async box => {
    const original = await fixture();
    expect(() => roomIntegrationEditComposition(original, [object()], [box as { xMin: number; yMin: number; xMax: number; yMax: number }])).toThrow();
  });

  it("refuses more replacement regions than requested objects", async () => {
    const original = await fixture();
    const box = { xMin: 0.1, yMin: 0.2, xMax: 0.4, yMax: 0.5 };
    expect(() => roomIntegrationEditComposition(original, [object()], [box, box])).toThrow();
  });

  it("uses only the original room and creates a local physical-volume/contact mask without altering the old composition", async () => {
    const original = await fixture();
    const before = Buffer.from(original.maskRaw);
    const local = roomIntegrationEditComposition(original, [object()]);
    expect(STOREFRONT_ROOM_INTEGRATION_COMPOSITE_VERSION).toBe("storefront-room-integration-v5");
    expect(local.imageWebp).toBe(original.sceneWebp);
    expect(local.baseWebp).toBe(original.sceneWebp);
    expect(original.maskRaw).toEqual(before);
    expect(original.imageWebp).not.toEqual(original.sceneWebp);
    // Height=40 px, width=30 px, top-depth=15 px above the visible base y=96.
    expect(alpha(local, 80, 42)).toBe(0);
    expect(alpha(local, 65, 70)).toBe(0);
    expect(alpha(local, 80, 96)).toBe(0);
    expect(alpha(local, 80, 100)).toBe(0);
    expect(alpha(local, 5, 5)).toBe(255);
    expect(alpha(local, 130, 110)).toBe(255);
  });

  it("uses horizontal scale independently of height, encloses rolled volume and handles unknown pose conservatively", async () => {
    const original = await fixture();
    const wider = roomIntegrationEditComposition(original, [{ ...object(), widthPixelsPerCm: 6 }]);
    expect(alpha(wider, 53, 70)).toBe(0);
    expect(alpha(roomIntegrationEditComposition(original, [object()]), 53, 70)).toBe(255);
    const rolled = roomIntegrationEditComposition(original, [{ ...object(), pose: { cameraElevationDegrees: 30, cameraRollDegrees: 30 } }]);
    expect(alpha(rolled, 110, 45)).toBe(0);
    const unknown = roomIntegrationEditComposition(original, [{ ...object(), pose: { cameraElevationDegrees: null, cameraRollDegrees: null } }]);
    expect(alpha(unknown, 80, 28)).toBe(0);
  });

  it("unions all three independent objects and supports flat/wall and source edges", async () => {
    const original = await fixture();
    const local = roomIntegrationEditComposition(original, [
      { ...object(0, 0.1, 0.9), kind: "flat" },
      { ...object(1, 0.5, 0.5), kind: "wall" },
      object(2, 0.98, 0.98),
    ]);
    expect(alpha(local, 16, 108)).toBe(0);
    expect(alpha(local, 80, 60)).toBe(0);
    expect(alpha(local, 157, 118)).toBe(0);
    expect(alpha(local, 40, 10)).toBe(255);
    expect(local.maskRaw.length).toBe(160 * 120 * 4);
  });

  it("keeps generated volume and contact shading, never re-stamps a sprite, and restores every exterior RGB pixel exactly", async () => {
    const local = roomIntegrationEditComposition(await fixture(), [object()]);
    const padded = await padCompositionForAspect(local, "1536x1024");
    const generated = await sharp({ create: { width: padded.paddedWidth, height: padded.paddedHeight, channels: 3, background: "#0099ee" } }).png().toBuffer();
    const output = await sharp(await restoreRoomIntegrationBackground(local, padded, generated)).raw().toBuffer();
    const room = await sharp(local.sceneWebp!).raw().toBuffer();
    expect(rgb(output, 160, 80, 70)).toEqual([0, 153, 238]);
    expect(rgb(output, 160, 80, 97)).toEqual([0, 153, 238]);
    let protectedPixels = 0;
    for (let pixel = 0; pixel < 160 * 120; pixel++) {
      if (local.maskRaw[pixel * 4 + 3] !== 255) continue;
      expect(output.subarray(pixel * 3, pixel * 3 + 3)).toEqual(room.subarray(pixel * 3, pixel * 3 + 3));
      protectedPixels++;
    }
    expect(protectedPixels).toBeGreaterThan(15_000);
  });

  it("uniformly scales a whole scene of matching aspect and crops the original letterbox without shifting the edit", async () => {
    const local = roomIntegrationEditComposition(await fixture(), [object()]);
    const padded = await padCompositionForAspect(local, "1024x1536");
    const frame = await sharp({ create: { width: padded.paddedWidth, height: padded.paddedHeight, channels: 3, background: "#ff0000" } })
      .composite([{ input: await sharp({ create: { width: 160, height: 120, channels: 3, background: "#00ee44" } }).png().toBuffer(), left: padded.offsetX, top: padded.offsetY }]).png().toBuffer();
    const enlarged = await sharp(frame).resize({ width: padded.paddedWidth * 2 }).png().toBuffer();
    const restored = await restoreRoomIntegrationBackground(local, padded, enlarged);
    expect(await sharp(restored).metadata()).toMatchObject({ width: 160, height: 120, hasAlpha: false });
    expect(rgb(await sharp(restored).raw().toBuffer(), 160, 80, 70)).toEqual([0, 238, 68]);
  });

  it("accepts RGBA only when all pixels are opaque, and refuses wrong aspect or transparent full-scene output", async () => {
    const local = roomIntegrationEditComposition(await fixture(), [object()]);
    const padded = await padCompositionForAspect(local, "1536x1024");
    const opaque = await sharp({ create: { width: padded.paddedWidth, height: padded.paddedHeight, channels: 4, background: "#abcdef" } }).png().toBuffer();
    await expect(restoreRoomIntegrationBackground(local, padded, opaque)).resolves.toBeInstanceOf(Buffer);
    const transparent = await sharp({ create: { width: padded.paddedWidth, height: padded.paddedHeight, channels: 4, background: "#00000000" } }).png().toBuffer();
    await expect(restoreRoomIntegrationBackground(local, padded, transparent)).rejects.toThrow("opaque");
    const wrongAspect = await sharp({ create: { width: 120, height: 120, channels: 3, background: "#abcdef" } }).png().toBuffer();
    await expect(restoreRoomIntegrationBackground(local, padded, wrongAspect)).rejects.toThrow();
  });

  it.each([
    [], [object(), object()], [object(), object(1), object(2), object(3)],
    [{ ...object(), widthPixelsPerCm: undefined }], [{ ...object(), widthPixelsPerCm: NaN }],
    [{ ...object(), widthPixelsPerCm: 1000 }],
    [{ ...object(), dimensionsCm: { width: 10, height: 1000, depth: 10 } }],
    [{ ...object(), point: { x: -0.1, y: 0.5 } }],
    [{ ...object(), dimensionsCm: { width: 10, height: Infinity, depth: 10 } }],
    [{ ...object(), pose: { cameraElevationDegrees: 86, cameraRollDegrees: 0 } }],
  ].map(objects => ({ objects })))("rejects invalid geometry before any generation (%j)", async ({ objects }) => {
    const original = await fixture();
    expect(() => roomIntegrationEditComposition(original, objects)).toThrow();
  });

  it("fails closed for missing original room, invalid mask, padding or unreadable generated image", async () => {
    const original = await fixture();
    expect(() => roomIntegrationEditComposition({ ...original, sceneWebp: undefined }, [object()])).toThrow();
    const local = roomIntegrationEditComposition(original, [object()]);
    const padded = await padCompositionForAspect(local, "1536x1024");
    await expect(restoreRoomIntegrationBackground({ ...local, maskRaw: Buffer.alloc(1) }, padded, padded.imageWebp)).rejects.toThrow();
    const nonBinary = Buffer.from(local.maskRaw); nonBinary[3] = 100;
    await expect(restoreRoomIntegrationBackground({ ...local, maskRaw: nonBinary }, padded, padded.imageWebp)).rejects.toThrow();
    await expect(restoreRoomIntegrationBackground(local, { ...padded, offsetX: 500 }, padded.imageWebp)).rejects.toThrow();
    await expect(restoreRoomIntegrationBackground(local, padded, Buffer.from("not an image"))).rejects.toThrow();
  });
});


describe("v9 customer-confirmed replacement permission", () => {
  it("allows a .42-photo region only explicitly and does not erase outside the selected rectangle", async () => {
    const original = await fixture();
    const objects = [object(0, 0.2, 0.8)];
    const box = { xMin: 0.1, yMin: 0.25, xMax: 0.8, yMax: 0.85 };
    expect(() => roomRefinementEditComposition(original, objects, [box])).toThrow();
    const edit = roomRefinementEditComposition(original, objects, [box], { confirmedReplacement: true });
    expect(alpha(edit, 127, 60)).toBe(0);
    expect(alpha(edit, 128, 60)).toBe(255);
    const local = await localiseRoomIntegration(edit, objects, original.sceneWebp!);
    const padded = await padCompositionForAspect(local.composition, "1536x1024", { exactAspect: true });
    const generated = await sharp({ create: { width: padded.paddedWidth, height: padded.paddedHeight,
      channels: 3, background: "#0099ee" } }).png().toBuffer();
    const restored = await sharp(await restoreLocalRoomIntegrationBackground(edit, local.window, padded, generated)).raw().toBuffer();
    const source = await sharp(original.sceneWebp!).raw().toBuffer();
    for (let pixel = 0; pixel < original.sceneWidth * original.sceneHeight; pixel++) {
      if (edit.maskRaw[pixel * 4 + 3] === 0) continue;
      expect(restored.subarray(pixel * 3, pixel * 3 + 3)).toEqual(source.subarray(pixel * 3, pixel * 3 + 3));
    }
    expect(() => roomRefinementEditComposition(original, objects,
      [{ xMin: 0, yMin: 0, xMax: 1, yMax: 1 }], { confirmedReplacement: true })).toThrow();
  });
});
