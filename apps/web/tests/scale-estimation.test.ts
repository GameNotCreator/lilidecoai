import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";

// `scale-estimation.ts` starts with `import "server-only"`, which is a Next.js
// build-time alias and does not resolve under plain vitest. Stubbing it keeps
// the module importable without touching any source file.
vi.mock("server-only", () => ({}));

import {
  MAX_FRAME_WIDTH_CM,
  MAX_TEN_CM_FRACTION,
  MIN_FRAME_WIDTH_CM,
  MIN_TEN_CM_FRACTION,
  REFERENCE_CONSISTENCY_TOLERANCE,
  referencePlausible,
  prepareSceneForScale,
  resolveSpans,
  SCALE_ESTIMATION_VERSION,
  sceneScaleCacheKey,
  STOREFRONT_SCALE_PROFILE,
  type RawScaleSpan,
  type SceneScaleSpan,
} from "../lib/server/scale-estimation";
import { serverConfig } from "../lib/server/config";

const SCENE_WIDTH = 1000;
const SCENE_HEIGHT = 1500;
const LONG_SIDE = Math.max(SCENE_WIDTH, SCENE_HEIGHT);
const MIN_TEN_CM = MIN_TEN_CM_FRACTION * LONG_SIDE; // 12 px
const MAX_TEN_CM = MAX_TEN_CM_FRACTION * LONG_SIDE; // 300 px

/**
 * A raw answer that is confident and consistent by default, with
 * `frameWidthCm: 0` (read as "absent") and a measurable same-depth reference.
 */
function rawSpan(
  overrides: Partial<RawScaleSpan> & { pointNumber: number },
): RawScaleSpan {
  return {
    supportKind: "floor",
    supportMaterial: "wood",
    supportGlossy: false,
    tenCmPixels: 50,
    confident: true,
    frameWidthCm: 0,
    referenceKind: "door",
    referenceRealCm: 205,
    referencePixels: ((overrides.tenCmPixels ?? 50) / 10) * 205,
    referenceAxis: "vertical",
    referenceAtSameDepth: true,
    ...overrides,
  };
}

/** Pixel span a reference of `realCm` must cover to imply `tenCmPixels`. */
function referencePixelsFor(realCm: number, impliedTenCm: number): number {
  return (impliedTenCm / 10) * realCm;
}

function only(spans: SceneScaleSpan[]): SceneScaleSpan {
  expect(spans).toHaveLength(1);
  return spans[0] as SceneScaleSpan;
}

const at = (spans: SceneScaleSpan[], index: number): SceneScaleSpan =>
  spans[index] as SceneScaleSpan;

const ONE_POINT = [{ x: 0.5, y: 0.7 }];

describe("referencePlausible", () => {
  it("accepts a real-world door and rejects an implausible one", () => {
    expect(referencePlausible("door", 205)).toBe(true);
    expect(referencePlausible("door", 40)).toBe(false);
    // Whitelist bounds are inclusive: door is [70, 220].
    expect(referencePlausible("door", 70)).toBe(true);
    expect(referencePlausible("door", 220)).toBe(true);
    expect(referencePlausible("door", 69.9)).toBe(false);
    expect(referencePlausible("door", 220.1)).toBe(false);
  });

  it("never accepts the `none` kind — there is no reference to measure", () => {
    expect(referencePlausible("none", 10)).toBe(false);
    expect(referencePlausible("none", 200)).toBe(false);
  });

  it("applies the per-kind window from the implementation table", () => {
    // switch_or_outlet: [7, 9]
    expect(referencePlausible("switch_or_outlet", 8)).toBe(true);
    expect(referencePlausible("switch_or_outlet", 20)).toBe(false);
    // mug: [8, 13]
    expect(referencePlausible("mug", 10)).toBe(true);
    expect(referencePlausible("mug", 3)).toBe(false);
    // chair_seat: [40, 50]
    expect(referencePlausible("chair_seat", 45)).toBe(true);
    expect(referencePlausible("chair_seat", 100)).toBe(false);
    // worktop: [85, 95]
    expect(referencePlausible("worktop", 90)).toBe(true);
    expect(referencePlausible("worktop", 75)).toBe(false);
    // other is the widest window: [5, 300]
    expect(referencePlausible("other", 5)).toBe(true);
    expect(referencePlausible("other", 300)).toBe(true);
    expect(referencePlausible("other", 301)).toBe(false);
  });

  it("rejects unknown kinds and non-positive or non-finite sizes", () => {
    expect(referencePlausible("unicorn_horn", 30)).toBe(false);
    expect(referencePlausible("door", 0)).toBe(false);
    expect(referencePlausible("door", -205)).toBe(false);
    expect(referencePlausible("door", Number.NaN)).toBe(false);
    expect(referencePlausible("door", Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("resolveSpans — rung 1: vision", () => {
  it("resolves a confident, cross-checked span to `vision` with high confidence", () => {
    const spans = resolveSpans(
      [
        rawSpan({
          pointNumber: 1,
          tenCmPixels: 50,
          referenceKind: "door",
          referenceRealCm: 205,
          // A door spanning 1025 px implies exactly 50 px per 10 cm.
          referencePixels: referencePixelsFor(205, 50),
          referenceAtSameDepth: true,
        }),
      ],
      ONE_POINT,
      SCENE_WIDTH,
      SCENE_HEIGHT,
    );
    const span = only(spans);
    expect(span.scaleSource).toBe("vision");
    expect(span.confidence).toBe("high");
    expect(span.pixelsPerCm).toBeCloseTo(5, 6);
    expect(span.supportKind).toBe("floor");
    expect(span.referenceKind).toBe("door");
  });

  it("averages an upright span and its vertical reference geometrically when they agree", () => {
    const stated = 50;
    const implied = 60; // 20 % apart, inside the 40 % tolerance.
    const spans = resolveSpans(
      [
        rawSpan({
          pointNumber: 1,
          tenCmPixels: stated,
          // A door's WIDTH: measured along the same axis as the 10 cm span,
          // so the two numbers describe the same thing and may be averaged.
          referenceRealCm: 80,
          referenceAxis: "vertical",
          referencePixels: referencePixelsFor(80, implied),
          referenceAtSameDepth: true,
        }),
      ],
      ONE_POINT,
      SCENE_WIDTH,
      SCENE_HEIGHT,
    );
    const span = only(spans);
    expect(span.scaleSource).toBe("vision");
    expect(span.pixelsPerCm).toBeCloseTo(Math.sqrt(stated * implied) / 10, 6);
  });

  it("keeps a same-axis disagreement exactly at the tolerance", () => {
    const stated = 50;
    const implied = stated * (1 + REFERENCE_CONSISTENCY_TOLERANCE); // 70
    const spans = resolveSpans(
      [
        rawSpan({
          pointNumber: 1,
          tenCmPixels: stated,
          referenceRealCm: 80,
          referenceAxis: "vertical",
          referencePixels: referencePixelsFor(80, implied),
          referenceAtSameDepth: true,
        }),
      ],
      ONE_POINT,
      SCENE_WIDTH,
      SCENE_HEIGHT,
    );
    const span = only(spans);
    expect(span.scaleSource).toBe("vision");
    expect(span.pixelsPerCm).toBeCloseTo(Math.sqrt(stated * implied) / 10, 6);
  });

  it("never averages a horizontal reference into an upright span", () => {
    // A door's HEIGHT and a horizontal 10 cm span on the floor are
    // foreshortened differently, so a 20 % gap is perspective, not error:
    // the answer stands, and the two numbers are not merged.
    const spans = resolveSpans(
      [
        rawSpan({
          pointNumber: 1,
          tenCmPixels: 50,
          referenceRealCm: 205,
          referenceAxis: "horizontal",
          referencePixels: referencePixelsFor(205, 60),
          referenceAtSameDepth: true,
        }),
      ],
      ONE_POINT,
      SCENE_WIDTH,
      SCENE_HEIGHT,
    );
    const span = only(spans);
    expect(span.scaleSource).toBe("vision");
    expect(span.pixelsPerCm).toBeCloseTo(5, 6);
  });

  it("still demotes a cross-axis reference that disagrees grossly", () => {
    const spans = resolveSpans(
      [
        rawSpan({
          pointNumber: 1,
          tenCmPixels: 50,
          referenceRealCm: 205,
          referenceAxis: "horizontal",
          // Three times the stated span: no camera angle explains that.
          referencePixels: referencePixelsFor(205, 150),
          referenceAtSameDepth: true,
        }),
      ],
      ONE_POINT,
      SCENE_WIDTH,
      SCENE_HEIGHT,
    );
    expect(only(spans).scaleSource).not.toBe("vision");
  });

  it("demotes a same-depth answer that gives no measurable reference", () => {
    // The claim cannot be checked, and an unverifiable claim is the one least
    // worth trusting on its own word.
    const spans = resolveSpans(
      [
        rawSpan({
          pointNumber: 1,
          tenCmPixels: 50,
          referencePixels: 0,
          referenceAtSameDepth: true,
          frameWidthCm: 0,
        }),
      ],
      ONE_POINT,
      SCENE_WIDTH,
      SCENE_HEIGHT,
    );
    expect(only(spans).scaleSource).not.toBe("vision");
  });

  it("does not claim high confidence for a reference at another depth", () => {
    const spans = resolveSpans(
      [
        rawSpan({
          pointNumber: 1,
          tenCmPixels: 50,
          referenceRealCm: 205,
          // Wildly inconsistent, but not at the same depth: not comparable.
          referencePixels: referencePixelsFor(205, 500),
          referenceAtSameDepth: false,
        }),
      ],
      ONE_POINT,
      SCENE_WIDTH,
      SCENE_HEIGHT,
    );
    const span = only(spans);
    expect(span.scaleSource).toBe("assumed_room_width");
    expect(span.pixelsPerCm).toBeNull();
  });

  it("demotes a span whose same-axis reference disagrees by more than the tolerance", () => {
    const stated = 50;
    const implied = 100; // 100 % apart, far beyond 40 %.
    const contradicted = rawSpan({
      pointNumber: 1,
      tenCmPixels: stated,
      referenceRealCm: 80,
      referenceAxis: "vertical",
      referencePixels: referencePixelsFor(80, implied),
      referenceAtSameDepth: true,
    });

    // Nothing else usable: the whole ladder falls through.
    const bare = only(
      resolveSpans([contradicted], ONE_POINT, SCENE_WIDTH, SCENE_HEIGHT),
    );
    expect(bare.scaleSource).not.toBe("vision");
    expect(bare.scaleSource).toBe("assumed_room_width");
    expect(bare.pixelsPerCm).toBeNull();
    expect(bare.confidence).toBe("none");

    // With a frame width the demoted point drops one rung, never to `vision`.
    const coarse = only(
      resolveSpans(
        [{ ...contradicted, frameWidthCm: 400 }],
        ONE_POINT,
        SCENE_WIDTH,
        SCENE_HEIGHT,
      ),
    );
    expect(coarse.scaleSource).not.toBe("vision");
    expect(coarse.scaleSource).toBe("vision_coarse");
    expect(coarse.pixelsPerCm).toBeCloseTo(SCENE_WIDTH / 400, 6);
  });

  it("demotes a confident span whose reference size is implausible", () => {
    const span = only(
      resolveSpans(
        [
          rawSpan({
            pointNumber: 1,
            referenceKind: "door",
            referenceRealCm: 40,
          }),
        ],
        ONE_POINT,
        SCENE_WIDTH,
        SCENE_HEIGHT,
      ),
    );
    expect(span.scaleSource).not.toBe("vision");
    expect(span.pixelsPerCm).toBeNull();
  });

  it("demotes a confident span with no reference at all", () => {
    const span = only(
      resolveSpans(
        [
          rawSpan({
            pointNumber: 1,
            referenceKind: "none",
            referenceRealCm: 100,
          }),
        ],
        ONE_POINT,
        SCENE_WIDTH,
        SCENE_HEIGHT,
      ),
    );
    expect(span.scaleSource).not.toBe("vision");
    expect(span.referenceKind).toBe("none");
    expect(span.pixelsPerCm).toBeNull();
  });
});

describe("resolveSpans — the accepted 10 cm window", () => {
  const resolveWith = (tenCmPixels: number): SceneScaleSpan =>
    only(
      resolveSpans(
        [rawSpan({ pointNumber: 1, tenCmPixels })],
        ONE_POINT,
        SCENE_WIDTH,
        SCENE_HEIGHT,
      ),
    );

  it("rejects a 10 cm span far above the window (0.3 of the long side)", () => {
    const tooWide = 0.3 * LONG_SIDE;
    expect(tooWide).toBeGreaterThan(MAX_TEN_CM);
    const span = resolveWith(tooWide);
    expect(span.scaleSource).toBe("assumed_room_width");
    expect(span.pixelsPerCm).toBeNull();
    expect(span.confidence).toBe("none");
  });

  it("rejects a 10 cm span below the window", () => {
    const tooNarrow = 0.004 * LONG_SIDE;
    expect(tooNarrow).toBeLessThan(MIN_TEN_CM);
    const span = resolveWith(tooNarrow);
    expect(span.scaleSource).toBe("assumed_room_width");
    expect(span.pixelsPerCm).toBeNull();
  });

  it("rejects a non-finite 10 cm span", () => {
    expect(resolveWith(Number.NaN).pixelsPerCm).toBeNull();
  });

  it("accepts both edges of the window", () => {
    const low = resolveWith(MIN_TEN_CM);
    expect(low.scaleSource).toBe("vision");
    expect(low.pixelsPerCm).toBeCloseTo(MIN_TEN_CM / 10, 6);
    const high = resolveWith(MAX_TEN_CM);
    expect(high.scaleSource).toBe("vision");
    expect(high.pixelsPerCm).toBeCloseTo(MAX_TEN_CM / 10, 6);
  });
});

describe("resolveSpans — rung 2: vision_coarse", () => {
  const coarse = (frameWidthCm: number): SceneScaleSpan =>
    only(
      resolveSpans(
        [rawSpan({ pointNumber: 1, confident: false, frameWidthCm })],
        ONE_POINT,
        SCENE_WIDTH,
        SCENE_HEIGHT,
      ),
    );

  it("derives the scale from a usable frame width", () => {
    const span = coarse(400);
    expect(span.scaleSource).toBe("vision_coarse");
    expect(span.confidence).toBe("low");
    expect(span.pixelsPerCm).toBeCloseTo(SCENE_WIDTH / 400, 6);
    expect(span.impliedFrameWidthCm).toBe(400);
  });

  it("clamps an absurdly small frame width up to the floor", () => {
    const span = coarse(20);
    expect(span.scaleSource).toBe("vision_coarse");
    expect(span.pixelsPerCm).toBeCloseTo(SCENE_WIDTH / MIN_FRAME_WIDTH_CM, 6);
    expect(span.pixelsPerCm).not.toBeCloseTo(SCENE_WIDTH / 20, 6);
    // The field reports the clamped width, so the number a caller displays
    // always matches the scale that was actually applied.
    expect(span.impliedFrameWidthCm).toBe(MIN_FRAME_WIDTH_CM);
  });

  it("clamps an absurdly large frame width down to the ceiling", () => {
    const span = coarse(5000);
    expect(span.pixelsPerCm).toBeCloseTo(SCENE_WIDTH / MAX_FRAME_WIDTH_CM, 6);
  });

  it("ignores a zero or negative frame width", () => {
    expect(coarse(0).scaleSource).toBe("assumed_room_width");
    expect(coarse(0).pixelsPerCm).toBeNull();
    expect(coarse(-300).scaleSource).toBe("assumed_room_width");
  });
});

describe("resolveSpans — rung 3: vision_interpolated", () => {
  const CONFIDENT_TEN_CM = 60;
  const CONFIDENT_PER_CM = CONFIDENT_TEN_CM / 10;

  /** Point 1 is confident; point 2 has neither a span nor a frame width. */
  const interpolate = (referenceY: number, targetY: number): SceneScaleSpan[] =>
    resolveSpans(
      [
        rawSpan({ pointNumber: 1, tenCmPixels: CONFIDENT_TEN_CM }),
        rawSpan({ pointNumber: 2, confident: false, frameWidthCm: 0 }),
      ],
      [
        { x: 0.5, y: referenceY },
        { x: 0.5, y: targetY },
      ],
      SCENE_WIDTH,
      SCENE_HEIGHT,
    );

  it("does not invent a depth ratio with an uncalibrated horizon", () => {
    const spans = interpolate(0.8, 0.5);
    expect(at(spans, 0).scaleSource).toBe("vision");
    const target = at(spans, 1);
    expect(target.scaleSource).toBe("assumed_room_width");
    expect(target.confidence).toBe("none");
    expect(target.pixelsPerCm).toBeNull();
  });

  it("refuses to transfer a floor scale to a much higher image point", () => {
    const target = at(interpolate(0.9, 0.1), 1);
    expect(target.scaleSource).toBe("assumed_room_width");
    expect(target.pixelsPerCm).toBeNull();
  });

  it("refuses to extrapolate scale far into the foreground", () => {
    const target = at(interpolate(0.5, 0.95), 1);
    expect(target.pixelsPerCm).toBeNull();
  });

  it("transfers a nearby same-plane scale without a spurious y ratio", () => {
    const target = at(interpolate(0.8, 0.76), 1);
    expect(target.scaleSource).toBe("vision_interpolated");
    expect(target.pixelsPerCm).toBe(CONFIDENT_PER_CM);
  });

  it("picks the nearest confident neighbour, not the first one", () => {
    const spans = resolveSpans(
      [
        rawSpan({ pointNumber: 1, tenCmPixels: 20 }),
        rawSpan({ pointNumber: 2, tenCmPixels: 80 }),
        rawSpan({ pointNumber: 3, confident: false, frameWidthCm: 0 }),
      ],
      [
        { x: 0.05, y: 0.5 },
        { x: 0.9, y: 0.5 },
        { x: 0.95, y: 0.5 },
      ],
      SCENE_WIDTH,
      SCENE_HEIGHT,
    );
    const target = at(spans, 2);
    expect(target.scaleSource).toBe("vision_interpolated");
    // Same y, so the depth ratio is 1: the near neighbour's 8 px/cm wins.
    expect(target.pixelsPerCm).toBeCloseTo(8, 6);
  });

  it("prefers the frame width over interpolation when both are available", () => {
    const spans = resolveSpans(
      [
        rawSpan({ pointNumber: 1, tenCmPixels: CONFIDENT_TEN_CM }),
        rawSpan({ pointNumber: 2, confident: false, frameWidthCm: 500 }),
      ],
      [
        { x: 0.5, y: 0.8 },
        { x: 0.5, y: 0.5 },
      ],
      SCENE_WIDTH,
      SCENE_HEIGHT,
    );
    expect(at(spans, 1).scaleSource).toBe("vision_coarse");
    expect(at(spans, 1).pixelsPerCm).toBeCloseTo(SCENE_WIDTH / 500, 6);
  });
});

describe("resolveSpans — rung 4: assumed_room_width", () => {
  it("falls back when the answer is missing entirely", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const raw of [null, undefined, [] as RawScaleSpan[]]) {
        const span = only(
          resolveSpans(raw, ONE_POINT, SCENE_WIDTH, SCENE_HEIGHT),
        );
        expect(span.scaleSource).toBe("assumed_room_width");
        expect(span.pixelsPerCm).toBeNull();
        expect(span.confidence).toBe("none");
        expect(span.referenceKind).toBe("none");
        expect(span.impliedFrameWidthCm).toBeNull();
      }
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("falls back when no answer matches the point number", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const span = only(
        resolveSpans(
          [rawSpan({ pointNumber: 7 })],
          ONE_POINT,
          SCENE_WIDTH,
          SCENE_HEIGHT,
        ),
      );
      expect(span.scaleSource).toBe("assumed_room_width");
      expect(span.pixelsPerCm).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it("returns one span per point, in point order", () => {
    const points = [
      { x: 0.2, y: 0.6 },
      { x: 0.5, y: 0.7 },
      { x: 0.8, y: 0.8 },
    ];
    const spans = resolveSpans([], points, SCENE_WIDTH, SCENE_HEIGHT);
    expect(spans).toHaveLength(points.length);
    for (const span of spans) {
      expect(span.pixelsPerCm).toBeNull();
      expect(span.scaleSource).toBe("assumed_room_width");
    }
  });
});

describe("resolveSpans — confidence tracks the chosen source", () => {
  it("pairs every rung with its confidence and null-ness", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const spans = resolveSpans(
        [
          // 1: confident and cross-checked -> vision / high
          rawSpan({
            pointNumber: 1,
            tenCmPixels: 60,
            referencePixels: referencePixelsFor(205, 60),
            referenceAtSameDepth: true,
          }),
          // 2: unconfident but a frame width -> vision_coarse / low
          rawSpan({ pointNumber: 2, confident: false, frameWidthCm: 300 }),
          // 3: nothing of its own, a confident neighbour -> interpolated / low
          rawSpan({ pointNumber: 3, confident: false, frameWidthCm: 0 }),
        ],
        // Point 2 sits at a clearly different depth from the confident point,
        // so its own frame width is the best it has; a neighbour at the same
        // depth would rightly outrank it.
        [
          { x: 0.5, y: 0.8 },
          { x: 0.2, y: 0.4 },
          { x: 0.55, y: 0.76 },
        ],
        SCENE_WIDTH,
        SCENE_HEIGHT,
      );
      expect(
        spans.map((span) => [
          span.scaleSource,
          span.confidence,
          span.pixelsPerCm === null,
        ]),
      ).toEqual([
        ["vision", "high", false],
        ["vision_coarse", "low", false],
        ["vision_interpolated", "low", false],
      ]);

      const fallback = only(
        resolveSpans([], ONE_POINT, SCENE_WIDTH, SCENE_HEIGHT),
      );
      expect([
        fallback.scaleSource,
        fallback.confidence,
        fallback.pixelsPerCm === null,
      ]).toEqual(["assumed_room_width", "none", true]);
    } finally {
      warn.mockRestore();
    }
  });

  it("sanitises unknown enum values back to `other` / `none`", () => {
    const span = only(
      resolveSpans(
        [
          rawSpan({
            pointNumber: 1,
            supportKind: "trampoline",
            supportMaterial: "unobtanium",
            referenceKind: "spaceship",
            supportGlossy: true,
            frameWidthCm: 250,
            confident: false,
          }),
        ],
        ONE_POINT,
        SCENE_WIDTH,
        SCENE_HEIGHT,
      ),
    );
    expect(span.supportKind).toBe("other");
    expect(span.supportMaterial).toBe("other");
    expect(span.referenceKind).toBe("none");
    expect(span.supportGlossy).toBe(true);
    expect(span.scaleSource).toBe("vision_coarse");
  });
});

describe("sceneScaleCacheKey", () => {
  it("keeps fast storefront medium estimates separate from legacy estimates", () => {
    const points = [{ x: 0.62, y: 0.9 }];
    const kinds = ["standing"] as const;
    expect(sceneScaleCacheKey(points, kinds, STOREFRONT_SCALE_PROFILE)).not.toBe(sceneScaleCacheKey(points, kinds));
    expect(sceneScaleCacheKey(points, kinds, STOREFRONT_SCALE_PROFILE)).toBe(sceneScaleCacheKey(points, kinds, STOREFRONT_SCALE_PROFILE));
  });
  const POINT = [{ x: 0.5, y: 0.7 }] as const;

  it("separates nearby taps that could straddle a shelf edge", () => {
    expect(sceneScaleCacheKey([{ x: 0.5, y: 0.7 }], ["standing"])).not.toBe(
      sceneScaleCacheKey([{ x: 0.502, y: 0.699 }], ["standing"]),
    );
  });
  it("rounds only below the pointer contract's four decimal precision", () => {
    expect(sceneScaleCacheKey([{ x: 0.5, y: 0.7 }], ["standing"])).toBe(
      sceneScaleCacheKey([{ x: 0.50001, y: 0.70001 }], ["standing"]),
    );
  });

  it("separates points, kinds and point counts", () => {
    const base = sceneScaleCacheKey(POINT, ["standing"]);
    expect(sceneScaleCacheKey([{ x: 0.9, y: 0.7 }], ["standing"])).not.toBe(
      base,
    );
    expect(sceneScaleCacheKey(POINT, ["flat"])).not.toBe(base);
    expect(
      sceneScaleCacheKey([...POINT, { x: 0.2, y: 0.3 }], ["standing", "flat"]),
    ).not.toBe(base);
  });

  // A16 of the audit: the cache survived a change of estimator, so a scene
  // could answer with an estimate the current code would never produce.
  it("invalidates when the algorithm version or the vision model changes", () => {
    const base = sceneScaleCacheKey(POINT, ["standing"]);
    const original = serverConfig.openaiVisionModel;
    try {
      serverConfig.openaiVisionModel = `${original}-next`;
      expect(sceneScaleCacheKey(POINT, ["standing"])).not.toBe(base);
    } finally {
      serverConfig.openaiVisionModel = original;
    }
    expect(sceneScaleCacheKey(POINT, ["standing"])).toBe(base);
    expect(SCALE_ESTIMATION_VERSION).toMatch(/^scale-v\d+$/);
  });
});

describe("metric scale regression guards", () => {
  it("does not copy a floor measurement onto a table at the same image row", () => {
    const spans = resolveSpans(
      [
        rawSpan({ pointNumber: 1, supportKind: "floor" }),
        rawSpan({ pointNumber: 2, supportKind: "table", confident: false }),
      ],
      [
        { x: 0.5, y: 0.7 },
        { x: 0.52, y: 0.7 },
      ],
      SCENE_WIDTH,
      SCENE_HEIGHT,
    );
    expect(spans[1]?.pixelsPerCm).toBeNull();
  });
  it("does not copy scale between two distinct shelf planes", () => {
    const spans = resolveSpans(
      [
        rawSpan({ pointNumber: 1, supportKind: "shelf", supportPlaneId: 1 }),
        rawSpan({
          pointNumber: 2,
          supportKind: "shelf",
          supportPlaneId: 2,
          confident: false,
        }),
      ],
      [
        { x: 0.5, y: 0.7 },
        { x: 0.52, y: 0.7 },
      ],
      SCENE_WIDTH,
      SCENE_HEIGHT,
    );
    expect(spans[1]?.pixelsPerCm).toBeNull();
  });
  it("does not transfer upright scale to a flat object", () => {
    const spans = resolveSpans(
      [
        rawSpan({ pointNumber: 1 }),
        rawSpan({ pointNumber: 2, confident: false }),
      ],
      [
        { x: 0.5, y: 0.7 },
        { x: 0.52, y: 0.7 },
      ],
      SCENE_WIDTH,
      SCENE_HEIGHT,
      ["standing", "flat"],
    );
    expect(spans[1]?.pixelsPerCm).toBeNull();
  });
  it("cross-checks horizontal measurements for flat objects", () => {
    const span = only(
      resolveSpans(
        [
          rawSpan({
            pointNumber: 1,
            referenceAxis: "horizontal",
            referenceRealCm: 80,
            referencePixels: 480,
          }),
        ],
        ONE_POINT,
        SCENE_WIDTH,
        SCENE_HEIGHT,
        ["flat"],
      ),
    );
    expect(span.pixelsPerCm).toBeCloseTo(Math.sqrt(50 * 60) / 10, 6);
  });
  it("rejects gross underestimation as well as overestimation", () => {
    const span = only(
      resolveSpans(
        [
          rawSpan({
            pointNumber: 1,
            referenceAxis: "horizontal",
            referencePixels: 50,
          }),
        ],
        ONE_POINT,
        SCENE_WIDTH,
        SCENE_HEIGHT,
      ),
    );
    expect(span.confidence).toBe("none");
  });
  it("rejects duplicate point numbers instead of trusting the first answer", () => {
    const span = only(
      resolveSpans(
        [
          rawSpan({ pointNumber: 1 }),
          rawSpan({ pointNumber: 1, tenCmPixels: 100 }),
        ],
        ONE_POINT,
        SCENE_WIDTH,
        SCENE_HEIGHT,
      ),
    );
    expect(span.pixelsPerCm).toBeNull();
  });
  it("uses the final oriented pixel dimensions for a rotated phone photograph", async () => {
    const photo = await sharp({
      create: { width: 120, height: 80, channels: 3, background: "white" },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const { data, info } = await prepareSceneForScale(photo);
    expect(info.width).toBe(80);
    expect(info.height).toBe(120);
    const actual = await sharp(data).metadata();
    expect(actual.width).toBe(info.width);
    expect(actual.height).toBe(info.height);
  });
});
