import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { composeStorefrontIsolatedProducts, STOREFRONT_ISOLATED_COMPOSITE_VERSION, type StorefrontIsolatedObject } from "../lib/server/storefront-isolated-composite";

const width = 160, height = 120;
const object = (overrides: Partial<StorefrontIsolatedObject> = {}): StorefrontIsolatedObject => ({
  index: 0, point: { x: 0.5, y: 0.8 }, kind: "standing",
  dimensionsCm: { width: 10, height: 20, depth: 10 }, pixelsPerCm: 2, ...overrides,
});
async function room() {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const pixel = (y * width + x) * 3;
    data[pixel] = x; data[pixel + 1] = y; data[pixel + 2] = (x + y) % 256;
  }
  return sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
}
async function generated(shapes: Array<{ left: number; top: number; width: number; height: number; color: [number, number, number]; alpha?: number }>, canvasWidth = 80, canvasHeight = 80) {
  const data = Buffer.alloc(canvasWidth * canvasHeight * 4);
  for (const shape of shapes) for (let y = shape.top; y < shape.top + shape.height; y++) for (let x = shape.left; x < shape.left + shape.width; x++) {
    const pixel = (y * canvasWidth + x) * 4;
    data[pixel] = shape.color[0]; data[pixel + 1] = shape.color[1]; data[pixel + 2] = shape.color[2]; data[pixel + 3] = shape.alpha ?? 255;
  }
  return sharp(data, { raw: { width: canvasWidth, height: canvasHeight, channels: 4 } }).png().toBuffer();
}
const rectangle = { left: 20, top: 20, width: 20, height: 40, color: [240, 10, 20] as [number, number, number] };
const compose = async (image: Buffer, objects = [object()]) => composeStorefrontIsolatedProducts({
  room: await room(), width, height, generated: image, objects,
});
const rgb = async (image: Buffer) => sharp(image).removeAlpha().raw().toBuffer();
const pixel = (data: Buffer, x: number, y: number) => [...data.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)];

describe("isolated source-alpha product composition", () => {
  it("declares the independent compositor contract", () => {
    expect(STOREFRONT_ISOLATED_COMPOSITE_VERSION).toBe("storefront-isolated-product-v4");
  });

  it("keeps every room pixel outside actual alpha exactly, including transparent holes within the box", async () => {
    const shape = await generated([rectangle, { left: 25, top: 30, width: 6, height: 10, color: [0, 0, 0], alpha: 0 }]);
    const result = await compose(shape);
    const original = await rgb(await room()), output = await rgb(result.image);
    const placed = result.placements[0]!;
    let unchanged = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const inBox = x >= placed.left && x < placed.left + placed.widthPx && y >= placed.top && y < placed.top + placed.heightPx;
      const inHole = x >= placed.left + 5 && x < placed.left + 11 && y >= placed.top + 10 && y < placed.top + 20;
      if (inBox && !inHole) continue;
      expect(pixel(output, x, y)).toEqual(pixel(original, x, y)); unchanged++;
    }
    expect(unchanged).toBeGreaterThan(18000);
    expect(pixel(output, placed.left, placed.top)).toEqual(rectangle.color);
  });

  it.each([64, 128])("retains antialiased alpha %i instead of painting its background colour", async alpha => {
    const image = await generated([
      { ...rectangle, left: 21, width: 18 },
      { left: 20, top: 20, width: 1, height: 40, color: [240, 10, 20], alpha },
      { left: 39, top: 20, width: 1, height: 40, color: [240, 10, 20], alpha },
    ]);
    const result = await compose(image);
    const p = result.placements[0]!;
    const output = await rgb(result.image), original = await rgb(await room());
    const background = pixel(original, p.left, p.top);
    expect(pixel(output, p.left, p.top)).toEqual(rectangle.color.map((channel, index) => Math.round((channel * alpha + background[index]! * (255 - alpha)) / 255)));
  });

  it("uniformly scales the newly generated view rather than imposing a catalogue height", async () => {
    const image = await generated([{ ...rectangle, width: 12, height: 30 }]);
    const result = await compose(image, [object({ dimensionsCm: { width: 12, height: 4, depth: 12 }, pixelsPerCm: 2,
      pose: { cameraElevationDegrees: 40, cameraRollDegrees: 10 } })]);
    expect(result.placements[0]).toMatchObject({ widthPx: 24, heightPx: 60 });
  });

  it("anchors the visible bottom midpoint rather than the full-width bounding-box centre", async () => {
    const image = await generated([
      { ...rectangle, height: 39 },
      { left: 21, top: 59, width: 8, height: 1, color: [240, 10, 20] },
    ]);
    const result = await compose(image);
    const p = result.placements[0]!;
    expect(Math.abs(p.contactX - Math.round(width * 0.5))).toBeLessThanOrEqual(0.5);
    expect(p.contactY).toBe(Math.round(height * 0.8));
    expect(p.left).toBe(76);
  });

  it.each(["flat", "wall"] as const)("centres a %s product and preserves its generated proportions", async kind => {
    const image = await generated([{ ...rectangle, width: 30, height: 15 }]);
    const result = await compose(image, [object({ kind, point: { x: 0.5, y: 0.5 },
      dimensionsCm: { width: 15, height: 7.5, depth: 7.5 } })]);
    expect(result.placements[0]).toMatchObject({ widthPx: 30, heightPx: 15 });
    expect(Math.abs(result.placements[0]!.contactX - width * 0.5)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(result.placements[0]!.contactY - height * 0.5)).toBeLessThanOrEqual(0.5);
  });

  it("maps three distinct columns in supplied order and composites far objects before near ones", async () => {
    const colors: [number, number, number][] = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];
    const image = await generated(colors.map((color, index) => ({ left: 10 + index * 80, top: 20, width: 20, height: 40, color })), 240);
    const objects = [object({ index: 2, point: { x: 0.5, y: 0.8 } }),
      object({ index: 0, point: { x: 0.2, y: 0.7 } }), object({ index: 1, point: { x: 0.5, y: 0.65 } })];
    const result = await compose(image, objects);
    expect(result.placements.map(p => p.objectIndex)).toEqual([2, 0, 1]);
    const output = await rgb(result.image);
    expect(pixel(output, 80, 60)).toEqual(colors[0]);
    expect(pixel(output, 80, 45)).toEqual(colors[2]);
    expect(pixel(output, 32, 60)).toEqual(colors[1]);
  });

  it("partitions non-divisible column widths without shifting product identities", async () => {
    const image = await generated([
      { left: 3, top: 5, width: 4, height: 10, color: [255, 0, 0] },
      { left: 14, top: 5, width: 4, height: 10, color: [0, 255, 0] },
      { left: 25, top: 5, width: 4, height: 10, color: [0, 0, 255] },
    ], 32, 24);
    expect((await compose(image, [object({ point: { x: 0.2, y: 0.8 } }), object({ index: 1 }),
      object({ index: 2, point: { x: 0.8, y: 0.8 } })])).placements).toHaveLength(3);
  });

  it("rejects opaque outputs and empty transparent columns", async () => {
    const opaque = await sharp({ create: { width: 80, height: 80, channels: 3, background: "red" } }).png().toBuffer();
    const opaqueAlpha = await sharp({ create: { width: 80, height: 80, channels: 4, background: "red" } }).png().toBuffer();
    await expect(compose(opaque)).rejects.toThrow(/transparence/);
    await expect(compose(opaqueAlpha)).rejects.toThrow(/transparent/);
    await expect(compose(await generated([]))).rejects.toThrow(/colonne/);
  });

  it("rejects detached garbage instead of pasting it into the customer's room", async () => {
    const image = await generated([rectangle, { left: 60, top: 10, width: 3, height: 3, color: [0, 255, 0] }]);
    await expect(compose(image)).rejects.toThrow(/séparés/);
  });

  it.each([
    { ...rectangle, left: 0 }, { ...rectangle, top: 0 },
    { ...rectangle, left: 60 }, { ...rectangle, top: 40 },
  ])("rejects a product truncated at an image or column edge: %j", async shape => {
    await expect(compose(await generated([shape]))).rejects.toThrow(/tronqué/);
  });

  it("rejects a product crossing a multi-object column boundary", async () => {
    const image = await generated([{ ...rectangle, left: 70 }, { ...rectangle, left: 110 }], 160);
    await expect(compose(image, [object(), object({ index: 1 })])).rejects.toThrow(/frontière/);
  });

  it("rejects frame overflow without shrinking the requested physical scale", async () => {
    const image = await generated([rectangle]);
    await expect(compose(image, [object({ point: { x: 0, y: 0.8 } })])).rejects.toThrow(/déborderait/);
    await expect(compose(image, [object({ point: { x: 0.5, y: 0.05 } })])).rejects.toThrow(/déborderait/);
    await expect(compose(image, [object({ pixelsPerCm: 30 })])).rejects.toThrow(/ne tient pas/);
  });

  it("rejects inconsistent room dimensions and duplicate object identities", async () => {
    const image = await generated([rectangle]);
    await expect(composeStorefrontIsolatedProducts({ room: await room(), width: 159, height, generated: image, objects: [object()] })).rejects.toThrow(/incohérentes/);
    await expect(compose(image, [object(), object()])).rejects.toThrow(/invalides/);
  });
});
