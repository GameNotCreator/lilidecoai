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

  it("adds exact supported-ratio borders to a full 736x552 room without resizing it or changing original removal pixels", async () => {
    const sourceWidth = 736, sourceHeight = 552;
    const photo = await sharp({ create: { width: sourceWidth, height: sourceHeight, channels: 3, background: "#456789" } }).webp({ lossless: true }).toBuffer();
    const { composition, padded, inputRegion } = await confirmedReplacementRemovalFrame(photo, sourceWidth, sourceHeight, region, { requestedSize: "1536x1024" });
    expect(padded).toMatchObject({ paddedWidth: 828, paddedHeight: 552, offsetX: 46, offsetY: 0, padded: true });
    const decodedRoom = await sharp(photo).raw().toBuffer();
    const roomWindow = { left: 46, top: 0, width: sourceWidth, height: sourceHeight };
    expect(await sharp(padded.imageWebp).extract(roomWindow).raw().toBuffer()).toEqual(decodedRoom);
    expect(await sharp(padded.maskPng).extract(roomWindow).raw().toBuffer()).toEqual(composition.maskRaw);
    expect(inputRegion).toEqual({ xMin: (region.xMin * sourceWidth + 46) / 828, xMax: (region.xMax * sourceWidth + 46) / 828,
      yMin: region.yMin, yMax: region.yMax });
    const prompt = confirmedReplacementRemovalPrompt({ region: inputRegion, frame: { width: 828, height: 552 }, originalRoomWindow: roomWindow });
    expect(prompt).toContain(JSON.stringify(inputRegion));
    expect(prompt).toContain("ALREADY been converted to this INPUT canvas");
    expect(prompt).toContain("Do not crop these borders");
  });

  it("keeps v10 strict on a nearly matching raster and v11 restoration aligned at the supported provider ratio", async () => {
    const photo = await sharp({ create: { width: 736, height: 552, channels: 3, background: "#456789" } }).webp({ lossless: true }).toBuffer();
    const historical = await confirmedReplacementRemovalFrame(photo, 736, 552, region);
    // A raster-grid example that passes the adapter's historical +/-2%
    // aspect check but cannot share the restoration's uniform half-pixel map.
    const approximate = await sharp({ create: { width: 1368, height: 1024, channels: 3, background: "#008800" } }).webp({ lossless: true }).toBuffer();
    expect(Math.abs((1368 / 1024) / (736 / 552) - 1)).toBeLessThan(0.02);
    await expect(restoreRoomIntegrationBackground(historical.composition, historical.padded, approximate)).rejects.toThrow();
    const current = await confirmedReplacementRemovalFrame(photo, 736, 552, region, { requestedSize: "1536x1024" });
    const generated = await sharp({ create: { width: 1536, height: 1024, channels: 3, background: "#008800" } }).webp({ lossless: true }).toBuffer();
    const restored = await sharp(await restoreRoomIntegrationBackground(current.composition, current.padded, generated)).raw().toBuffer();
    const before = await sharp(photo).raw().toBuffer();
    let exteriorDifferences = 0;
    for (let pixel = 0; pixel < 736 * 552; pixel++)
      if (current.composition.maskRaw[pixel * 4 + 3] === 255 && !restored.subarray(pixel * 3, pixel * 3 + 3).equals(before.subarray(pixel * 3, pixel * 3 + 3))) exteriorDifferences++;
    expect(exteriorDifferences).toBe(0);
    expect([...restored.subarray((400 * 736 + 265) * 3, (400 * 736 + 265) * 3 + 3)]).toEqual([0, 136, 0]);
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
