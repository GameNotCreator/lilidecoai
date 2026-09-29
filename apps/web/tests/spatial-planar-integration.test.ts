import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
vi.mock("server-only", () => ({}));
import { integratePlanarLighting } from "../lib/server/spatial-planar-integration";
import { spatialInteractionMask } from "../lib/server/spatial-interaction-mask";

const width = 96,
  height = 96;
const encode = (data: Buffer, channels: 1 | 3) =>
  sharp(data, { raw: { width, height, channels } }).png().toBuffer();
const raw = (data: Buffer) => sharp(data).removeAlpha().raw().toBuffer();
async function fixture() {
  const room = Buffer.alloc(width * height * 3, 120);
  const projected = Buffer.from(room),
    mask = Buffer.alloc(width * height),
    contact = Buffer.alloc(width * height);
  for (let y = 8; y < 88; y++)
    for (let x = 8; x < 88; x++) {
      const i = y * width + x;
      if (x < 20 || x >= 76 || y < 20 || y >= 76) {
        contact[i] = 255;
        continue;
      }
      mask[i] = 255;
      const color = x % 8 < 4 ? [180, 90, 45] : [40, 80, 160];
      color.forEach((v, c) => {
        projected[i * 3 + c] = v;
      });
    }
  return {
    room: await encode(room, 3),
    projected: await encode(projected, 3),
    textureMask: await encode(mask, 1),
    contactMask: contact,
    mask,
    pixels: projected,
  };
}
describe("bounded planar illumination", () => {
  it("joins the rug edge and fades generated darkening to unchanged room pixels", async () => {
    const rectangle = (x: number, y: number, w: number, h: number) => [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ];
    const f = await fixture();
    const footprint = rectangle(20, 20, 56, 56);
    const args = {
      width,
      height,
      volume: footprint,
      footprint,
      support: { boundary: rectangle(0, 0, 1, 1), holes: [], obstacles: [] },
      reflectiveRegions: [],
    };
    const generated = await encode(Buffer.alloc(width * height * 3), 3);
    const legacy = await spatialInteractionMask(args);
    const planar = await spatialInteractionMask({
      ...args,
      planarContact: true,
    });
    const old = await raw(
      await integratePlanarLighting({
        ...f,
        generated,
        contactMask: legacy.contactMask,
      }),
    );
    const output = await raw(
      await integratePlanarLighting({
        ...f,
        generated,
        contactMask: planar.contactMask,
        contactOpacity: planar.contactOpacity,
      }),
    );
    const at = (x: number) => (48 * width + x) * 3;
    expect(old[at(19)]).toBe(120); // gap between old volumetric mask and rug
    expect(output[at(19)]).toBe(78); // contact reaches the rug
    expect(output[at(6)]).toBe(120); // first allowed pixel: fully faded
    expect(output[at(7)]).toBeLessThan(120);
    expect(output[at(7)]).toBeGreaterThan(output[at(8)]!);
    for (let i = 0; i < width * height; i++) {
      if (!f.mask[i] && !planar.contactMask[i])
        expect([...output.subarray(i * 3, i * 3 + 3)]).toEqual([120, 120, 120]);
      if (f.mask[i])
        expect(output.subarray(i * 3, i * 3 + 3)).toEqual(
          old.subarray(i * 3, i * 3 + 3),
        );
    }
  });
  it("relights only the foreground contribution of a semi-transparent texture", async () => {
    const f = await fixture();
    const mask = Buffer.alloc(width * height, 128);
    const projected = Buffer.alloc(width * height * 3, 150);
    const output = await raw(
      await integratePlanarLighting({
        ...f,
        projected: await encode(projected, 3),
        textureMask: await encode(mask, 1),
        generated: await encode(Buffer.alloc(width * height * 3), 3),
        contactMask: Buffer.alloc(width * height),
      }),
    );
    // ~180 foreground darkens to ~144; 120 room remains 120. Re-composite ~132.
    expect([...new Set(output)]).toEqual([132]);
  });
  it("preserves every protected room pixel and the original motif against hostile generated RGB", async () => {
    const f = await fixture();
    const hostile = Buffer.alloc(width * height * 3);
    for (let i = 0; i < width * height; i++)
      hostile[i * 3 + 1] = i % 2 ? 255 : 0;
    const output = await raw(
      await integratePlanarLighting({
        ...f,
        generated: await encode(hostile, 3),
      }),
    );
    for (let i = 0; i < width * height; i++) {
      if (f.mask[i]) {
        // Ratios, color family and each four-pixel motif edge survive; no green
        // generated pixels can replace red/blue catalogue samples.
        const factor = output[i * 3]! / f.pixels[i * 3]!;
        expect(factor).toBeGreaterThanOrEqual(0.79);
        expect(factor).toBeLessThanOrEqual(1.21);
        for (let c = 1; c < 3; c++)
          expect(
            Math.abs(output[i * 3 + c]! - f.pixels[i * 3 + c]! * factor),
          ).toBeLessThan(3);
      } else if (!f.contactMask[i]) {
        expect([...output.subarray(i * 3, i * 3 + 3)]).toEqual([120, 120, 120]);
      } else {
        expect(output[i * 3]).toBeGreaterThanOrEqual(78);
        expect(output[i * 3]).toBeLessThanOrEqual(120);
        expect(output[i * 3 + 1]).toBe(output[i * 3]);
        expect(output[i * 3 + 2]).toBe(output[i * 3]);
      }
    }
  });
  it("transfers uniform gains and contact shadows at their bounded limits", async () => {
    const f = await fixture();
    for (const [value, factor, shadow] of [
      [0, 0.8, 78],
      [255, 1.2, 120],
    ]) {
      const output = await raw(
        await integratePlanarLighting({
          ...f,
          generated: await encode(Buffer.alloc(width * height * 3, value), 3),
        }),
      );
      const center = (48 * width + 48) * 3;
      expect(output[center]).toBeCloseTo(f.pixels[center]! * factor!, 0);
      expect(output[(48 * width + 10) * 3]).toBe(shadow);
    }
  });
  it("does not allow an unaligned candidate or malformed contact mask", async () => {
    const f = await fixture();
    await expect(
      integratePlanarLighting({
        ...f,
        generated: await sharp(f.projected).resize(48, 48).png().toBuffer(),
      }),
    ).rejects.toThrow(/Dimensions/);
    await expect(
      integratePlanarLighting({
        ...f,
        generated: f.projected,
        contactMask: Buffer.alloc(1),
      }),
    ).rejects.toThrow(/Dimensions/);
    await expect(
      integratePlanarLighting({
        ...f,
        generated: f.projected,
        contactOpacity: Buffer.alloc(1),
      }),
    ).rejects.toThrow(/Dimensions/);
  });
});
