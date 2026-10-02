import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  buildStorefrontPerspectiveGuide,
  type StorefrontPerspectiveGuideObject,
} from "../lib/server/storefront-perspective-guide";
import { localiseStorefrontPerspectiveGuide } from "../lib/server/storefront-perspective-guide-window";
import type { StorefrontScaleReference } from "../lib/server/ai/storefront-placement-review";

type WindowInput = Parameters<typeof localiseStorefrontPerspectiveGuide>[0];
type WindowResult = Awaited<ReturnType<typeof localiseStorefrontPerspectiveGuide>>;
const background = [85, 102, 119] as const;
const object = (overrides: Partial<StorefrontPerspectiveGuideObject> = {}): StorefrontPerspectiveGuideObject => ({
  index: 0,
  point: { x: 0.5, y: 0.75 },
  kind: "standing",
  dimensionsCm: { width: 40, height: 60, depth: 20 },
  pixelsPerCm: 1,
  ...overrides,
});

async function fixture(
  objects: readonly StorefrontPerspectiveGuideObject[] = [object()],
  reference?: StorefrontScaleReference,
  patterned = false,
): Promise<WindowInput> {
  const width = 600;
  const height = 480;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      pixels[offset] = patterned ? x % 251 : background[0];
      pixels[offset + 1] = patterned ? y % 253 : background[1];
      pixels[offset + 2] = patterned ? (x + y) % 255 : background[2];
    }
  }
  const room = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
  const guide = await buildStorefrontPerspectiveGuide({ room, width, height, objects, reference });
  return { guide, width, height, objects, ...(reference ? { reference } : {}) };
}

async function expectExactCrop(input: WindowInput, result: WindowResult) {
  expect(result.originalFrame).toEqual({ width: input.width, height: input.height });
  expect(result.window.left).toBeGreaterThanOrEqual(0);
  expect(result.window.top).toBeGreaterThanOrEqual(0);
  expect(result.window.left + result.window.width).toBeLessThanOrEqual(input.width);
  expect(result.window.top + result.window.height).toBeLessThanOrEqual(input.height);
  expect(await sharp(result.image).metadata()).toMatchObject({
    format: "webp", width: result.window.width, height: result.window.height,
  });
  const expected = await sharp(input.guide).extract(result.window).removeAlpha().raw().toBuffer();
  const actual = await sharp(result.image).removeAlpha().raw().toBuffer();
  expect(actual).toEqual(expected);
  return actual;
}

async function expectAnnotationsIncluded(input: WindowInput, result: WindowResult) {
  const pixels = await sharp(input.guide).removeAlpha().raw().toBuffer();
  let left = input.width;
  let top = input.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < input.height; y++) {
    for (let x = 0; x < input.width; x++) {
      const offset = (y * input.width + x) * 3;
      if (pixels[offset] === background[0] && pixels[offset + 1] === background[1] && pixels[offset + 2] === background[2]) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  expect(right).toBeGreaterThanOrEqual(left);
  expect(result.window.left).toBeLessThanOrEqual(left);
  expect(result.window.top).toBeLessThanOrEqual(top);
  expect(result.window.left + result.window.width).toBeGreaterThan(right);
  expect(result.window.top + result.window.height).toBeGreaterThan(bottom);
}

describe("localised storefront perspective guide", () => {
  it("crops the original pixels losslessly without changing the frame or inputs", async () => {
    const input = await fixture([object()], undefined, true);
    const before = Buffer.from(input.guide);
    const objectsBefore = structuredClone(input.objects);
    const result = await localiseStorefrontPerspectiveGuide(input);
    expect(result.window.width).toBeLessThan(input.width);
    expect(result.window.height).toBeLessThan(input.height);
    const pixels = await expectExactCrop(input, result);
    const anchorX = 300 - result.window.left;
    const anchorY = 360 - result.window.top;
    const offset = (anchorY * result.window.width + anchorX) * 3;
    expect([...pixels.subarray(offset, offset + 3)]).toEqual([229, 35, 43]);
    expect(input.guide).toEqual(before);
    expect(input.objects).toEqual(objectsBefore);
  });

  it("retains height text and the original selection label beyond a tiny physical volume", async () => {
    const input = await fixture([object({ index: 2, dimensionsCm: { width: 1, height: 1, depth: 1 }, pixelsPerCm: 2 })]);
    const result = await localiseStorefrontPerspectiveGuide(input);
    await expectAnnotationsIncluded(input, result);
    await expectExactCrop(input, result);
    // The 2 px volume alone cannot contain the marker, label 3 and '2 px' text.
    expect(result.window.width).toBeGreaterThan(20);
    expect(result.window.height).toBeGreaterThan(12);
  });

  it("keeps a context margin of at least 70% of the largest physical extent", async () => {
    const input = await fixture();
    const result = await localiseStorefrontPerspectiveGuide(input);
    const margin = 60 * 0.7;
    expect(result.window.left).toBeLessThanOrEqual(280 - margin);
    expect(result.window.top).toBeLessThanOrEqual(300 - margin);
    expect(result.window.left + result.window.width).toBeGreaterThanOrEqual(320 + margin);
    expect(result.window.top + result.window.height).toBeGreaterThanOrEqual(360 + margin);
  });

  it("unions all three objects while preserving repeated geometry and original indices", async () => {
    const input = await fixture([
      object({ index: 2, point: { x: 0.2, y: 0.8 } }),
      object({ index: 0, point: { x: 0.5, y: 0.8 } }),
      object({ index: 1, point: { x: 0.8, y: 0.8 } }),
    ]);
    const result = await localiseStorefrontPerspectiveGuide(input);
    await expectAnnotationsIncluded(input, result);
    const pixels = await expectExactCrop(input, result);
    for (const x of [120, 300, 480]) {
      const offset = ((384 - result.window.top) * result.window.width + x - result.window.left) * 3;
      expect([...pixels.subarray(offset, offset + 3)]).toEqual([229, 35, 43]);
    }
    expect(result.window.left).toBeLessThan(100);
    expect(result.window.left + result.window.width).toBeGreaterThan(500);
  });

  it.each([-30, 30])("includes the high top ellipse and rotated volume, height line and text at roll %s", async (roll) => {
    const input = await fixture([object({
      dimensionsCm: { width: 40, height: 90, depth: 80 },
      pose: { cameraElevationDegrees: 85, cameraRollDegrees: roll },
    })]);
    const result = await localiseStorefrontPerspectiveGuide(input);
    await expectAnnotationsIncluded(input, result);
    await expectExactCrop(input, result);
    // The top face extends above the body, rather than consuming body height.
    expect(result.window.top).toBeLessThan(360 - 90 - 50);
  });

  it("includes the optional reference line and both three-digit reference labels", async () => {
    const input = await fixture([object({ point: { x: 0.7, y: 0.8 } })], {
      realHeightCm: 75, sameDepthConfirmed: true,
      basePoint: { x: 0.15, y: 0.9 }, topPoint: { x: 0.12, y: 0.25 },
    });
    const result = await localiseStorefrontPerspectiveGuide(input);
    await expectAnnotationsIncluded(input, result);
    const pixels = await expectExactCrop(input, result);
    for (const [x, y] of [[90, 432], [72, 120]]) {
      const offset = ((y! - result.window.top) * result.window.width + x! - result.window.left) * 3;
      expect([...pixels.subarray(offset, offset + 3)]).toEqual([123, 64, 170]);
    }
  });

  it("returns the original buffer when the clamped window covers the full frame", async () => {
    const input = await fixture([object({ dimensionsCm: { width: 1_000, height: 1_000, depth: 1_000 } })]);
    const result = await localiseStorefrontPerspectiveGuide(input);
    expect(result.window).toEqual({ left: 0, top: 0, width: 600, height: 480 });
    expect(result.image).toBe(input.guide);
    await expectExactCrop(input, result);
  });

  it.each([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: 1, y: 0 }])("clamps edge coordinates and retains every visible annotation at %j", async (point) => {
    const input = await fixture([object({ point })]);
    const result = await localiseStorefrontPerspectiveGuide(input);
    await expectAnnotationsIncluded(input, result);
    await expectExactCrop(input, result);
    if (point.x === 0) expect(result.window.left).toBe(0);
    else expect(result.window.left + result.window.width).toBe(input.width);
    if (point.y === 0) expect(result.window.top).toBe(0);
    else expect(result.window.top + result.window.height).toBe(input.height);
  });

  it("keeps unknown standing pose usable without inventing an ellipse", async () => {
    const input = await fixture([object({ pose: { cameraElevationDegrees: null, cameraRollDegrees: null } })]);
    const result = await localiseStorefrontPerspectiveGuide(input);
    await expectAnnotationsIncluded(input, result);
    await expectExactCrop(input, result);
  });

  it.each(["flat", "wall"] as const)("ignores camera pose when cropping a %s guide", async (kind) => {
    const input = await fixture([object({ kind })]);
    const posed = await fixture([object({ kind, pose: { cameraElevationDegrees: 85, cameraRollDegrees: 30 } })]);
    const result = await localiseStorefrontPerspectiveGuide(input);
    const withPose = await localiseStorefrontPerspectiveGuide(posed);
    expect(withPose.window).toEqual(result.window);
    expect(withPose.image).toEqual(result.image);
    await expectAnnotationsIncluded(input, result);
  });

  it.each([90, 1_000])("uniformly fits the unchanged crop inside maxDimension %s, including enlargement", async (maxDimension) => {
    const input = await fixture();
    const original = await localiseStorefrontPerspectiveGuide(input);
    const resized = await localiseStorefrontPerspectiveGuide({ ...input, maxDimension });
    expect(resized.window).toEqual(original.window);
    expect(resized.originalFrame).toEqual(original.originalFrame);
    const metadata = await sharp(resized.image).metadata();
    expect(metadata.format).toBe("webp");
    expect(Math.max(metadata.width!, metadata.height!)).toBe(maxDimension);
    const scale = maxDimension / Math.max(original.window.width, original.window.height);
    expect(Math.abs(metadata.width! - original.window.width * scale)).toBeLessThanOrEqual(1);
    expect(Math.abs(metadata.height! - original.window.height * scale)).toBeLessThanOrEqual(1);
  });

  it.each([
    { width: 0 }, { width: 600.5 }, { height: Infinity },
    { guide: Buffer.alloc(0) }, { guide: new Uint8Array([1]) },
    { objects: [] }, { objects: [object(), object(), object(), object()] },
    { objects: [object(), object()] },
    { objects: [object({ index: 3 })] }, { objects: [object({ index: 0.5 })] },
    { objects: [object({ point: { x: -0.01, y: 0.5 } })] },
    { objects: [object({ point: { x: 0.5, y: NaN } })] },
    { objects: [object({ point: { x: 1.01, y: 0.5 } })] },
    { objects: [object({ pixelsPerCm: 0 })] }, { objects: [object({ pixelsPerCm: Infinity })] },
    { objects: [object({ pixelsPerCm: 1e308 })] },
    { objects: [object({ dimensionsCm: { width: 0, height: 60, depth: 20 } })] },
    { objects: [object({ dimensionsCm: { width: 40, height: NaN, depth: 20 } })] },
    { objects: [{ ...object(), kind: "ceiling" }] },
    { objects: [{ ...object(), pose: null }] }, { objects: [{ ...object(), pose: {} }] },
    { objects: [object({ pose: { cameraElevationDegrees: -0.1, cameraRollDegrees: 0 } })] },
    { objects: [object({ pose: { cameraElevationDegrees: 85.1, cameraRollDegrees: 0 } })] },
    { objects: [object({ pose: { cameraElevationDegrees: NaN, cameraRollDegrees: 0 } })] },
    { objects: [object({ pose: { cameraElevationDegrees: 60, cameraRollDegrees: -30.1 } })] },
    { objects: [object({ pose: { cameraElevationDegrees: 60, cameraRollDegrees: 30.1 } })] },
    { objects: [object({ pose: { cameraElevationDegrees: null, cameraRollDegrees: Infinity } })] },
    { maxDimension: 0 }, { maxDimension: 10.5 }, { maxDimension: NaN },
    { reference: { realHeightCm: 0, sameDepthConfirmed: true, basePoint: { x: 0.1, y: 0.8 }, topPoint: { x: 0.1, y: 0.4 } } },
    { reference: { realHeightCm: 75, sameDepthConfirmed: false, basePoint: { x: 0.1, y: 0.8 }, topPoint: { x: 0.1, y: 0.4 } } },
    { reference: { realHeightCm: 75, sameDepthConfirmed: true, basePoint: { x: 0.1, y: 0.8 }, topPoint: { x: 0.1, y: 0.8 } } },
  ])("rejects malformed localisation input (%j)", async (invalid) => {
    const input = { ...await fixture(), ...invalid } as unknown as WindowInput;
    await expect(localiseStorefrontPerspectiveGuide(input)).rejects.toThrow();
  });

  it("rejects unreadable image bytes and declared dimensions that disagree with the guide", async () => {
    const input = await fixture();
    await expect(localiseStorefrontPerspectiveGuide({ ...input, guide: Buffer.from("not an image") })).rejects.toThrow();
    await expect(localiseStorefrontPerspectiveGuide({ ...input, width: 599 })).rejects.toThrow();
  });
});
