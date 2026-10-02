import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { ImageEditingRequest, ImageReference } from "@lili/ai-router";

vi.mock("server-only", () => ({}));
import { MockImageProvider } from "../lib/server/ai/mock";
import { composeStorefrontIsolatedProducts } from "../lib/server/storefront-isolated-composite";

const fetchMock = vi.fn<typeof globalThis.fetch>();
beforeEach(() => {
  fetchMock.mockReset().mockRejectedValue(new Error("No provider call is allowed in this simulation"));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  expect(fetchMock).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

const request = (): ImageEditingRequest => ({
  scene: new Uint8Array([1]), productCutout: new Uint8Array([2]),
  composition: new Uint8Array([3, 4, 5]), protectionMask: new Uint8Array([6]),
  targetMask: { data: new Uint8Array([7]), mimeType: "image/png", role: "target_mask" },
  prompt: "Simulate catalogue isolation", quality: "medium", size: "1024x1024",
  lighting: { direction: "left", temperature: "neutral", hardness: "soft" },
  placement: { x: 0.5, y: 0.8 }, idempotencyKey: "mock-isolation-test",
  mode: "insert", outputQuality: "final", preserveBackground: true,
});
const colors: [number, number, number][] = [[233, 24, 42], [20, 201, 44], [30, 50, 224]];
const reference = (data: Uint8Array, role: ImageReference["role"] = "product_front"): ImageReference =>
  ({ data, role, mimeType: "image/png" });
const catalogue = (color: [number, number, number], width = 40, height = 60) =>
  sharp({ create: { width, height, channels: 3, background: { r: color[0], g: color[1], b: color[2] } } }).png().toBuffer();
const pixel = (data: Buffer, width: number, x: number, y: number) =>
  [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];

function visibleBox(data: Buffer, width: number, height: number, start: number, end: number) {
  let left = end, right = start - 1, top = height, bottom = -1, opaque = 0, partialAlpha = 0;
  for (let y = 0; y < height; y++) for (let x = start; x < end; x++) {
    const alpha = data[(y * width + x) * 4 + 3]!;
    if (alpha === 0) continue;
    if (alpha !== 255) partialAlpha++;
    opaque++;
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  expect(partialAlpha).toBe(0);
  return { left, top, width: right - left + 1, height: bottom - top + 1, opaque };
}

describe("mock catalogue product isolation", () => {
  it("returns valid lossless WebP for a PNG room-edit input matching its mask", async () => {
    const room = await catalogue(colors[0]!, 80, 120);
    const result = await new MockImageProvider().edit({ ...request(), composition: new Uint8Array(room) });
    expect(result).toMatchObject({ status: "succeeded", estimatedCostUsd: 0, images: [{ mimeType: "image/webp" }] });
    const output = Buffer.from(result.images[0]!.data);
    expect(await sharp(output).metadata()).toMatchObject({ format: "webp", width: 80, height: 120 });
    expect(await sharp(output).removeAlpha().raw().toBuffer()).toEqual(await sharp(room).removeAlpha().raw().toBuffer());
  });
  it.each([
    ["edit", false], ["edit", undefined], ["generate", false], ["generate", undefined],
  ] as const)("preserves the normal %s composition bytes and mock metadata when isolation is %s", async (method, productIsolation) => {
    const input = { ...request(), productIsolation };
    const result = await new MockImageProvider()[method](input);
    expect(result).toMatchObject({
      provider: "mock", model: "deterministic-compositor-v2", requestId: "mock-mock-isolation-test",
      status: "succeeded", durationMs: 1, estimatedCostUsd: 0,
      images: [{ data: input.composition, mimeType: "image/webp" }],
      safety: { blocked: false }, attemptCount: 1,
    });
    expect(result.images[0]!.data).toBe(input.composition);
    expect(result.usage).toBeUndefined();
  });

  it.each([
    [1, "1024x1024", 1024, 1024],
    [2, "1536x1024", 1536, 1024],
    [3, "1024x1536", 1024, 1536],
  ] as const)("places %i intact catalogue rectangles in ordered columns on a transparent %s canvas", async (count, size, width, height) => {
    const products = await Promise.all(colors.slice(0, count).map(async color => reference(await catalogue(color))));
    const result = await new MockImageProvider().edit({
      ...request(), size, productIsolation: true,
      references: [reference(new Uint8Array([91]), "room_original"), ...products,
        reference(new Uint8Array([92]), "spatial_guide"), reference(new Uint8Array([93]), "target_mask"),
        reference(new Uint8Array([94]), "composition"), reference(new Uint8Array([95]), "intermediate")],
    });
    expect(result.status).toBe("succeeded");
    expect(result).toMatchObject({ provider: "mock", model: "deterministic-compositor-v2", estimatedCostUsd: 0, attemptCount: 1 });
    expect(result.usage).toBeUndefined();
    const image = Buffer.from(result.images[0]!.data);
    expect(await sharp(image).metadata()).toMatchObject({ format: "webp", width, height, hasAlpha: true });
    const pixels = await sharp(image).ensureAlpha().raw().toBuffer();
    for (let index = 0; index < count; index++) {
      const start = Math.round(index * width / count), end = Math.round((index + 1) * width / count);
      const box = visibleBox(pixels, width, height, start, end);
      expect(box.width).toBeGreaterThan(0);
      expect(box.opaque).toBe(box.width * box.height);
      expect(box.left - start).toBeGreaterThanOrEqual(Math.floor((end - start) * 0.1));
      expect(end - box.left - box.width).toBeGreaterThanOrEqual(Math.floor((end - start) * 0.1));
      expect(box.top).toBeGreaterThanOrEqual(Math.floor(height * 0.1));
      expect(height - box.top - box.height).toBeGreaterThanOrEqual(Math.floor(height * 0.1));
      expect(Math.abs(box.left + box.width / 2 - (start + end) / 2)).toBeLessThanOrEqual(1);
      expect(Math.abs(box.top + box.height / 2 - height / 2)).toBeLessThanOrEqual(1);
      expect(pixel(pixels, width, Math.floor((start + end) / 2), Math.floor(height / 2))).toEqual([...colors[index]!, 255]);
      expect(pixel(pixels, width, start, Math.floor(height / 2))[3]).toBe(0);
      expect(pixel(pixels, width, end - 1, Math.floor(height / 2))[3]).toBe(0);
    }
    expect(pixel(pixels, width, 0, 0)[3]).toBe(0);
    expect(pixel(pixels, width, width - 1, height - 1)[3]).toBe(0);
    expect(pixel(pixels, width, Math.floor(width / 2), 0)[3]).toBe(0);
    expect(pixel(pixels, width, Math.floor(width / 2), height - 1)[3]).toBe(0);
  });

  it("keeps repeated identical catalogue bytes as distinct product columns", async () => {
    const source = await catalogue(colors[0]!);
    const result = await new MockImageProvider().edit({
      ...request(), productIsolation: true,
      references: [reference(source), reference(Buffer.from(source), "product_detail")],
    });
    expect(result.status).toBe("succeeded");
    const pixels = await sharp(Buffer.from(result.images[0]!.data)).ensureAlpha().raw().toBuffer();
    const first = visibleBox(pixels, 1024, 1024, 0, 512), second = visibleBox(pixels, 1024, 1024, 512, 1024);
    expect(first.opaque).toBeGreaterThan(0);
    expect(second).toEqual({ ...first, left: first.left + 512 });
    expect(pixel(pixels, 1024, 256, 512)).toEqual([...colors[0]!, 255]);
    expect(pixel(pixels, 1024, 768, 512)).toEqual([...colors[0]!, 255]);
  });

  it("orients the catalogue and resizes uniformly while retaining its color pattern", async () => {
    const data = Buffer.alloc(80 * 40 * 3);
    for (let y = 0; y < 40; y++) for (let x = 0; x < 80; x++) {
      const color = x < 40 ? colors[0]! : colors[2]!;
      const offset = (y * 80 + x) * 3;
      data[offset] = color[0]; data[offset + 1] = color[1]; data[offset + 2] = color[2];
    }
    const source = await sharp(data, { raw: { width: 80, height: 40, channels: 3 } })
      .jpeg({ quality: 100, chromaSubsampling: "4:4:4" }).withMetadata({ orientation: 6 }).toBuffer();
    const result = await new MockImageProvider().edit({
      ...request(), productIsolation: true,
      references: [{ ...reference(source), mimeType: "image/jpeg" }],
    });
    const pixels = await sharp(Buffer.from(result.images[0]!.data)).ensureAlpha().raw().toBuffer();
    const box = visibleBox(pixels, 1024, 1024, 0, 1024);
    expect(box.width / box.height).toBeCloseTo(0.5, 2);
    const upper = pixel(pixels, 1024, 512, box.top + Math.floor(box.height / 4));
    const lower = pixel(pixels, 1024, 512, box.top + Math.floor(box.height * 3 / 4));
    for (let channel = 0; channel < 3; channel++) {
      expect(Math.abs(upper[channel]! - colors[0]![channel]!)).toBeLessThanOrEqual(5);
      expect(Math.abs(lower[channel]! - colors[2]![channel]!)).toBeLessThanOrEqual(5);
    }
    expect(box.opaque).toBe(box.width * box.height);
  });

  it("produces complete connected columns accepted by the local alpha compositor", async () => {
    const references = await Promise.all(colors.map(async color => reference(await catalogue(color))));
    const mock = await new MockImageProvider().edit({ ...request(), productIsolation: true, references });
    const room = await sharp({ create: { width: 300, height: 240, channels: 3, background: "#050607" } }).png().toBuffer();
    const result = await composeStorefrontIsolatedProducts({
      room, width: 300, height: 240, generated: Buffer.from(mock.images[0]!.data),
      objects: colors.map((_color, index) => ({ index, point: { x: 0.2 + index * 0.3, y: 0.8 }, kind: "standing" as const,
        dimensionsCm: { width: 10, height: 15, depth: 5 }, pixelsPerCm: 2 })),
    });
    expect(result.placements.map(placement => placement.objectIndex)).toEqual([0, 1, 2]);
    expect(result.placements.map(placement => placement.widthPx)).toEqual([20, 20, 20]);
    expect(await sharp(result.image).metadata()).toMatchObject({ format: "webp", width: 300, height: 240 });
  });

  it.each([0, 4])("rejects %i product references locally with zero cost", async count => {
    const source = await catalogue(colors[0]!);
    const result = await new MockImageProvider().edit({
      ...request(), productIsolation: true,
      references: [reference(new Uint8Array([91]), "room_original"), ...Array.from({ length: count }, () => reference(source))],
    });
    expect(result).toMatchObject({ provider: "mock", model: "deterministic-compositor-v2", status: "failed", estimatedCostUsd: 0,
      error: { code: "invalid_input", retryable: false }, images: [] });
  });

  it("rejects unreadable catalogue bytes without falling back to composition or cutout", async () => {
    const result = await new MockImageProvider().edit({
      ...request(), productIsolation: true, references: [reference(new Uint8Array([1, 2, 3]))],
    });
    expect(result).toMatchObject({ provider: "mock", status: "failed", estimatedCostUsd: 0,
      error: { code: "invalid_input", retryable: false }, images: [] });
  });
});
