import { describe, expect, it } from "vitest";
import {
  ASSUMED_ROOM_WIDTH_CM,
  MIN_OBJECT_PX,
  computeSimplePlacement,
  containedImageRect,
  footprintsCollide,
  normalizeTap,
  orderByDepth,
} from "../src/index";

describe("computeSimplePlacement — scale", () => {
  it("keeps the vision scale for small objects instead of inflating them", () => {
    // 12 cm object at 4 px/cm on a 2048 px scene: 48 px, well under the old
    // 3.5 % floor (71.7 px) that used to turn it into a 43 cm object.
    const result = computeSimplePlacement({
      sceneWidth: 2048,
      sceneHeight: 1536,
      point: { x: 0.5, y: 0.7 },
      cutout: { widthPx: 100, heightPx: 100 },
      dimensions: { mode: "height_length", heightCm: 12, lengthCm: 12 },
      pixelsPerCm: 4,
    });
    expect(result.widthPx).toBe(48);
    expect(result.heightPx).toBe(48);
    expect(result.scaleSource).toBe("vision");
    expect(result.clamped).toBe(false);
    expect(result.sizeFactor).toBe(1);
  });

  it("does not inflate a narrow object when the scale is a guess either", () => {
    // 2048 px long side / 300 cm = 6.83 px/cm. A 10 x 40 cm vase is 68 x 273
    // px: narrow, but exactly right. A floor at 3.5 % of the frame width used
    // to grow it to 72 px wide and 287 px tall, i.e. a 42 cm vase.
    const result = computeSimplePlacement({
      sceneWidth: 2048,
      sceneHeight: 1536,
      point: { x: 0.5, y: 0.7 },
      cutout: { widthPx: 100, heightPx: 400 },
      dimensions: { mode: "height_length", heightCm: 40, lengthCm: 10 },
      pixelsPerCm: null,
    });
    expect(result.scaleSource).toBe("assumed_room_width");
    expect(result.sizeFactor).toBe(1);
    expect(result.clamped).toBe(false);
    expect(result.impliedHeightCm).toBeCloseTo(40, 1);
  });

  it("uses the long side for the room-width fallback on portrait photos", () => {
    const result = computeSimplePlacement({
      sceneWidth: 600,
      sceneHeight: 800,
      point: { x: 0.5, y: 0.8 },
      cutout: { widthPx: 50, heightPx: 100 },
      dimensions: { mode: "height_length", heightCm: 60, lengthCm: 30 },
      pixelsPerCm: null,
    });
    // 800 px / 300 cm = 2.667 px/cm.
    expect(result.pixelsPerCm).toBeCloseTo(800 / ASSUMED_ROOM_WIDTH_CM, 6);
    expect(result.heightPx).toBe(160);
    expect(result.widthPx).toBe(80);
  });

  it("preserves measured tiny objects instead of enlarging them twelvefold", () => {
    const result = computeSimplePlacement({
      sceneWidth: 1000,
      sceneHeight: 800,
      point: { x: 0.5, y: 0.5 },
      cutout: { widthPx: 100, heightPx: 100 },
      dimensions: { mode: "height_length", heightCm: 1, lengthCm: 1 },
      pixelsPerCm: 2,
    });
    expect(Math.max(result.widthPx, result.heightPx)).toBe(2);
    expect(result.clamped).toBe(false);
    expect(result.impliedHeightCm).toBe(1);
  });

  it("never inflates a thin object to reach the minimum", () => {
    // A 5 x 30 cm candle at 2 px/cm is 10 x 60 px: a legitimate sliver. A
    // floor on the smallest side would have doubled its real height.
    const result = computeSimplePlacement({
      sceneWidth: 1000,
      sceneHeight: 800,
      point: { x: 0.5, y: 0.8 },
      cutout: { widthPx: 50, heightPx: 300 },
      dimensions: { mode: "height_length", heightCm: 30, lengthCm: 5 },
      pixelsPerCm: 2,
    });
    expect(result.heightPx).toBe(60);
    expect(result.widthPx).toBe(10);
    expect(result.sizeFactor).toBe(1);
    expect(result.clamped).toBe(false);
  });

  it("caps calibrated objects at 1.5x the frame while keeping the aspect", () => {
    const result = computeSimplePlacement({
      sceneWidth: 1000,
      sceneHeight: 800,
      point: { x: 0.5, y: 0.9 },
      cutout: { widthPx: 100, heightPx: 100 },
      dimensions: { mode: "height_length", heightCm: 400, lengthCm: 400 },
      pixelsPerCm: 10,
    });
    expect(result.widthPx).toBeLessThanOrEqual(1500);
    expect(result.heightPx).toBeLessThanOrEqual(1200);
    expect(Math.abs(result.widthPx / result.heightPx - 1)).toBeLessThanOrEqual(
      0.05,
    );
    expect(result.clamped).toBe(true);
  });

  it("anchors on height and reports the length consistency", () => {
    // Three-quarter sofa: 85 cm tall, 220 cm long, but the silhouette is 1.6.
    const result = computeSimplePlacement({
      sceneWidth: 2000,
      sceneHeight: 1500,
      point: { x: 0.5, y: 0.8 },
      cutout: { widthPx: 160, heightPx: 100 },
      dimensions: { mode: "height_length", heightCm: 85, lengthCm: 220 },
      pixelsPerCm: 2,
    });
    expect(result.heightPx).toBe(170);
    expect(result.widthPx).toBe(272);
    expect(result.dimensionConsistency).toBeCloseTo(220 / 85 / 1.6, 6);
    const consistent = computeSimplePlacement({
      sceneWidth: 2000,
      sceneHeight: 1500,
      point: { x: 0.5, y: 0.8 },
      cutout: { widthPx: 50, heightPx: 100 },
      dimensions: { mode: "height_length", heightCm: 40, lengthCm: 20 },
      pixelsPerCm: 2,
    });
    expect(consistent.dimensionConsistency).toBeCloseTo(1, 6);
    expect(consistent.widthPx).toBe(40);
    expect(consistent.heightPx).toBe(80);
  });

  it("uses both entered sides of a footprint, not the photo's aspect", () => {
    // A 200 x 100 cm rug photographed in a 4:1 frame. Deriving the depth from
    // that framing would draw it a third too shallow; both numbers are the
    // customer's measurements and both are used.
    const rug = computeSimplePlacement({
      sceneWidth: 2000,
      sceneHeight: 1500,
      point: { x: 0.5, y: 0.8 },
      cutout: { widthPx: 400, heightPx: 100 },
      dimensions: { mode: "length_width", lengthCm: 200, widthCm: 100 },
      pixelsPerCm: 2,
      kind: "flat",
    });
    expect(rug.widthPx).toBe(400);
    expect(rug.heightPx).toBe(90); // 100 cm x 2 px/cm x 0.45 foreshortening
    expect(rug.dimensionConsistency).toBeCloseTo(400 / 90 / 4, 4);
  });

  it("swaps the footprint axes when the photo is a portrait", () => {
    const rug = computeSimplePlacement({
      sceneWidth: 2000,
      sceneHeight: 1500,
      point: { x: 0.5, y: 0.8 },
      cutout: { widthPx: 100, heightPx: 400 },
      dimensions: { mode: "length_width", lengthCm: 200, widthCm: 100 },
      pixelsPerCm: 2,
      kind: "flat",
    });
    // Long side away from the camera: 100 cm across, 200 cm deep foreshortened.
    expect(rug.widthPx).toBe(200);
    expect(rug.heightPx).toBe(180);
  });

  it("foreshortens flat objects and measures their footprint", () => {
    const rug = computeSimplePlacement({
      sceneWidth: 2000,
      sceneHeight: 1500,
      point: { x: 0.5, y: 0.8 },
      cutout: { widthPx: 200, heightPx: 100 },
      dimensions: { mode: "length_width", lengthCm: 200, widthCm: 100 },
      pixelsPerCm: 2,
      kind: "flat",
    });
    expect(rug.widthPx).toBe(400);
    expect(rug.heightPx).toBe(90);
    // Centred on the point.
    expect(rug.top).toBe(1200 - 45);
  });
});

describe("computeSimplePlacement — anchoring", () => {
  it("never moves the base: a tall object is cropped by the frame, not pushed down", () => {
    const result = computeSimplePlacement({
      sceneWidth: 300,
      sceneHeight: 200,
      point: { x: 0.5, y: 0.2 },
      cutout: { widthPx: 50, heightPx: 100 },
      dimensions: { mode: "height_length", heightCm: 60, lengthCm: 30 },
      pixelsPerCm: 4,
    });
    expect(result.baseY).toBe(40);
    expect(result.heightPx).toBe(240);
    expect(result.top).toBe(-200);
    expect(result.visible).toEqual({
      left: 90,
      top: 0,
      width: 120,
      height: 40,
    });
    expect(result.croppedByFrame).toBeCloseTo(1 - (120 * 40) / (120 * 240), 6);
  });

  it("honours a measured base row inside the cutout", () => {
    const result = computeSimplePlacement({
      sceneWidth: 1000,
      sceneHeight: 1000,
      point: { x: 0.5, y: 0.15 },
      cutout: { widthPx: 100, heightPx: 100, baseRowFraction: 0.9 },
      dimensions: { mode: "height_length", heightCm: 100, lengthCm: 100 },
      pixelsPerCm: 1,
    });
    expect(result.baseY).toBe(150);
    expect(result.top).toBe(50);
    expect(result.heightPx).toBe(111);
    expect(result.impliedHeightCm).toBeCloseTo(100, 0);
  });

  it("centres wall objects on the point and sorts them behind", () => {
    const frame = computeSimplePlacement({
      sceneWidth: 1000,
      sceneHeight: 1000,
      point: { x: 0.5, y: 0.3 },
      cutout: { widthPx: 100, heightPx: 100 },
      dimensions: { mode: "height_length", heightCm: 100, lengthCm: 100 },
      pixelsPerCm: 1,
      kind: "wall",
    });
    expect(frame.top).toBe(250);
    expect(frame.depthKey).toBe(250);
    expect(frame.visible).toEqual({
      left: 450,
      top: 250,
      width: 100,
      height: 100,
    });
  });

  it("reports nothing visible when the box leaves the frame entirely", () => {
    const result = computeSimplePlacement({
      sceneWidth: 100,
      sceneHeight: 100,
      point: { x: 0, y: 0 },
      cutout: { widthPx: 10, heightPx: 10 },
      dimensions: { mode: "height_length", heightCm: 30, lengthCm: 30 },
      pixelsPerCm: 1,
    });
    expect(result.visible).toBeNull();
    expect(result.croppedByFrame).toBe(1);
  });
});

describe("orderByDepth", () => {
  it("sorts far to near with wall objects behind standing ones on ties", () => {
    const ordered = orderByDepth([
      { id: "near", kind: "standing" as const, depthKey: 900 },
      { id: "wall", kind: "wall" as const, depthKey: 600 },
      { id: "far", kind: "standing" as const, depthKey: 600 },
      { id: "rug", kind: "flat" as const, depthKey: 600 },
    ]);
    expect(ordered.map((item) => item.id)).toEqual([
      "wall",
      "rug",
      "far",
      "near",
    ]);
  });
});

describe("footprintsCollide", () => {
  const base = {
    kind: "standing" as const,
    left: 100,
    widthPx: 100,
    baseY: 500,
  };
  it("flags two objects sharing a base row and most of their base band", () => {
    expect(footprintsCollide(base, { ...base, left: 150 }, 1000)).toBe(true);
  });
  it("ignores objects at different depths (legitimate occlusion)", () => {
    expect(
      footprintsCollide(base, { ...base, left: 150, baseY: 560 }, 1000),
    ).toBe(false);
  });
  it("ignores side-by-side objects", () => {
    expect(footprintsCollide(base, { ...base, left: 195 }, 1000)).toBe(false);
  });
  it("never flags wall objects", () => {
    expect(
      footprintsCollide(base, { ...base, kind: "wall", left: 100 }, 1000),
    ).toBe(false);
  });
});

describe("normalizeTap", () => {
  // A 3:4 photo painted inside a 900x640 letterboxed box sits at left 210,
  // 480 px wide. Taps must be measured against that painted rectangle.
  const painted = { left: 210, top: 0, width: 480, height: 640 };
  it("maps the painted left edge to x = 0", () => {
    expect(normalizeTap(210, 320, painted)).toEqual({ x: 0, y: 0.5 });
  });
  it("ignores taps in the letterbox bars instead of clamping them", () => {
    expect(normalizeTap(100, 320, painted)).toBeNull();
  });
  it("rejects non-finite pointer positions and rectangles", () => {
    expect(normalizeTap(Number.NaN, 320, painted)).toBeNull();
    expect(
      normalizeTap(210, 320, { ...painted, width: Number.POSITIVE_INFINITY }),
    ).toBeNull();
  });
  it("rounds to four decimals", () => {
    expect(normalizeTap(210 + 160, 213.333, painted)).toEqual({
      x: 0.3333,
      y: 0.3333,
    });
  });
  it("derives the painted rectangle of an object-fit: contain image", () => {
    expect(
      containedImageRect(
        { left: 0, top: 0, width: 900, height: 640 },
        1536,
        2048,
      ),
    ).toEqual(painted);
  });
});

describe("computeSimplePlacement — invalid measurements", () => {
  const input = {
    sceneWidth: 1000,
    sceneHeight: 800,
    point: { x: 0.5, y: 0.7 },
    cutout: { widthPx: 100, heightPx: 200 },
    dimensions: { mode: "height_length" as const, heightCm: 40, lengthCm: 20 },
    pixelsPerCm: 2,
  };
  it("rejects invalid scales instead of returning NaN or silently assuming room width", () => {
    for (const pixelsPerCm of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => computeSimplePlacement({ ...input, pixelsPerCm })).toThrow(
        /pixelsPerCm/,
      );
    }
  });
  it("rejects invalid dimensions and off-image contact points", () => {
    expect(() => computeSimplePlacement({ ...input, sceneWidth: 0 })).toThrow(
      /sceneWidth/,
    );
    expect(() =>
      computeSimplePlacement({
        ...input,
        cutout: { widthPx: 0, heightPx: 100 },
      }),
    ).toThrow(/widthPx/);
    expect(() =>
      computeSimplePlacement({ ...input, point: { x: 0.5, y: Number.NaN } }),
    ).toThrow(/point.y/);
    expect(() =>
      computeSimplePlacement({ ...input, point: { x: 1.1, y: 0.7 } }),
    ).toThrow(/point.x/);
  });
  it("keeps the technical preview minimum only for an uncalibrated guess", () => {
    const result = computeSimplePlacement({
      ...input,
      pixelsPerCm: null,
      dimensions: { mode: "height_length", heightCm: 1, lengthCm: 0.5 },
    });
    expect(result.heightPx).toBe(MIN_OBJECT_PX);
    expect(result.clamped).toBe(true);
  });
});
