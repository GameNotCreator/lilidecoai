import { describe, expect, it } from "vitest";
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

describe("storefront full-room integration", () => {
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
