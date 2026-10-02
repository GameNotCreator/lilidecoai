import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { compositeObjectsOnScene, padCompositionForAspect } from "../lib/server/simple-composite";
import { perspectiveEditComposition, restorePerspectiveBackground } from "../lib/server/storefront-realistic-composite";

async function fixture() {
  const room = await sharp({ create: { width: 160, height: 120, channels: 3, background: "#526578" } }).webp({ lossless: true }).toBuffer();
  const cutout = await sharp({ create: { width: 20, height: 40, channels: 4, background: "#aa4400" } }).png().toBuffer();
  return compositeObjectsOnScene(room, 160, 120, [{ cutout, point: { x: 0.5, y: 0.8 },
    dimensions: { mode: "height_length", heightCm: 20, lengthCm: 10 }, pixelsPerCm: 2, kind: "standing" }], { lighting: null });
}

describe("local perspective editing", () => {
  it("expands the editable silhouette and leaves the old composition mask untouched", async () => {
    const original = await fixture();
    const before = Buffer.from(original.maskRaw);
    const local = perspectiveEditComposition(original);
    expect(original.maskRaw).toEqual(before);
    const placement = original.placements[0]!;
    const x = placement.left + Math.floor(placement.widthPx / 2);
    const y = Math.max(0, placement.top - 10);
    expect(local.maskRaw[(y * 160 + x) * 4 + 3]).toBe(0);
    expect(local.maskRaw[3]).toBe(255);
  });

  it("keeps the newly generated pose without re-stamping the catalogue and restores every protected pixel", async () => {
    const local = perspectiveEditComposition(await fixture());
    const padded = await padCompositionForAspect(local, "1536x1024");
    const generated = await sharp({ create: { width: padded.paddedWidth, height: padded.paddedHeight, channels: 3, background: "#0099ee" } }).png().toBuffer();
    const output = await sharp(await restorePerspectiveBackground(local, padded, generated)).removeAlpha().raw().toBuffer();
    const room = await sharp(local.sceneWebp!).removeAlpha().raw().toBuffer();
    let protectedPixels = 0;
    for (let pixel = 0; pixel < 160 * 120; pixel++) {
      if (local.maskRaw[pixel * 4 + 3] !== 255) continue;
      expect(output.subarray(pixel * 3, pixel * 3 + 3)).toEqual(room.subarray(pixel * 3, pixel * 3 + 3));
      protectedPixels++;
    }
    expect(protectedPixels).toBeGreaterThan(10_000);
    const centre = (75 * 160 + 80) * 3;
    expect([...output.subarray(centre, centre + 3)]).toEqual([0, 153, 238]);
  });

  it("removes letterbox padding before restoring the scene", async () => {
    const local = perspectiveEditComposition(await fixture());
    const padded = await padCompositionForAspect(local, "1024x1536");
    const generated = await sharp({ create: { width: padded.paddedWidth, height: padded.paddedHeight, channels: 3, background: "#ff0000" } })
      .composite([{ input: await sharp({ create: { width: 160, height: 120, channels: 3, background: "#00ee44" } }).png().toBuffer(), left: padded.offsetX, top: padded.offsetY }]).png().toBuffer();
    const output = await sharp(await restorePerspectiveBackground(local, padded, generated)).removeAlpha().raw().toBuffer();
    expect([...output.subarray((75 * 160 + 80) * 3, (75 * 160 + 80) * 3 + 3)]).toEqual([0, 238, 68]);
    expect(await sharp(await restorePerspectiveBackground(local, padded, generated)).metadata()).toMatchObject({ width: 160, height: 120 });
  });

  it("fails closed when the original room or mask is missing", async () => {
    const local = perspectiveEditComposition(await fixture());
    const padded = await padCompositionForAspect(local, "1536x1024");
    await expect(restorePerspectiveBackground({ ...local, sceneWebp: undefined }, padded, padded.imageWebp)).rejects.toThrow();
    await expect(restorePerspectiveBackground({ ...local, maskRaw: Buffer.alloc(1) }, padded, padded.imageWebp)).rejects.toThrow();
  });
});
