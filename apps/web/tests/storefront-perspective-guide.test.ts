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
async function poseFixture(): Promise<StorefrontPerspectiveGuideInput> {
  return {
    room: await sharp({ create: { width: 240, height: 240, channels: 3, background: "#526578" } }).webp({ lossless: true }).toBuffer(),
    width: 240, height: 240,
    objects: [{ ...object(), dimensionsCm: { width: 40, height: 40, depth: 30 } }],
  };
}
const at = (data: Buffer, width: number, x: number, y: number) =>
  [...data.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)];
const isBlueGuide = (pixel: number[]) =>
  pixel[0]! < 70 && pixel[1]! >= 100 && pixel[1]! < 140 && pixel[2]! > 135;
const isGreenGuide = (pixel: number[]) =>
  pixel[0]! < 70 && pixel[1]! > 110 && pixel[2]! < 120;

describe("storefront geometry guide", () => {
  it("keeps historical guide bytes when horizontal scale is absent, undefined or identical", async () => {
    const input = await fixture();
    const historical = await buildStorefrontPerspectiveGuide(input);
    expect(await buildStorefrontPerspectiveGuide({ ...input, objects: [{ ...object(), widthPixelsPerCm: undefined }] })).toEqual(historical);
    expect(await buildStorefrontPerspectiveGuide({ ...input, objects: [{ ...object(), widthPixelsPerCm: object().pixelsPerCm }] })).toEqual(historical);
  });

  it("uses horizontal scale for width/top-depth and keeps physical upright height on its own axis", async () => {
    const input = await poseFixture();
    const pixels = await sharp(await buildStorefrontPerspectiveGuide({
      ...input, objects: [{ ...object(), dimensionsCm: { width: 20, height: 20, depth: 20 },
        widthPixelsPerCm: 4, pose: { cameraElevationDegrees: 30, cameraRollDegrees: 0 } }],
    })).removeAlpha().raw().toBuffer();
    // Width=80, upright height=40, projected top-depth=40, contact=(120,192).
    expect(isBlueGuide(at(pixels, 240, 80, 170))).toBe(true);
    expect(isBlueGuide(at(pixels, 240, 160, 170))).toBe(true);
    expect(isBlueGuide(at(pixels, 240, 120, 112))).toBe(true);
    expect(isBlueGuide(at(pixels, 240, 120, 152))).toBe(true);
    expect(isGreenGuide(at(pixels, 240, 169, 170))).toBe(true);
    expect(at(pixels, 240, 169, 130)).toEqual([82, 101, 120]);
    expect(at(pixels, 240, 120, 192)).toEqual([229, 35, 43]);
  });

  it.each([0, -1, NaN, Infinity, null, 1e308])("rejects invalid optional horizontal scale (%s)", async widthPixelsPerCm => {
    const input = await poseFixture();
    await expect(buildStorefrontPerspectiveGuide({ ...input, objects: [{ ...input.objects[0]!, widthPixelsPerCm }] } as unknown as StorefrontPerspectiveGuideInput)).rejects.toThrow();
  });

  it("marks the exact standing contact without moving it to a silhouette corner", async () => {
    const input = await fixture();
    const before = Buffer.from(input.room);
    const guide = await buildStorefrontPerspectiveGuide(input);
    expect(STOREFRONT_GUIDED_REALISTIC_COMPOSITE_VERSION).toBe("storefront-guided-perspective-v3");
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

  it("shows no top-face depth at zero elevation and an elliptical top at 60 degrees", async () => {
    const input = await poseFixture();
    const guideAtElevation = async (cameraElevationDegrees: number) =>
      sharp(await buildStorefrontPerspectiveGuide({
        ...input,
        objects: [{ ...input.objects[0]!, pose: { cameraElevationDegrees, cameraRollDegrees: 0 } }],
      })).removeAlpha().raw().toBuffer();
    const level = await guideAtElevation(0);
    const elevated = await guideAtElevation(60);
    // 80 px physical front-body height: top front edge y=112. A 60 px depth
    // at 60 degrees adds an ellipse of 52 px depth entirely above that edge.
    expect(isBlueGuide(at(level, 240, 120, 112))).toBe(true);
    expect(at(level, 240, 120, 60)).toEqual([82, 101, 120]);
    expect(isBlueGuide(at(elevated, 240, 120, 60))).toBe(true);
    expect(isBlueGuide(at(elevated, 240, 120, 112))).toBe(true);
    expect(isGreenGuide(at(level, 240, 169, 140))).toBe(true);
    expect(isGreenGuide(at(elevated, 240, 169, 140))).toBe(true);
    expect(at(elevated, 240, 120, 125)).toEqual([82, 101, 120]);
    expect(at(elevated, 240, 120, 192)).toEqual([229, 35, 43]);
  });

  it("scales the top ellipse from physical depth while keeping body height separate", async () => {
    const input = await poseFixture();
    const pixels = await sharp(await buildStorefrontPerspectiveGuide({
      ...input,
      objects: [{ ...input.objects[0]!, pose: { cameraElevationDegrees: 30, cameraRollDegrees: 0 } }],
    })).removeAlpha().raw().toBuffer();
    // sin(30 degrees) projects 60 px depth to 30 px, from y=82 to y=112.
    expect(isBlueGuide(at(pixels, 240, 120, 82))).toBe(true);
    expect(isBlueGuide(at(pixels, 240, 120, 112))).toBe(true);
    expect(at(pixels, 240, 120, 60)).toEqual([82, 101, 120]);
    expect(isBlueGuide(at(pixels, 240, 80, 160))).toBe(true);
    expect(isBlueGuide(at(pixels, 240, 160, 160))).toBe(true);
  });

  it("rotates the volume and height guide clockwise at 10 degrees around the fixed contact", async () => {
    const input = await poseFixture();
    const makeGuide = (cameraRollDegrees: number) => buildStorefrontPerspectiveGuide({
      ...input,
      objects: [{ ...input.objects[0]!, pose: { cameraElevationDegrees: 0, cameraRollDegrees } }],
    });
    const neutral = await sharp(await makeGuide(0)).removeAlpha().raw().toBuffer();
    const rolled = await sharp(await makeGuide(10)).removeAlpha().raw().toBuffer();
    expect(at(neutral, 240, 120, 192)).toEqual([229, 35, 43]);
    expect(at(rolled, 240, 120, 192)).toEqual([229, 35, 43]);
    // The body's top centre and the height guide both lean right when rising.
    expect(at(neutral, 240, 134, 113)).toEqual([82, 101, 120]);
    expect(isBlueGuide(at(rolled, 240, 134, 113))).toBe(true);
    expect(isGreenGuide(at(rolled, 240, 182, 122))).toBe(true);
    expect(at(neutral, 240, 182, 122)).toEqual([82, 101, 120]);
  });

  it("keeps unknown elevation without a top ellipse and unknown roll in a neutral orientation", async () => {
    const input = await poseFixture();
    const makeGuide = (cameraRollDegrees: number | null) => buildStorefrontPerspectiveGuide({
      ...input,
      objects: [{ ...input.objects[0]!, pose: { cameraElevationDegrees: null, cameraRollDegrees } }],
    });
    const unknown = await makeGuide(null);
    expect(unknown).toEqual(await makeGuide(0));
    const pixels = await sharp(unknown).removeAlpha().raw().toBuffer();
    expect(at(pixels, 240, 120, 86)).toEqual([82, 101, 120]);
    expect(isBlueGuide(at(pixels, 240, 120, 112))).toBe(true);
    expect(input.objects[0]!.pose).toBeUndefined();
  });

  it.each(["wall", "flat"] as const)("ignores camera pose for %s geometry", async (kind) => {
    const input = await fixture();
    const objectWithoutPose = { ...object(), kind };
    expect(await buildStorefrontPerspectiveGuide({
      ...input,
      objects: [{ ...objectWithoutPose, pose: { cameraElevationDegrees: 60, cameraRollDegrees: 10 } }],
    })).toEqual(await buildStorefrontPerspectiveGuide({ ...input, objects: [objectWithoutPose] }));
  });

  it.each([
    { cameraElevationDegrees: 0, cameraRollDegrees: -30 },
    { cameraElevationDegrees: 85, cameraRollDegrees: 30 },
    { cameraElevationDegrees: null, cameraRollDegrees: null },
    { cameraElevationDegrees: 60, cameraRollDegrees: null },
    { cameraElevationDegrees: null, cameraRollDegrees: 10 },
  ])("accepts nullable pose angles and their boundaries (%j)", async (pose) => {
    const input = await fixture();
    await expect(buildStorefrontPerspectiveGuide({ ...input, objects: [{ ...object(), pose }] }))
      .resolves.toBeInstanceOf(Buffer);
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
    { objects: [{ ...object(), pose: null }] },
    { objects: [{ ...object(), pose: {} }] },
    { objects: [{ ...object(), pose: { cameraElevationDegrees: -0.1, cameraRollDegrees: 0 } }] },
    { objects: [{ ...object(), pose: { cameraElevationDegrees: 85.1, cameraRollDegrees: 0 } }] },
    { objects: [{ ...object(), pose: { cameraElevationDegrees: NaN, cameraRollDegrees: 0 } }] },
    { objects: [{ ...object(), pose: { cameraElevationDegrees: Infinity, cameraRollDegrees: 0 } }] },
    { objects: [{ ...object(), pose: { cameraElevationDegrees: "60", cameraRollDegrees: 0 } }] },
    { objects: [{ ...object(), pose: { cameraElevationDegrees: 60, cameraRollDegrees: -30.1 } }] },
    { objects: [{ ...object(), pose: { cameraElevationDegrees: 60, cameraRollDegrees: 30.1 } }] },
    { objects: [{ ...object(), pose: { cameraElevationDegrees: 60, cameraRollDegrees: NaN } }] },
    { objects: [{ ...object(), pose: { cameraElevationDegrees: 60, cameraRollDegrees: Infinity } }] },
    { objects: [{ ...object(), kind: "wall", pose: { cameraElevationDegrees: 90, cameraRollDegrees: 0 } }] },
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
