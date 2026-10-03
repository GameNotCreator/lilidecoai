import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

const mocks = vi.hoisted(() => ({ cutout: vi.fn(), fetch: vi.fn(), config: {
  mattingUrl: "http://mask.invalid", mattingToken: "test-token", mattingTimeoutMs: 1000,
} }));
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/assets", () => ({ CUTOUT_VERSION: "cutout-v2", prepareCutout: mocks.cutout }));
vi.mock("../lib/server/config", () => ({ serverConfig: mocks.config }));
vi.mock("../lib/server/mask-topology", () => ({ hasSeparatedSubjects: async () => false }));
vi.mock("../lib/server/admin-products", () => ({ AdminProductError: class extends Error {} }));

import { prepareViewMatte } from "../lib/server/prepared-view-matte";

const quality = { opaque: false, ragged: false, hollowed: false, enclosedBackground: false,
  shadowBand: false, busyBackground: false, vanished: false };
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("fetch", mocks.fetch); });
afterEach(() => vi.unstubAllGlobals());

describe("prepared view mask-only service contract", () => {
  it("uses the configured mask service, preserves RGB and records its actual model version", async () => {
    const width = 100, height = 100;
    const rgb = Buffer.alloc(width * height * 3);
    for (let i = 0; i < width * height; i++) { rgb[i * 3] = i % 256; rgb[i * 3 + 1] = 50; rgb[i * 3 + 2] = 100; }
    const source = await sharp(rgb, { raw: { width, height, channels: 3 } }).png().toBuffer();
    const coverage = Buffer.alloc(width * height);
    for (let y = 15; y < 80; y++) for (let x = 20; x < 80; x++) coverage[y * width + x] = 255;
    const mask = await sharp(coverage, { raw: { width, height, channels: 1 } }).png().toBuffer();
    mocks.cutout.mockImplementation(async (buffer: Buffer) => ({ buffer, widthPx: width, heightPx: height,
      baseRowFraction: 0.79, shadowRemoved: false, warnings: [],
      quality: mocks.cutout.mock.calls.length === 1 ? { ...quality, hollowed: true } : quality,
      needsModelIsolation: mocks.cutout.mock.calls.length === 1 }));
    mocks.fetch.mockResolvedValue(new Response(new Uint8Array(mask), { headers: { "content-type": "image/png", "x-matting-model": "birefnet-test-1" } }));
    const matte = await prepareViewMatte(source);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(String(mocks.fetch.mock.calls[0]![0])).toBe("http://mask.invalid/v1/mask");
    expect(matte.version).toBe("prepared-matte-v2/cutout-v2/mask-v2/birefnet-test-1");
    expect(matte.maskSource).toBe("matting");
    const actual = await sharp(matte.image).removeAlpha().raw().toBuffer();
    expect(actual.equals(rgb)).toBe(true);
    expect(matte).not.toHaveProperty("origin");
    expect(matte).not.toHaveProperty("synthetic");
  });
  it("refuses uncertain service masks and service outages without accepting the heuristic", async () => {
    const source = await sharp({ create: { width: 100, height: 100, channels: 3, background: "white" } }).png().toBuffer();
    mocks.cutout.mockResolvedValue({ buffer: source, widthPx: 100, heightPx: 100, baseRowFraction: 0.9,
      shadowRemoved: false, warnings: [], quality: { ...quality, hollowed: true }, needsModelIsolation: true });
    mocks.fetch.mockResolvedValue(new Response("unavailable", { status: 503 }));
    await expect(prepareViewMatte(source)).rejects.toThrow("indisponible");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});
