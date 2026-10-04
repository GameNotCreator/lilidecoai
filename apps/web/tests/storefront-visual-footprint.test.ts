import { describe, expect, it } from "vitest";
import { fitStorefrontVisualPoint, storefrontVisualFootprint } from "../lib/storefront-visual-footprint";
import type { StorefrontProduct } from "../lib/storefront";

const product = { widthCm: 20, heightCm: 30, depthCm: 10, objectType: "vase", placementType: "table" } as StorefrontProduct;
describe("visual footprint", () => {
  it("anchors a standing article to its visible bottom and preserves the catalogue ratio in landscape", () => {
    const guide = storefrontVisualFootprint(product, { widthPx: 1000, heightPx: 800 }, { x: 0.5, y: 0.7 }, 0.2);
    expect(guide.width).toBeCloseTo(0.2);
    expect(guide.height).toBeCloseTo(0.375);
    expect(guide.xMin).toBeCloseTo(0.4);
    expect(guide.yMin + guide.height).toBeCloseTo(0.7);
  });
  it("shrinks a requested guide to keep its whole footprint inside the photo", () => {
    const guide = storefrontVisualFootprint(product, { widthPx: 1000, heightPx: 800 }, { x: 0.85, y: 0.3 }, 0.6);
    expect(guide.width).toBeLessThan(0.6);
    expect(guide.xMin).toBeGreaterThanOrEqual(0);
    expect(guide.xMin + guide.width).toBeLessThanOrEqual(1);
    expect(guide.yMin).toBeCloseTo(0);
  });
  it("centers wall and flat guides with the appropriate catalogue dimensions", () => {
    const wall = storefrontVisualFootprint({ ...product, placementType: "wall" }, { widthPx: 800, heightPx: 800 }, { x: 0.5, y: 0.5 }, 0.2);
    expect(wall.yMin + wall.height / 2).toBeCloseTo(0.5);
    const rug = storefrontVisualFootprint({ ...product, objectType: "rug", placementType: "floor" }, { widthPx: 800, heightPx: 800 }, { x: 0.5, y: 0.5 }, 0.2);
    expect(rug.height).toBeCloseTo(0.1);
    expect(rug.yMin).toBeCloseTo(0.45);
  });
});


it("nudges an extreme edge tap inside the photo so the minimum guide stays complete", () => {
  const scene = { widthPx: 1000, heightPx: 800 };
  for (const tap of [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0.001, y: 0.005 }]) {
    const point = fitStorefrontVisualPoint(product, scene, tap);
    const guide = storefrontVisualFootprint(product, scene, point, 0.18);
    expect(guide.width).toBeGreaterThanOrEqual(0.02);
    expect(guide.xMin).toBeGreaterThanOrEqual(-1e-9);
    expect(guide.yMin).toBeGreaterThanOrEqual(-1e-9);
    expect(guide.xMin + guide.width).toBeLessThanOrEqual(1 + 1e-9);
    expect(guide.yMin + guide.height).toBeLessThanOrEqual(1 + 1e-9);
  }
});
