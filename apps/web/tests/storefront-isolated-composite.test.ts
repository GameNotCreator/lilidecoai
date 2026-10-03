import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { composeStorefrontIsolatedProducts, harmonizeStorefrontIsolatedProducts, STOREFRONT_ISOLATED_COMPOSITE_VERSION, STOREFRONT_NATIVE_CONTACT_MAX_DARKENING, STOREFRONT_HYBRID_RGB_VERSION, type StorefrontIsolatedObject } from "../lib/server/storefront-isolated-composite";
import { createSilhouetteMask, MAX_RELIGHT_GAIN, padCompositionForAspect } from "../lib/server/simple-composite";

const width = 160, height = 120;
const object = (overrides: Partial<StorefrontIsolatedObject> = {}): StorefrontIsolatedObject => ({
  index: 0, point: { x: 0.5, y: 0.8 }, kind: "standing",
  dimensionsCm: { width: 10, height: 20, depth: 10 }, pixelsPerCm: 2, ...overrides,
});

describe("isolated product illumination transfer", () => {
  async function fixture(options: { pose?: Buffer; object?: StorefrontIsolatedObject; window?: { left: number; top: number; width: number; height: number } } = {}) {
    const originalRoom = await room();
    const pose = options.pose ?? await generated([
      { ...rectangle, color: [40, 80, 160] },
      { left: 27, top: 12, width: 6, height: 8, color: [30, 60, 120] },
      { left: 25, top: 30, width: 6, height: 10, color: [0, 0, 0], alpha: 0 },
      { left: 19, top: 20, width: 1, height: 40, color: [40, 80, 160], alpha: 64 },
    ]);
    const isolated = await composeStorefrontIsolatedProducts({ room: originalRoom, width, height, generated: pose, objects: [options.object ?? object()] });
    const maskRaw = await createSilhouetteMask(width, height, isolated.overlays, null);
    const window = options.window ?? { left: 40, top: 35, width: 80, height: 80 };
    const localComposite = await sharp(isolated.image).extract(window).webp({ lossless: true }).toBuffer();
    const localMask = await sharp(maskRaw, { raw: { width, height, channels: 4 } }).extract(window).raw().toBuffer();
    const padded = await padCompositionForAspect({ imageWebp: localComposite, baseWebp: localComposite,
      maskRaw: localMask, overlays: [], sceneWidth: window.width, sceneHeight: window.height }, "120x80", { exactAspect: true });
    return { room: originalRoom, width, height, isolated, window, padded, generated: padded.imageWebp, maskRaw };
  }
  const solid = (w: number, h: number, color = "#00ff00") => sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();

  it("retains each complete native overlay, its alpha, physical width and exact support anchor", async () => {
    const f = await fixture();
    const placement = f.isolated.placements[0]!, overlay = f.isolated.overlays[0]!;
    expect(overlay).toMatchObject({ left: placement.left, top: placement.top, widthPx: placement.widthPx,
      heightPx: placement.heightPx, baseX: placement.contactX, baseY: placement.contactY, objectIndex: 0, kind: "standing" });
    expect(overlay.widthPx).toBe(21);
    expect(overlay.heightPx).toBe(48);
    expect(Math.abs(overlay.baseX - 80)).toBeLessThanOrEqual(0.5);
    expect(overlay.baseY).toBe(96);
    const alpha = await sharp(overlay.png).extractChannel("alpha").raw().toBuffer();
    expect(alpha).toContain(64);
    expect(alpha).toContain(0);
    expect(alpha).toContain(255);
  });

  it.each([
    { left: 72, top: 35, width: 48, height: 80 },
    { left: 40, top: 60, width: 80, height: 55 },
    { left: 40, top: 35, width: 48, height: 80 },
    { left: 40, top: 35, width: 80, height: 60 },
  ])("rejects a window that clips any part of the native silhouette before decoding the provider image: %j", async window => {
    const f = await fixture();
    await expect(harmonizeStorefrontIsolatedProducts({ ...f, window, generated: Buffer.from("not an image") }))
      .rejects.toThrow(/vue complète.*fenêtre/);
  });

  it.each([[120, 81], [80, 120]])("rejects a changed provider aspect ratio %ix%i instead of distorting the product", async (w, h) => {
    const f = await fixture();
    await expect(harmonizeStorefrontIsolatedProducts({ ...f, generated: await solid(w, h) })).rejects.toThrow(/cadrage/);
  });

  it("rejects transparent room harmonization rather than accepting a missing support", async () => {
    const f = await fixture();
    const transparent = await sharp({ create: { width: 120, height: 80, channels: 4, background: { r: 20, g: 40, b: 80, alpha: 0.8 } } }).png().toBuffer();
    await expect(harmonizeStorefrontIsolatedProducts({ ...f, generated: transparent })).rejects.toThrow(/opaque/);
  });

  it("rejects invalid padding offsets and a mask from another photograph", async () => {
    const f = await fixture();
    await expect(harmonizeStorefrontIsolatedProducts({ ...f, padded: { ...f.padded, offsetX: 80 } })).rejects.toThrow(/cadrage/);
    await expect(harmonizeStorefrontIsolatedProducts({ ...f, maskRaw: f.maskRaw.subarray(4) })).rejects.toThrow(/fenêtre/);
  });

  it("cannot import a recoloured room, replaced product, cloned pixels or product alpha from the second provider", async () => {
    const f = await fixture();
    const before = { room: Buffer.from(f.room), image: Buffer.from(f.isolated.image), png: Buffer.from(f.isolated.overlays[0]!.png),
      mask: Buffer.from(f.maskRaw), placement: structuredClone(f.isolated.placements), overlay: { ...f.isolated.overlays[0]! } };
    const result = await harmonizeStorefrontIsolatedProducts({ ...f, generated: await solid(120, 80) });
    const baseline = await harmonizeStorefrontIsolatedProducts(f);
    expect(await rgb(result)).toEqual(await rgb(baseline));
    expect(f.room).toEqual(before.room);
    expect(f.isolated.image).toEqual(before.image);
    expect(f.isolated.overlays[0]!.png).toEqual(before.png);
    expect(f.isolated.overlays[0]).toEqual(before.overlay);
    expect(f.isolated.placements).toEqual(before.placement);
    expect(f.maskRaw).toEqual(before.mask);
  });

  it("discards a moved and duplicated provider silhouette while preserving the native crown, holes and fringe", async () => {
    const f = await fixture();
    const original = f.isolated.overlays[0]!;
    const movedRoom = await sharp(f.room).composite([
      { input: original.png, left: 42, top: 42 },
      { input: original.png, left: 99, top: 42 },
    ]).extract(f.window).extend({ left: f.padded.offsetX, right: f.padded.offsetX, top: 0, bottom: 0, background: "#767676" }).png().toBuffer();
    const output = await rgb(await harmonizeStorefrontIsolatedProducts({ ...f, generated: movedRoom }));
    expect(output).toEqual(await rgb(await harmonizeStorefrontIsolatedProducts(f)));
    expect(pixel(output, Math.round(original.baseX), original.baseY)).toEqual([40, 80, 160]);
  });

  it("accepts only bounded luminance on source RGB while protecting the outside frame, mask and source alpha", async () => {
    const f = await fixture();
    const inputRgb = await sharp(f.padded.imageWebp).removeAlpha().raw().toBuffer();
    const darker = await sharp(Buffer.from(inputRgb.map(value => Math.round(value * 0.75))),
      { raw: { width: f.padded.paddedWidth, height: f.padded.paddedHeight, channels: 3 } }).png().toBuffer();
    const output = await rgb(await harmonizeStorefrontIsolatedProducts({ ...f, generated: darker }));
    const before = await rgb(f.isolated.image);
    const overlay = f.isolated.overlays[0]!;
    const native = await sharp(overlay.png).ensureAlpha().raw().toBuffer();
    let shadedSupport = 0, litProduct = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const ox = x - overlay.left, oy = y - overlay.top;
      const inside = ox >= 0 && oy >= 0 && ox < overlay.widthPx && oy < overlay.heightPx;
      const alpha = inside ? native[(oy * overlay.widthPx + ox) * 4 + 3]! : 0;
      const oldPixel = [...before.subarray(i, i + 3)], newPixel = [...output.subarray(i, i + 3)];
      if (!alpha && (f.maskRaw[(y * width + x) * 4 + 3] !== 0 || y < overlay.baseY - 2 ||
          x < f.window.left || y < f.window.top || x >= f.window.left + f.window.width || y >= f.window.top + f.window.height)) {
        expect(newPixel).toEqual(oldPixel);
      } else if (!alpha) {
        if (newPixel[0]! < oldPixel[0]! - 1) shadedSupport++;
        for (let c = 0; c < 3; c++) {
          expect(newPixel[c]!).toBeLessThanOrEqual(oldPixel[c]!);
          expect(newPixel[c]!).toBeGreaterThanOrEqual(Math.floor(oldPixel[c]! * (1 - STOREFRONT_NATIVE_CONTACT_MAX_DARKENING)));
        }
      } else if (alpha === 255) {
        if (newPixel[0]! !== oldPixel[0]!) litProduct++;
        for (let c = 0; c < 3; c++) expect(Math.abs(newPixel[c]! - oldPixel[c]!)).toBeLessThanOrEqual(oldPixel[c]! * MAX_RELIGHT_GAIN + 1);
        expect(Math.abs(newPixel[0]! * 2 - newPixel[1]!)).toBeLessThanOrEqual(1);
        expect(Math.abs(newPixel[0]! * 4 - newPixel[2]!)).toBeLessThanOrEqual(2);
      } else {
        // Fractional source alpha contributes exactly once. Relighting can
        // change source RGB only within its bounded gain and existing alpha.
        for (let c = 0; c < 3; c++) {
          const source = native[(oy * overlay.widthPx + ox) * 4 + c]!;
          expect(Math.abs(newPixel[c]! - oldPixel[c]!)).toBeLessThanOrEqual(source * MAX_RELIGHT_GAIN * alpha / 255 + 1);
        }
      }
    }
    expect(shadedSupport).toBeGreaterThan(10);
    expect(litProduct).toBeGreaterThan(100);
    expect(f.isolated.placements[0]!.contactY).toBe(96);
  });

  it("recovers a bounded native-foot contact when black provider pixels are too dark to transfer safely", async () => {
    const f = await fixture();
    const baseline = await rgb(await harmonizeStorefrontIsolatedProducts(f));
    const result = await rgb(await harmonizeStorefrontIsolatedProducts({ ...f, generated: await solid(120, 80, "#000000") }));
    expect(result).toEqual(baseline);
    expect(STOREFRONT_NATIVE_CONTACT_MAX_DARKENING).toBe(0.34);
    const before = await rgb(f.isolated.image);
    const overlay = f.isolated.overlays[0]!;
    const alpha = await sharp(overlay.png).extractChannel("alpha").raw().toBuffer();
    let contactPixels = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const ox = x - overlay.left, oy = y - overlay.top;
      const product = ox >= 0 && oy >= 0 && ox < overlay.widthPx && oy < overlay.heightPx && alpha[oy * overlay.widthPx + ox]! > 0;
      const changed = !result.subarray(i, i + 3).equals(before.subarray(i, i + 3));
      if (!changed) continue;
      contactPixels++;
      expect(product).toBe(false);
      expect(f.maskRaw[(y * width + x) * 4 + 3]).toBe(0);
      expect(x).toBeGreaterThanOrEqual(overlay.left - 2);
      expect(x).toBeLessThanOrEqual(overlay.left + overlay.widthPx + 2);
      expect(y).toBeGreaterThanOrEqual(overlay.baseY - 1);
      expect(y).toBeLessThanOrEqual(overlay.baseY + 4);
      for (let c = 0; c < 3; c++) {
        expect(result[i + c]!).toBeLessThanOrEqual(before[i + c]!);
        expect(result[i + c]!).toBeGreaterThanOrEqual(Math.floor(before[i + c]! * 0.66));
      }
    }
    expect(contactPixels).toBeGreaterThan(20);
    const x = Math.round(overlay.baseX), y = overlay.baseY + 1;
    expect(pixel(result, x, y)).toEqual(pixel(before, x, y).map(channel => Math.round(channel * 0.66)));
    expect(pixel(result, x, y + 1)[0]).toBeGreaterThan(pixel(result, x, y)[0]!);
    expect(pixel(result, x, y + 4)).toEqual(pixel(before, x, y + 4));
  });

  it("combines native and transferred contact by the strongest attenuation instead of adding both shadows", async () => {
    const f = await fixture();
    const input = await sharp(f.padded.imageWebp).removeAlpha().raw().toBuffer();
    const darker = await sharp(Buffer.from(input.map(channel => Math.round(channel * 0.75))),
      { raw: { width: f.padded.paddedWidth, height: f.padded.paddedHeight, channels: 3 } }).png().toBuffer();
    const baseline = await rgb(await harmonizeStorefrontIsolatedProducts(f));
    const result = await rgb(await harmonizeStorefrontIsolatedProducts({ ...f, generated: darker }));
    const overlay = f.isolated.overlays[0]!;
    expect(pixel(result, Math.round(overlay.baseX), overlay.baseY + 1)).toEqual(pixel(baseline, Math.round(overlay.baseX), overlay.baseY + 1));
  });

  it("keeps two feet separate without drawing an artificial bridge under the empty middle", async () => {
    const pose = await generated([
      { left: 20, top: 20, width: 20, height: 25, color: [40, 80, 160] },
      { left: 20, top: 45, width: 4, height: 15, color: [40, 80, 160] },
      { left: 36, top: 45, width: 4, height: 15, color: [40, 80, 160] },
    ]);
    const f = await fixture({ pose });
    const result = await rgb(await harmonizeStorefrontIsolatedProducts(f));
    const before = await rgb(f.isolated.image);
    const overlay = f.isolated.overlays[0]!;
    for (const x of [overlay.left + 1, overlay.left + 18]) {
      expect(pixel(result, x, overlay.baseY + 1)[0]).toBeLessThan(pixel(before, x, overlay.baseY + 1)[0]!);
      expect(pixel(result, x, overlay.baseY)).toEqual(pixel(before, x, overlay.baseY));
    }
    for (let y = overlay.baseY - 1; y <= overlay.baseY + 4; y++)
      for (let x = overlay.left + 7; x <= overlay.left + 12; x++) expect(pixel(result, x, y)).toEqual(pixel(before, x, y));
  });

  it("never shades a locked support pixel even when an adjacent foot requires contact", async () => {
    const f = await fixture();
    const overlay = f.isolated.overlays[0]!, x = Math.round(overlay.baseX), y = overlay.baseY + 1;
    f.maskRaw[(y * width + x) * 4 + 3] = 255;
    const result = await rgb(await harmonizeStorefrontIsolatedProducts(f));
    const before = await rgb(f.isolated.image);
    expect(pixel(result, x, y)).toEqual(pixel(before, x, y));
    expect(pixel(result, x + 1, y)[0]).toBeLessThan(pixel(before, x + 1, y)[0]!);
  });

  it("does not shade beyond a lighting window ending exactly at the intact product base", async () => {
    const f = await fixture({ window: { left: 40, top: 35, width: 80, height: 62 } });
    const result = await rgb(await harmonizeStorefrontIsolatedProducts(f));
    const before = await rgb(f.isolated.image);
    for (let y = f.window.top + f.window.height; y < height; y++)
      expect(result.subarray(y * width * 3, (y + 1) * width * 3)).toEqual(before.subarray(y * width * 3, (y + 1) * width * 3));
    expect(pixel(result, 80, 96)).toEqual(pixel(before, 80, 96));
  });

  it.each(["flat", "wall"] as const)("does not invent a standing floor contact for a %s placement", async kind => {
    const f = await fixture({ object: object({ kind, point: { x: 0.5, y: 0.6 } }) });
    expect(await rgb(await harmonizeStorefrontIsolatedProducts(f))).toEqual(await rgb(f.isolated.image));
  });

  describe("bounded RGB transfer used by hybrid v2", () => {
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    const transfer = (f: Fixture, generated = f.generated) => harmonizeStorefrontIsolatedProducts({ ...f, generated, transferMode: "bounded-rgb" });

    it("declares a separate bounded RGB contract without relabelling historical isolated compositions", () => {
      expect(STOREFRONT_HYBRID_RGB_VERSION).toBe("storefront-hybrid-bounded-rgb-v1");
      expect(STOREFRONT_ISOLATED_COMPOSITE_VERSION).toBe("storefront-isolated-product-v4");
    });

    it("admits the provider's natural product RGB within the native silhouette and leaves original inputs immutable", async () => {
      const f = await fixture();
      const before = { room: Buffer.from(f.room), image: Buffer.from(f.isolated.image), png: Buffer.from(f.isolated.overlays[0]!.png),
        mask: Buffer.from(f.maskRaw), placement: structuredClone(f.isolated.placements) };
      const output = await rgb(await transfer(f, await solid(120, 80, "#305ca8")));
      expect(pixel(output, 85, 80)).toEqual([48, 92, 168]);
      expect(pixel(output, 85, 80)).not.toEqual(pixel(await rgb(f.isolated.image), 85, 80));
      expect(f.room).toEqual(before.room);
      expect(f.isolated.image).toEqual(before.image);
      expect(f.isolated.overlays[0]!.png).toEqual(before.png);
      expect(f.isolated.placements).toEqual(before.placement);
      expect(f.maskRaw).toEqual(before.mask);
    });

    it("does not invent any shadow when the provider returns the identical photograph", async () => {
      const f = await fixture();
      expect(await rgb(await transfer(f))).toEqual(await rgb(f.isolated.image));
    });

    it("accepts a dark local contact rejected by the old luminance-only ratio gate", async () => {
      const f = await fixture();
      const output = await rgb(await transfer(f, await solid(120, 80, "#000000")));
      const before = await rgb(f.isolated.image), overlay = f.isolated.overlays[0]!;
      const x = Math.round(overlay.baseX), y = overlay.baseY + 1;
      expect(pixel(output, x, y)[0]).toBeLessThan(pixel(before, x, y)[0]! * 0.65);
      expect(pixel(output, x, y + 12)).toEqual(pixel(before, x, y + 12));
    });

    it("uses support luminance only so a coloured provider shadow cannot repaint the original floor", async () => {
      const f = await fixture();
      const output = await rgb(await transfer(f, await solid(120, 80, "#200020")));
      const before = await rgb(f.isolated.image), overlay = f.isolated.overlays[0]!;
      for (const x of [78, 80, 82]) {
        const source = pixel(before, x, overlay.baseY + 1), result = pixel(output, x, overlay.baseY + 1);
        const gain = result[0]! / source[0]!;
        expect(gain).toBeLessThan(1);
        for (let channel = 0; channel < 3; channel++) expect(Math.abs(result[channel]! - source[channel]! * gain)).toBeLessThanOrEqual(1.5);
        expect(result).not.toEqual([32, 0, 32]);
      }
    });

    it("rejects white support glow without rejecting product-surface illumination", async () => {
      const f = await fixture();
      const output = await rgb(await transfer(f, await solid(120, 80, "#ffffff")));
      const before = await rgb(f.isolated.image), overlay = f.isolated.overlays[0]!;
      const alpha = await sharp(overlay.png).extractChannel("alpha").raw().toBuffer();
      let productChanges = 0;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const ox = x - overlay.left, oy = y - overlay.top;
        const product = ox >= 0 && oy >= 0 && ox < overlay.widthPx && oy < overlay.heightPx && alpha[oy * overlay.widthPx + ox]! > 0;
        if (!product) expect(pixel(output, x, y)).toEqual(pixel(before, x, y));
        else if (pixel(output, x, y).some((channel, i) => channel !== pixel(before, x, y)[i])) productChanges++;
      }
      expect(productChanges).toBeGreaterThan(100);
    });

    it("discards provider clones outside the silhouette, small halo and local contact, even inside an unlocked window", async () => {
      const f = await fixture();
      f.maskRaw.fill(0);
      const output = await rgb(await transfer(f, await solid(120, 80, "#000000")));
      const before = await rgb(f.isolated.image), overlay = f.isolated.overlays[0]!;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        if (x < overlay.left - 6 || x >= overlay.left + overlay.widthPx + 6 || y < overlay.top - 4 || y > overlay.baseY + 12)
          expect(pixel(output, x, y)).toEqual(pixel(before, x, y));
      }
      expect(pixel(output, 50, 80)).toEqual(pixel(before, 50, 80));
      expect(pixel(output, 110, 80)).toEqual(pixel(before, 110, 80));
      expect(pixel(output, 85, 80)).toEqual([0, 0, 0]);
    });

    it("refuses an incomplete product mask instead of clipping any native product pixel", async () => {
      const f = await fixture();
      f.maskRaw[(80 * width + 85) * 4 + 3] = 255;
      await expect(transfer(f, await solid(120, 80, "#000000"))).rejects.toThrow(/masque.*silhouette complète/);
    });

    it("keeps every locked support pixel exact, including contact pixels", async () => {
      const f = await fixture();
      const overlay = f.isolated.overlays[0]!;
      f.maskRaw[((overlay.baseY + 1) * width + 80) * 4 + 3] = 255;
      const output = await rgb(await transfer(f, await solid(120, 80, "#000000")));
      const before = await rgb(f.isolated.image);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
        if (f.maskRaw[(y * width + x) * 4 + 3] !== 0) expect(pixel(output, x, y)).toEqual(pixel(before, x, y));
      expect(pixel(output, 84, 80)).toEqual([0, 0, 0]);
    });

    it("preserves the complete crown and apparent base while keeping the original image outside the full window", async () => {
      const f = await fixture();
      const before = await rgb(f.isolated.image);
      const output = await rgb(await transfer(f, await solid(120, 80, "#305ca8")));
      const overlay = f.isolated.overlays[0]!;
      expect(pixel(output, 80, overlay.top + 2)).toEqual([48, 92, 168]);
      expect(pixel(output, 80, overlay.baseY)).toEqual([48, 92, 168]);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
        if (x < f.window.left || x >= f.window.left + f.window.width || y < f.window.top || y >= f.window.top + f.window.height)
          expect(pixel(output, x, y)).toEqual(pixel(before, x, y));
      expect(f.isolated.placements[0]!.contactY).toBe(96);
    });

    it("softens the outer transition without clipping native product pixels", async () => {
      const f = await fixture();
      f.maskRaw.fill(0);
      const before = await rgb(f.isolated.image);
      const output = await rgb(await transfer(f, await solid(120, 80, "#000000")));
      const overlay = f.isolated.overlays[0]!;
      expect(pixel(output, overlay.left + overlay.widthPx - 1, 80)).toEqual([0, 0, 0]);
      const halo = Array.from({ length: 6 }, (_, offset) => ({
        after: pixel(output, overlay.left + overlay.widthPx + offset, 80)[0]!,
        before: pixel(before, overlay.left + overlay.widthPx + offset, 80)[0]!,
      }));
      expect(halo.some(({ after, before }) => after > 0 && after < before)).toBe(true);
      for (const pixel of halo.slice(3)) expect(pixel.after).toBe(pixel.before);
    });

    it.each(["flat", "wall"] as const)("keeps RGB edits local for %s products without adding a standing contact field", async kind => {
      const f = await fixture({ object: object({ kind, point: { x: 0.5, y: 0.6 } }) });
      f.maskRaw.fill(0);
      const before = await rgb(f.isolated.image);
      const output = await rgb(await transfer(f, await solid(120, 80, "#000000")));
      const overlay = f.isolated.overlays[0]!;
      expect(pixel(output, overlay.left + 15, overlay.top + 30)).toEqual([0, 0, 0]);
      const belowHalo = overlay.top + overlay.heightPx + 5;
      for (let x = overlay.left; x < overlay.left + overlay.widthPx; x++)
        expect(pixel(output, x, belowHalo)).toEqual(pixel(before, x, belowHalo));
    });

    describe("native interior texture under provider illumination", () => {
      const textureTransfer = (f: Fixture, generated = f.generated) => harmonizeStorefrontIsolatedProducts({
        ...f, generated, transferMode: "bounded-rgb", preserveProductTexture: true,
      });
      async function texturedFixture() {
        return fixture({ pose: await generated([
          { ...rectangle, color: [40, 80, 160] },
          ...Array.from({ length: 10 }, (_, index) => ({ left: 21 + index * 2, top: 20, width: 1, height: 40,
            color: [60, 120, 200] as [number, number, number] })),
        ]) });
      }

      it("retains fine source texture and chroma in the interior when the provider returns a smooth grey product", async () => {
        const f = await texturedFixture(), overlay = f.isolated.overlays[0]!;
        const generated = await solid(120, 80, "#808080");
        const raw = await rgb(await transfer(f, generated));
        const result = await rgb(await textureTransfer(f, generated));
        const original = await rgb(f.isolated.image);
        const points = [overlay.left + 9, overlay.left + 10], y = overlay.top + 20;
        expect(pixel(raw, points[0]!, y)).toEqual(pixel(raw, points[1]!, y));
        expect(Math.abs(pixel(result, points[0]!, y)[0]! - pixel(result, points[1]!, y)[0]!)).toBeGreaterThan(15);
        for (const x of points) {
          const source = pixel(original, x, y), restored = pixel(result, x, y);
          const gain = restored[0]! / source[0]!;
          expect(gain).toBeGreaterThanOrEqual(0.5);
          expect(gain).toBeLessThanOrEqual(1.625);
          for (let channel = 0; channel < 3; channel++) expect(Math.abs(restored[channel]! - Math.min(255, source[channel]! * gain))).toBeLessThanOrEqual(2.5);
        }
      });

      it("keeps all support, shadow, translucent fringe and outer product edges bit-for-bit equal to bounded RGB", async () => {
        const f = await fixture(), overlay = f.isolated.overlays[0]!;
        const generated = await solid(120, 80, "#303030");
        const raw = await rgb(await transfer(f, generated)), textured = await rgb(await textureTransfer(f, generated));
        const alpha = await sharp(overlay.png).extractChannel("alpha").raw().toBuffer();
        const at = (x: number, y: number) => x >= 0 && y >= 0 && x < overlay.widthPx && y < overlay.heightPx ? alpha[y * overlay.widthPx + x]! : 0;
        let comparedEdges = 0;
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const ox = x - overlay.left, oy = y - overlay.top;
          const outer = at(ox, oy) < 250 || [-1, 0, 1].some(dy => [-1, 0, 1].some(dx => at(ox + dx, oy + dy) < 250));
          if (!outer) continue;
          if (at(ox, oy) > 0) comparedEdges++;
          expect(pixel(textured, x, y)).toEqual(pixel(raw, x, y));
        }
        expect(comparedEdges).toBeGreaterThan(100);
      });

      it.each([["#000000", 0.5], ["#ffffff", 1.6]] as const)("bounds interior light gain for a %s provider without destroying native texture", async (colour, gain) => {
        const f = await texturedFixture(), overlay = f.isolated.overlays[0]!;
        const output = await rgb(await textureTransfer(f, await solid(120, 80, colour)));
        const before = await rgb(f.isolated.image);
        const x = overlay.left + 8, y = overlay.top + 20;
        expect(pixel(output, x, y)).toEqual(pixel(before, x, y).map(channel => Math.min(255, Math.round(channel * gain))));
      });

      it("preserves the provider's smooth lighting gradient over the same native texture", async () => {
        const f = await texturedFixture(), overlay = f.isolated.overlays[0]!;
        const data = await sharp(f.padded.imageWebp).removeAlpha().raw().toBuffer();
        for (let y = 0; y < f.padded.paddedHeight; y++) for (let x = 0; x < f.padded.paddedWidth; x++) {
          const value = Math.round(45 + y * 1.1), i = (y * f.padded.paddedWidth + x) * 3;
          data[i] = value; data[i + 1] = value; data[i + 2] = value;
        }
        const generated = await sharp(data, { raw: { width: f.padded.paddedWidth, height: f.padded.paddedHeight, channels: 3 } }).png().toBuffer();
        const output = await rgb(await textureTransfer(f, generated));
        const x = overlay.left + 8;
        expect(pixel(output, x, overlay.top + 28)[0]).toBeGreaterThan(pixel(output, x, overlay.top + 10)[0]!);
      });

      it("keeps the historical default and explicit opt-out byte-identical", async () => {
        const f = await fixture(), generated = await solid(120, 80, "#808080");
        expect(await harmonizeStorefrontIsolatedProducts({ ...f, generated, transferMode: "bounded-rgb", preserveProductTexture: false }))
          .toEqual(await transfer(f, generated));
        expect(await harmonizeStorefrontIsolatedProducts({ ...f, generated, preserveProductTexture: true }))
          .toEqual(await harmonizeStorefrontIsolatedProducts({ ...f, generated }));
      });
    });
  });
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
    const result = await compose(image, [object({ dimensionsCm: {
      width: alpha < 128 ? 9 : 10, height: 20, depth: 10,
    } })]);
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

  it("uses the visible core for physical width while preserving uniformly scaled edge fringes", async () => {
    const image = await generated([rectangle,
      { left: 19, top: 20, width: 1, height: 40, color: [240, 10, 20], alpha: 64 },
      { left: 40, top: 20, width: 1, height: 40, color: [240, 10, 20], alpha: 64 },
    ]);
    const result = await compose(image, [object({ dimensionsCm: { width: 20, height: 40, depth: 20 } })]);
    expect(result.placements[0]).toMatchObject({ widthPx: 44, heightPx: 80 });
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

  it.each([1, 2])("tolerates invisible alpha %i noise without extending the product or changing room pixels", async alpha => {
    const image = await generated([rectangle,
      { left: 0, top: 0, width: 80, height: 1, color: [0, 255, 0], alpha },
      { left: 60, top: 10, width: 3, height: 3, color: [0, 255, 0], alpha },
    ]);
    const baseline = await compose(await generated([rectangle]));
    const result = await compose(image);
    expect(result.placements).toEqual(baseline.placements);
    expect(await rgb(result.image)).toEqual(await rgb(baseline.image));
  });

  it("drops only tiny disconnected near-invisible fringes after the alpha floor", async () => {
    const image = await generated([rectangle,
      { left: 60, top: 10, width: 2, height: 2, color: [0, 255, 0], alpha: 5 },
    ]);
    expect(await rgb((await compose(image)).image)).toEqual(await rgb((await compose(await generated([rectangle]))).image));
  });

  it.each([8, 16])("continues rejecting disconnected visible alpha %i debris", async alpha => {
    const image = await generated([rectangle,
      { left: 60, top: 10, width: 3, height: 3, color: [0, 255, 0], alpha },
    ]);
    await expect(compose(image)).rejects.toThrow(/séparés/);
  });

  it("refuses broad faint disconnected contamination even below alpha eight", async () => {
    const image = await generated([rectangle,
      { left: 50, top: 10, width: 20, height: 10, color: [0, 255, 0], alpha: 5 },
    ]);
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
