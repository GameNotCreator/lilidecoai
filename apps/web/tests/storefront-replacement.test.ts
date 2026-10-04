import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { confirmedReplacementRemovalFrame, confirmedReplacementRemovalPrompt } from "../lib/server/storefront-replacement";
import { restoreRoomIntegrationBackground } from "../lib/server/storefront-room-integration";

const width = 160, height = 120;
const region = { xMin: 0.275, yMin: 0.595, xMax: 0.445, yMax: 0.86 };
async function roomFixture() {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 3;
    raw[offset] = x; raw[offset + 1] = y; raw[offset + 2] = 100;
  }
  return { raw, photo: await sharp(raw, { raw: { width, height, channels: 3 } }).webp({ lossless: true }).toBuffer() };
}

describe("confirmed full-frame replacement cleanup", () => {
  it("uses the unmodified full photograph and exact user rectangle with no catalogue, crop or canvas inset", async () => {
    const { photo } = await roomFixture();
    const { composition, padded } = await confirmedReplacementRemovalFrame(photo, width, height, region);
    expect(composition.imageWebp).toBe(photo);
    expect(composition.overlays).toEqual([]);
    expect(composition.placements).toEqual([]);
    expect(padded).toMatchObject({ paddedWidth: width, paddedHeight: height, offsetX: 0, offsetY: 0, padded: false });
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const inside = x >= Math.floor(region.xMin * width) && x < Math.ceil(region.xMax * width) &&
        y >= Math.floor(region.yMin * height) && y < Math.ceil(region.yMax * height);
      expect(composition.maskRaw[(y * width + x) * 4 + 3]).toBe(inside ? 0 : 255);
    }
  });

  it("maps a uniformly enlarged full-room output once and preserves every exterior RGB pixel", async () => {
    const { raw, photo } = await roomFixture();
    const { composition, padded } = await confirmedReplacementRemovalFrame(photo, width, height, region);
    const generatedRaw = Buffer.from(raw);
    for (let pixel = 0; pixel < width * height; pixel++) generatedRaw[pixel * 3 + 2] = 240;
    const generated = await sharp(generatedRaw, { raw: { width, height, channels: 3 } })
      .resize({ width: width * 2, kernel: "nearest" }).png().toBuffer();
    const output = await sharp(await restoreRoomIntegrationBackground(composition, padded, generated)).raw().toBuffer();
    let exteriorDifferences = 0;
    for (let pixel = 0; pixel < width * height; pixel++)
      if (composition.maskRaw[pixel * 4 + 3] === 255 && !output.subarray(pixel * 3, pixel * 3 + 3).equals(raw.subarray(pixel * 3, pixel * 3 + 3))) exteriorDifferences++;
    expect(exteriorDifferences).toBe(0);
    // The selected support remains at its original room coordinates. A full
    // room squeezed into the removal box would sample a different x/y here.
    const x = 58, y = 96, offset = (y * width + x) * 3;
    expect(Math.abs(output[offset]! - x)).toBeLessThanOrEqual(1);
    expect(Math.abs(output[offset + 1]! - y)).toBeLessThanOrEqual(1);
    expect(output[offset + 2]).toBe(240);
  });

  it("rejects a local crop or a transparent provider image instead of interpreting it as a full room", async () => {
    const { photo } = await roomFixture();
    const { composition, padded } = await confirmedReplacementRemovalFrame(photo, width, height, region);
    const crop = await sharp(photo).extract({ left: 44, top: 71, width: 28, height: 33 }).png().toBuffer();
    await expect(restoreRoomIntegrationBackground(composition, padded, crop)).rejects.toThrow();
    const transparent = await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    await expect(restoreRoomIntegrationBackground(composition, padded, transparent)).rejects.toThrow("opaque");
    await expect(confirmedReplacementRemovalFrame(photo, width + 1, height, region)).rejects.toThrow();
  });

  it("caps the user region and describes original-frame removal without asking for insertion or a new photograph", async () => {
    const { photo } = await roomFixture();
    await expect(confirmedReplacementRemovalFrame(photo, width, height, { xMin: 0, yMin: 0, xMax: 1, yMax: 1 })).rejects.toThrow();
    const prompt = confirmedReplacementRemovalPrompt({ region, frame: { width, height } });
    expect(prompt).toContain(JSON.stringify(region));
    expect(prompt).toContain("160 x 120 pixels");
    expect(prompt).toContain("full room, not a crop or an inset canvas");
    expect(prompt).toContain("adds no new product");
    expect(prompt).toContain("floorboards, texture, perspective");
    expect(prompt).toContain("Do not resize or paste a miniature room");
  });
});
