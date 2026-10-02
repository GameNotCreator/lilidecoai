import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { padCompositionForAspect, type SimpleComposition } from "../lib/server/simple-composite";
import type { StorefrontPerspectiveGuideObject } from "../lib/server/storefront-perspective-guide";
import {
  roomIntegrationEditComposition,
  restoreRoomIntegrationBackground,
  STOREFRONT_ROOM_INTEGRATION_COMPOSITE_VERSION,
} from "../lib/server/storefront-room-integration";

const object = (index = 0, x = 0.5, y = 0.8): StorefrontPerspectiveGuideObject => ({
  index, point: { x, y }, kind: "standing", dimensionsCm: { width: 10, height: 20, depth: 10 },
  pixelsPerCm: 2, widthPixelsPerCm: 3,
  pose: { cameraElevationDegrees: 30, cameraRollDegrees: 0 },
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
