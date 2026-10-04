import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { projectPoint, solveHomography, manualPlacementQuad } from "@lili/geometry";
import type { CutoutMetadata } from "@lili/types";
import { composeManualProducts, dilateManualAlpha, localiseManualComposition, manualEditContracts, manualCleanupPrompt, manualPhotographicPrompt } from "../lib/server/manual-composition";
import { padCompositionForAspect } from "../lib/server/simple-composite";
import { restoreRoomIntegrationBackground, restoreLocalRoomIntegrationBackground } from "../lib/server/storefront-room-integration";

const width = 320, height = 240;
const box = { xMin: 0.2, yMin: 0.1, xMax: 0.8, yMax: 0.8 };
const plane: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }] =
  [{ x: 0.3, y: 0.3 }, { x: 0.7, y: 0.35 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.85 }];
const room = () => sharp({ create: { width, height, channels: 3, background: "#456789" } }).webp({ lossless: true }).toBuffer();
async function standingCutout() {
  const data = Buffer.alloc(60 * 100 * 4);
  for (let y = 0; y < 100; y++) for (let x = 0; x < 60; x++) {
    const i = (y * 60 + x) * 4;
    data[i] = 220; data[i + 1] = 30; data[i + 2] = 40;
    data[i + 3] = y < 20 && (x < 10 || x >= 50) ? 0 : 255;
  }
  return sharp(data, { raw: { width: 60, height: 100, channels: 4 } }).png().toBuffer();
}

describe("manual composition geometry and photographic output", () => {
  it("dilates a single alpha pixel into exactly thirteen pixels at disk radius two", async () => {
    const singlePixel = Buffer.alloc(9 * 9);
    singlePixel[4 * 9 + 4] = 255;
    const disk = await dilateManualAlpha(singlePixel, 9, 9, 2);
    expect(disk.filter(value => value > 0)).toHaveLength(13);
    for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++)
      expect(disk[y * 9 + x]! > 0).toBe((x - 4) ** 2 + (y - 4) ** 2 <= 4);
  });
  it("fits source proportions in the chosen box, anchors at its bottom and keeps transparent corners", async () => {
    const scene = await room();
    const composition = await composeManualProducts(scene, width, height,
      [{ cutout: await standingCutout(), placement: { box }, kind: "standing" }]);
    const placed = composition.manualPlacements[0]!;
    expect(placed.contact).toEqual({ x: 0.5, y: 0.8 });
    const q = placed.quad;
    expect((q[1].x - q[0].x) * width / ((q[3].y - q[0].y) * height)).toBeCloseTo(0.6, 8);
    const decoded = await sharp(composition.imageWebp).raw().toBuffer();
    const overlay = composition.overlays[0]!;
    const transparentCorner = (overlay.top * width + overlay.left) * 3;
    expect([...decoded.subarray(transparentCorner, transparentCorner + 3)]).toEqual([69, 103, 137]);
    expect(composition.maskRaw[3]).toBe(255);
  });

  it.each(["flat", "wall"] as const)("projects %s texture through all four corners rather than a screen rectangle", async kind => {
    const raw = Buffer.alloc(80 * 80 * 4, 255);
    for (let y = 0; y < 80; y++) for (let x = 0; x < 80; x++) {
      const i = (y * 80 + x) * 4;
      raw[i] = x < 40 ? 220 : 20; raw[i + 1] = y < 40 ? 180 : 30; raw[i + 2] = 50;
      if (x < 8 && y < 8) raw[i + 3] = 0;
    }
    const cutout = await sharp(raw, { raw: { width: 80, height: 80, channels: 4 } }).png().toBuffer();
    const composition = await composeManualProducts(await room(), width, height,
      [{ cutout, placement: { box: { xMin: 0.1, yMin: 0.1, xMax: 0.9, yMax: 0.9 }, plane }, kind }]);
    const quad = composition.manualPlacements[0]!.quad;
    expect(quad[0].y).not.toBe(quad[1].y);
    expect(quad[2].x - quad[3].x).toBeGreaterThan(quad[1].x - quad[0].x);
    const forward = solveHomography([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], quad);
    const projectedCenter = projectPoint(forward, { x: 0.5, y: 0.5 });
    expect(composition.manualPlacements[0]!.contact.x).toBeCloseTo(projectedCenter.x);
    expect(composition.manualPlacements[0]!.contact.y).toBeCloseTo(projectedCenter.y);
    const image = await sharp(composition.imageWebp).raw().toBuffer();
    for (const [uv, color] of [[{ x: 0.25, y: 0.25 }, [220, 180, 50]], [{ x: 0.75, y: 0.75 }, [20, 30, 50]]] as const) {
      const point = projectPoint(forward, uv);
      const offset = (Math.floor(point.y * height) * width + Math.floor(point.x * width)) * 3;
      expect([...image.subarray(offset, offset + 3)]).toEqual(color);
    }
    const overlay = composition.overlays[0]!;
    const outsideQuad = (overlay.top * width + overlay.left) * 3;
    expect([...image.subarray(outsideQuad, outsideQuad + 3)]).toEqual([69, 103, 137]);
  });

  it("rejects opaque/empty catalog images but reuses a verified tightly trimmed planar product", async () => {
    const opaque = await sharp({ create: { width: 80, height: 60, channels: 3, background: "#aa2222" } }).webp({ lossless: true }).toBuffer();
    const preparation: CutoutMetadata = { widthPx: 80, heightPx: 60, baseRowFraction: 1,
      source: "heuristic", synthetic: false, shadowRemoved: false, warnings: [], cutoutVersion: "cutout-v-test",
      verdict: { usable: true, code: "ok", detail: "" } };
    await expect(composeManualProducts(await room(), width, height, [{ cutout: opaque, placement: { box }, kind: "standing" }])).rejects.toThrow("transparent");
    await expect(composeManualProducts(await room(), width, height, [{ cutout: opaque, placement: { box, plane }, kind: "flat" }])).rejects.toThrow("transparent");
    await expect(composeManualProducts(await room(), width, height, [{ cutout: opaque, preparation,
      placement: { box, plane }, kind: "flat" }])).resolves.toHaveProperty("manualPlacements");
    const empty = await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    await expect(composeManualProducts(await room(), width, height, [{ cutout: empty, placement: { box }, kind: "standing" }])).rejects.toThrow("vide");
    await expect(composeManualProducts(await room(), width, height, [{ cutout: opaque,
      preparation: { ...preparation, widthPx: 79 }, placement: { box, plane }, kind: "wall" }])).rejects.toThrow();
  });

  it("requires a plane only for floor and wall products", async () => {
    const cutout = await standingCutout();
    await expect(composeManualProducts(await room(), width, height, [{ cutout, placement: { box }, kind: "flat" }])).rejects.toThrow("quatre coins");
    await expect(composeManualProducts(await room(), width, height, [{ cutout, placement: { box, plane }, kind: "standing" }])).rejects.toThrow("boîte");
  });

  it("confines the product body to its fixed envelope while retaining a separate shadow window below contact", async () => {
    const composition = await composeManualProducts(await room(), width, height,
      [{ cutout: await standingCutout(), placement: { box }, kind: "standing" }]);
    const overlay = composition.overlays[0]!;
    const alpha = (x: number, y: number) => composition.maskRaw[(y * width + x) * 4 + 3];
    const midY = Math.round(overlay.top + overlay.heightPx / 2);
    expect(alpha(overlay.left - 3, midY)).toBe(255);
    expect(alpha(overlay.left - 1, midY)).toBe(0);
    expect(alpha(overlay.left + Math.round(overlay.widthPx / 2), overlay.top - 3)).toBe(255);
    expect(alpha(Math.round(overlay.baseX + overlay.widthPx * 0.6),
      Math.round(overlay.baseY + overlay.heightPx * 0.05))).toBe(0);
  });

  it.each(["flat", "wall"] as const)("uses the real circular %s silhouette with a bounded margin and blends only its outer edge to the source room", async kind => {
    const circleRaw = Buffer.alloc(100 * 100 * 4);
    for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) {
      const i = (y * 100 + x) * 4;
      circleRaw[i] = 220; circleRaw[i + 1] = 30; circleRaw[i + 2] = 40;
      circleRaw[i + 3] = Math.hypot(x + 0.5 - 50, y + 0.5 - 50) <= 49.5 ? 255 : 0;
    }
    const cutout = await sharp(circleRaw, { raw: { width: 100, height: 100, channels: 4 } }).png().toBuffer();
    const composition = await composeManualProducts(await room(), width, height, [{ cutout, kind,
      placement: { box: { xMin: 0, yMin: 0, xMax: 1, yMax: 1 },
        plane: [{ x: 0.3, y: 0.2 }, { x: 0.7, y: 0.2 }, { x: 0.7, y: 0.8 }, { x: 0.3, y: 0.8 }] } }]);
    const overlay = composition.overlays[0]!;
    const centerX = Math.floor(overlay.left + overlay.widthPx / 2);
    const centerY = Math.floor(overlay.top + overlay.heightPx / 2);
    const alpha = (x: number, y: number) => composition.maskRaw[(y * width + x) * 4 + 3];
    const margin = Math.min(32, Math.round(Math.min(overlay.widthPx, overlay.heightPx) * 0.20));
    expect(alpha(overlay.left - margin, overlay.top - margin)).toBe(255);
    const projectedAlpha = await sharp(overlay.png).extractChannel("alpha").raw().toBuffer();
    let diagonal = { x: width, y: height };
    for (let y = 0; y < overlay.heightPx; y++) for (let x = 0; x < overlay.widthPx; x++)
      if (projectedAlpha[y * overlay.widthPx + x]! > 8 && x + y < diagonal.x + diagonal.y) diagonal = { x, y };
    // A square dilation would open this point at sqrt(2) times the allowed radius.
    expect(alpha(overlay.left + diagonal.x - margin, overlay.top + diagonal.y - margin)).toBe(255);
    expect(alpha(centerX, overlay.top + overlay.heightPx + 8)).toBe(0);
    expect(alpha(centerX, centerY)).toBe(0);
    expect(alpha(overlay.left - margin - 1, centerY)).toBe(255);
    const local = await localiseManualComposition(composition);
    const padded = await padCompositionForAspect(local.composition, "1536x1024", { exactRasterAspect: true });
    const generated = await sharp({ create: { width: padded.paddedWidth, height: padded.paddedHeight, channels: 3,
      background: "#22aa44" } }).png().toBuffer();
    const restored = await sharp(await restoreLocalRoomIntegrationBackground(composition, local.window, padded, generated,
      { edgeFeatherPx: 5 })).raw().toBuffer();
    const source = await sharp(composition.sceneWebp!).raw().toBuffer();
    for (let pixel = 0; pixel < width * height; pixel++)
      if (composition.maskRaw[pixel * 4 + 3] === 255)
        expect(restored.subarray(pixel * 3, pixel * 3 + 3)).toEqual(source.subarray(pixel * 3, pixel * 3 + 3));
    const center = (centerY * width + centerX) * 3;
    expect([...restored.subarray(center, center + 3)]).toEqual([34, 170, 68]);
    let firstEditable = overlay.left - margin;
    while (alpha(firstEditable, centerY) !== 0) firstEditable++;
    const edge = (centerY * width + firstEditable + 3) * 3;
    expect(restored[edge]).toBeGreaterThan(34);
    expect(restored[edge]).toBeLessThan(69);
    // The transition mixes generated RGB with the real room, never red catalogue pixels.
    expect(restored[edge]).toBeLessThan(220);
    const protectedCorner = ((overlay.top - margin) * width + overlay.left - margin) * 3;
    expect([...restored.subarray(protectedCorner, protectedCorner + 3)])
      .toEqual([69, 103, 137]);
  });

  it("keeps even a small planar body entirely generated beyond the five-pixel source blend", async () => {
    const composition = await composeManualProducts(await room(), width, height, [{ cutout: await standingCutout(), kind: "wall",
      placement: { box: { xMin: 0, yMin: 0, xMax: 1, yMax: 1 },
        plane: [{ x: 0.45, y: 0.4 }, { x: 0.53, y: 0.4 }, { x: 0.53, y: 0.6 }, { x: 0.45, y: 0.6 }] } }]);
    const overlay = composition.overlays[0]!;
    expect(Math.min(overlay.widthPx, overlay.heightPx) * 0.20).toBeLessThan(6);
    const alpha = await sharp(overlay.png).extractChannel("alpha").raw().toBuffer();
    const local = await localiseManualComposition(composition);
    const padded = await padCompositionForAspect(local.composition, "1536x1024", { exactRasterAspect: true });
    const generated = await sharp({ create: { width: padded.paddedWidth, height: padded.paddedHeight, channels: 3,
      background: "#22aa44" } }).png().toBuffer();
    const restored = await sharp(await restoreLocalRoomIntegrationBackground(composition, local.window, padded, generated,
      { edgeFeatherPx: 5 })).raw().toBuffer();
    for (let y = 0; y < overlay.heightPx; y++) for (let x = 0; x < overlay.widthPx; x++) {
      if (alpha[y * overlay.widthPx + x]! <= 8) continue;
      const offset = ((y + overlay.top) * width + x + overlay.left) * 3;
      expect([...restored.subarray(offset, offset + 3)]).toEqual([34, 170, 68]);
    }
  });

  it("reviews a tilted ellipse by its real alpha bounds, keeps its quad and preserves a generated arc inside the larger disk margin", async () => {
    const circle = Buffer.alloc(100 * 100 * 4);
    for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) {
      const i = (y * 100 + x) * 4;
      circle[i] = 220; circle[i + 1] = 30; circle[i + 2] = 40;
      circle[i + 3] = Math.hypot(x + 0.5 - 50, y + 0.5 - 50) <= 49.5 ? 255 : 0;
    }
    const cutout = await sharp(circle, { raw: { width: 100, height: 100, channels: 4 } }).png().toBuffer();
    const composition = await composeManualProducts(await room(), width, height, [{ cutout, kind: "wall",
      placement: { box: { xMin: 0, yMin: 0, xMax: 1, yMax: 1 },
        plane: [{ x: 0.25, y: 0.2 }, { x: 0.75, y: 0.1 }, { x: 0.75, y: 0.8 }, { x: 0.25, y: 0.9 }] } }]);
    const overlay = composition.overlays[0]!;
    const alpha = await sharp(overlay.png).extractChannel("alpha").raw().toBuffer();
    const bounds = { left: width, top: height, right: 0, bottom: 0 };
    let topPixel = { x: 0, y: height };
    for (let y = 0; y < overlay.heightPx; y++) for (let x = 0; x < overlay.widthPx; x++) {
      if (alpha[y * overlay.widthPx + x]! <= 8) continue;
      const gx = overlay.left + x, gy = overlay.top + y;
      bounds.left = Math.min(bounds.left, gx); bounds.top = Math.min(bounds.top, gy);
      bounds.right = Math.max(bounds.right, gx + 1); bounds.bottom = Math.max(bounds.bottom, gy + 1);
      if (gy < topPixel.y) topPixel = { x: gx, y: gy };
    }
    const placed = composition.manualPlacements[0]!;
    expect(placed.box).toEqual({ xMin: bounds.left / width, yMin: bounds.top / height,
      xMax: bounds.right / width, yMax: bounds.bottom / height });
    expect(bounds.bottom - bounds.top).toBeLessThan(overlay.heightPx - 10);
    expect(placed.quad).toEqual(manualPlacementQuad(placed.fittedPlacement));
    expect(placed.quad[0].y).not.toBe(placed.quad[1].y);
    const local = await localiseManualComposition(composition);
    const padded = await padCompositionForAspect(local.composition, "1536x1024", { exactRasterAspect: true });
    const generatedRaw = Buffer.alloc(padded.paddedWidth * padded.paddedHeight * 3);
    for (let pixel = 0; pixel < padded.paddedWidth * padded.paddedHeight; pixel++)
      generatedRaw.set([95, 125, 155], pixel * 3);
    for (let y = 0; y < overlay.heightPx; y++) for (let x = 0; x < overlay.widthPx; x++) {
      if (alpha[y * overlay.widthPx + x]! <= 8) continue;
      const lx = x + overlay.left - local.window.left + padded.offsetX;
      const ly = y + overlay.top - 23 - local.window.top + padded.offsetY;
      if (ly >= 0) generatedRaw.set([34, 170, 68], (ly * padded.paddedWidth + lx) * 3);
    }
    const generated = await sharp(generatedRaw, { raw: { width: padded.paddedWidth, height: padded.paddedHeight, channels: 3 } }).png().toBuffer();
    const restored = await sharp(await restoreLocalRoomIntegrationBackground(composition, local.window, padded, generated,
      { edgeFeatherPx: 5 })).raw().toBuffer();
    const movedTop = ((topPixel.y - 23) * width + topPixel.x) * 3;
    expect([...restored.subarray(movedTop, movedTop + 3)]).toEqual([34, 170, 68]);
    const source = await sharp(composition.sceneWebp!).raw().toBuffer();
    for (let pixel = 0; pixel < width * height; pixel++)
      if (composition.maskRaw[pixel * 4 + 3] === 255)
        expect(restored.subarray(pixel * 3, pixel * 3 + 3)).toEqual(source.subarray(pixel * 3, pixel * 3 + 3));
  });

  it("retains generated perspective/occlusion inside the mask and exact source room pixels outside without re-stamping", async () => {
    const scene = await room();
    const composition = await composeManualProducts(scene, width, height,
      [{ cutout: await standingCutout(), placement: { box }, kind: "standing" }]);
    const padded = await padCompositionForAspect(composition, "1536x1024", { exactRasterAspect: true });
    const generated = await sharp({ create: { width: padded.paddedWidth, height: padded.paddedHeight, channels: 3, background: "#22aa44" } }).png().toBuffer();
    const restored = await sharp(await restoreRoomIntegrationBackground(composition, padded, generated)).raw().toBuffer();
    const source = await sharp(scene).raw().toBuffer();
    for (let pixel = 0; pixel < width * height; pixel++)
      if (composition.maskRaw[pixel * 4 + 3] === 255)
        expect(restored.subarray(pixel * 3, pixel * 3 + 3)).toEqual(source.subarray(pixel * 3, pixel * 3 + 3));
    const center = (Math.floor(0.5 * height) * width + Math.floor(0.5 * width)) * 3;
    expect([...restored.subarray(center, center + 3)]).toEqual([34, 170, 68]);
    const crop = await sharp(generated).extract({ left: 0, top: 0, width: 100, height: 100 }).png().toBuffer();
    await expect(restoreRoomIntegrationBackground(composition, padded, crop)).rejects.toThrow();
  });

  it.each([
    { boxes: [{ xMin: 0.7, yMin: 0.55, xMax: 0.82, yMax: 0.75 }] },
    { boxes: [{ xMin: 0, yMin: 0, xMax: 0.15, yMax: 0.25 }] },
    { boxes: [{ xMin: 0.12, yMin: 0.1, xMax: 0.25, yMax: 0.3 }, { xMin: 0.62, yMin: 0.55, xMax: 0.75, yMax: 0.75 }] },
  ])("crops montage, source and all editable pixels together, including borders and multiple products (%j)", async ({ boxes }) => {
    const sourceRaw = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 3;
      sourceRaw[index] = x % 256; sourceRaw[index + 1] = y; sourceRaw[index + 2] = 137;
    }
    const scene = await sharp(sourceRaw, { raw: { width, height, channels: 3 } }).webp({ lossless: true }).toBuffer();
    const cutout = await standingCutout();
    const composition = await composeManualProducts(scene, width, height,
      boxes.map(selectedBox => ({ cutout, placement: { box: selectedBox }, kind: "standing" })));
    const local = await localiseManualComposition(composition);
    const window = local.window;
    expect(window.width).toBeLessThan(width);
    expect(window.height).toBeLessThan(height);
    if (boxes[0]!.xMin === 0) expect(window).toMatchObject({ left: 0, top: 0 });
    const montage = await sharp(composition.baseWebp).raw().toBuffer();
    const [localRoom, localMontage] = await Promise.all([
      sharp(local.composition.sceneWebp!).raw().toBuffer(), sharp(local.composition.baseWebp).raw().toBuffer(),
    ]);
    expect(localMontage.equals(localRoom)).toBe(false);
    for (let y = 0; y < window.height; y++) {
      const offset = ((y + window.top) * width + window.left);
      expect(localRoom.subarray(y * window.width * 3, (y + 1) * window.width * 3))
        .toEqual(sourceRaw.subarray(offset * 3, (offset + window.width) * 3));
      expect(localMontage.subarray(y * window.width * 3, (y + 1) * window.width * 3))
        .toEqual(montage.subarray(offset * 3, (offset + window.width) * 3));
      expect(local.composition.maskRaw.subarray(y * window.width * 4, (y + 1) * window.width * 4))
        .toEqual(composition.maskRaw.subarray(offset * 4, (offset + window.width) * 4));
    }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (composition.maskRaw[(y * width + x) * 4 + 3] !== 0) continue;
      expect(x >= window.left && x < window.left + window.width && y >= window.top && y < window.top + window.height).toBe(true);
    }
    const padded = await padCompositionForAspect(local.composition, "1536x1024", { exactRasterAspect: true });
    const contracts = manualEditContracts(composition, window, padded);
    for (const [index, contract] of contracts.entries()) {
      for (const [pointIndex, point] of [...contract.quad, contract.contact].entries()) {
        const expected = [...composition.manualPlacements[index]!.quad, composition.manualPlacements[index]!.contact][pointIndex]!;
        expect(point.x).toBeGreaterThanOrEqual(0); expect(point.x).toBeLessThanOrEqual(1);
        expect(point.y).toBeGreaterThanOrEqual(0); expect(point.y).toBeLessThanOrEqual(1);
        expect(point.x * padded.paddedWidth - padded.offsetX + window.left).toBeCloseTo(expected.x * width, 3);
        expect(point.y * padded.paddedHeight - padded.offsetY + window.top).toBeCloseTo(expected.y * height, 3);
        // The same normalized point locates the product after native output scaling.
        expect(point.x * 1536 / (1536 / padded.paddedWidth)).toBeCloseTo(point.x * padded.paddedWidth, 8);
      }
    }
    const generated = await sharp({ create: { width: 1536, height: 1024, channels: 3, background: "#22aa44" } }).png().toBuffer();
    const restored = await sharp(await restoreLocalRoomIntegrationBackground(composition, window, padded, generated))
      .raw().toBuffer({ resolveWithObject: true });
    expect(restored.info).toMatchObject({ width, height });
    for (let pixel = 0; pixel < width * height; pixel++)
      if (composition.maskRaw[pixel * 4 + 3] === 255)
        expect(restored.data.subarray(pixel * 3, pixel * 3 + 3)).toEqual(sourceRaw.subarray(pixel * 3, pixel * 3 + 3));
    const overlay = composition.overlays[0]!;
    const center = (Math.floor(overlay.top + overlay.heightPx / 2) * width + Math.floor(overlay.left + overlay.widthPx / 2)) * 3;
    expect([...restored.data.subarray(center, center + 3)]).toEqual([34, 170, 68]);
  });

  it("uses short prompts that describe the actual image order and alpha mask without inferring physical scale", () => {
    const prompt = manualPhotographicPrompt(2, true);
    expect(prompt.length).toBeLessThan(1800);
    expect(prompt).toContain("images 2 à 3");
    expect(prompt).toContain("occultations");
    expect(prompt).toContain("masque alpha");
    expect(prompt).not.toContain("cm");
    expect(prompt).toContain("ne les agrandis pas");
    expect(prompt).toContain("anses, poignées, pieds, couvercle");
    expect(prompt).toContain("élément existant réellement situé devant");
    const withData = manualPhotographicPrompt(1, false, [{ product: 1, kind: "standing",
      quad: [{ x: 0.2, y: 0.1 }, { x: 0.6, y: 0.1 }, { x: 0.6, y: 0.8 }, { x: 0.2, y: 0.8 }], contact: { x: 0.4, y: 0.8 } }]);
    expect(withData).toContain('"contact":{"x":0.4,"y":0.8}');
    expect(withData).toContain("fractions 0..1 du canevas entier");
    expect(withData).toContain("fractions restent identiques dans la sortie");
    expect(manualCleanupPrompt(true)).toContain("ne place aucun nouveau produit");
    expect(manualCleanupPrompt(true)).toContain("meuble support");
  });
});
