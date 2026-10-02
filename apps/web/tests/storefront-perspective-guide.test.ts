import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  buildStorefrontPerspectiveGuide,
  STOREFRONT_GUIDED_REALISTIC_COMPOSITE_VERSION,
  type StorefrontPerspectiveGuideInput,
} from "../lib/server/storefront-perspective-guide";

const object = () => ({
  index: 0,
  point: { x: 0.5, y: 0.8 },
  kind: "standing" as const,
  dimensionsCm: { width: 10, height: 20, depth: 7 },
  pixelsPerCm: 2,
});
async function fixture(): Promise<StorefrontPerspectiveGuideInput> {
  return {
    room: await sharp({ create: { width: 160, height: 120, channels: 3, background: "#526578" } }).webp({ lossless: true }).toBuffer(),
    width: 160, height: 120, objects: [object()],
  };
}
const at = (data: Buffer, width: number, x: number, y: number) =>
  [...data.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)];

describe("storefront geometry guide", () => {
  it("marks the exact standing contact without moving it to a silhouette corner", async () => {
    const input = await fixture();
    const before = Buffer.from(input.room);
    const guide = await buildStorefrontPerspectiveGuide(input);
    expect(STOREFRONT_GUIDED_REALISTIC_COMPOSITE_VERSION).toBe("storefront-guided-perspective-v2");
    expect(await sharp(guide).metadata()).toMatchObject({ format: "webp", width: 160, height: 120 });
    const pixels = await sharp(guide).removeAlpha().raw().toBuffer();
    expect(at(pixels, 160, 80, 96)).toEqual([229, 35, 43]);
    expect(input.room).toEqual(before);
    expect(input.objects).toEqual([object()]);
  });

  it("leaves the interior of the product box and unrelated room pixels untouched", async () => {
    const input = await fixture();
    const pixels = await sharp(await buildStorefrontPerspectiveGuide(input)).removeAlpha().raw().toBuffer();
    // A 20x40 px hint stands above the requested point; no product fills it.
    expect(at(pixels, 160, 75, 75)).toEqual([82, 101, 120]);
    expect(at(pixels, 160, 5, 5)).toEqual([82, 101, 120]);
    expect(at(pixels, 160, 150, 110)).toEqual([82, 101, 120]);
  });

  it("uses physical height for standing hints without adding top-face depth", async () => {
    const input = await fixture();
    const deeper = { ...object(), dimensionsCm: { width: 10, height: 20, depth: 70 } };
    expect(await buildStorefrontPerspectiveGuide({ ...input, objects: [deeper] })).toEqual(
      await buildStorefrontPerspectiveGuide(input),
    );
  });

  it.each(["wall", "flat"] as const)("centres the %s hint on the requested point", async (kind) => {
    const input = await fixture();
    const pixels = await sharp(await buildStorefrontPerspectiveGuide({
      ...input, objects: [{ ...object(), kind }],
    })).removeAlpha().raw().toBuffer();
    expect(at(pixels, 160, 80, 96)).toEqual([229, 35, 43]);
  });

  it("uses coordinates in the oriented photograph and refuses mismatched dimensions", async () => {
    const input = await fixture();
    const room = await sharp(input.room).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const guide = await buildStorefrontPerspectiveGuide({
      ...input, room, width: 120, height: 160,
      objects: [{ ...object(), point: { x: 0.5, y: 0.75 } }],
    });
    const pixels = await sharp(guide).removeAlpha().raw().toBuffer();
    expect(await sharp(guide).metadata()).toMatchObject({ width: 120, height: 160 });
    expect(at(pixels, 120, 60, 120)).toEqual([229, 35, 43]);
    await expect(buildStorefrontPerspectiveGuide({ ...input, room })).rejects.toThrow(/Dimensions/);
  });

  it("keeps edge contacts visible and marks an optional reference separately", async () => {
    const input = await fixture();
    const guide = await buildStorefrontPerspectiveGuide({
      ...input, objects: [{ ...object(), point: { x: 1, y: 1 } }],
      reference: { realHeightCm: 75, sameDepthConfirmed: true,
        basePoint: { x: 0.15, y: 0.8 }, topPoint: { x: 0.15, y: 0.45 } },
    });
    const pixels = await sharp(guide).removeAlpha().raw().toBuffer();
    expect(at(pixels, 160, 159, 119)).toEqual([229, 35, 43]);
    expect(at(pixels, 160, 24, 96)).toEqual([123, 64, 170]);
    expect(at(pixels, 160, 24, 54)).toEqual([123, 64, 170]);
  });

  it.each([
    { objects: [] },
    { objects: [object(), object(), object(), object()] },
    { objects: [object(), object()] },
    { objects: [{ ...object(), index: "<script>" }] },
    { objects: [{ ...object(), index: 3 }] },
    { objects: [{ ...object(), index: 0.5 }] },
    { objects: [{ ...object(), point: { x: NaN, y: 0.5 } }] },
    { objects: [{ ...object(), point: null }] },
    { objects: [{ ...object(), point: { x: -0.1, y: 0.5 } }] },
    { objects: [{ ...object(), kind: "ceiling" }] },
    { objects: [{ ...object(), pixelsPerCm: Infinity }] },
    { objects: [{ ...object(), pixelsPerCm: 0 }] },
    { objects: [{ ...object(), pixelsPerCm: 1e308 }] },
    { objects: [{ ...object(), dimensionsCm: { width: 0, height: 20, depth: 7 } }] },
    { objects: [{ ...object(), dimensionsCm: { width: 10, height: NaN, depth: 7 } }] },
    { width: 160.5 },
    { height: 0 },
    { room: Buffer.alloc(0) },
    { reference: { realHeightCm: 0, sameDepthConfirmed: true, basePoint: { x: 0.1, y: 0.8 }, topPoint: { x: 0.1, y: 0.4 } } },
    { reference: { realHeightCm: 75, sameDepthConfirmed: false, basePoint: { x: 0.1, y: 0.8 }, topPoint: { x: 0.1, y: 0.4 } } },
    { reference: { realHeightCm: 75, sameDepthConfirmed: true, basePoint: { x: 0.1, y: 0.8 }, topPoint: { x: 0.1, y: 0.8 } } },
  ])("rejects malformed geometry before building a guide (%j)", async (invalid) => {
    const input = { ...await fixture(), ...invalid } as unknown as StorefrontPerspectiveGuideInput;
    await expect(buildStorefrontPerspectiveGuide(input)).rejects.toThrow(/invalides|invalide/);
  });
});
