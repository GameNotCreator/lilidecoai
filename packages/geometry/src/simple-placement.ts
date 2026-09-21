/**
 * Pure, isomorphic placement contract for the simple multi-point workflow.
 *
 * Runs byte-identically in the browser (free preview) and on the server
 * (deterministic composite). Every geometric decision — where the base sits,
 * how many pixels the object spans, what the frame cuts off and which object
 * is in front — is made here and nowhere else.
 */

/**
 * Version of the placement contract: the sizing rules, the base anchoring, the
 * frame-crop handling and the depth ordering, together.
 *
 * Bump it whenever any of those changes. A reference corpus compares runs, and
 * a comparison across a silent change of these rules is a comparison of two
 * different engines — audit finding PRO-007, phase 0 "baseline des versions".
 */
export const SIMPLE_PLACEMENT_VERSION = "placement-geometry-v2";

export type SimplePlacementKind = "standing" | "wall" | "flat";

export type SimpleScaleSource =
  | "user"
  | "vision"
  | "vision_coarse"
  | "vision_interpolated"
  | "assumed_room_width";

export type SimpleDimensionPair =
  | { mode: "height_length"; heightCm: number; lengthCm: number }
  | { mode: "length_width"; lengthCm: number; widthCm: number };

export interface SimplePlacementInput {
  sceneWidth: number;
  sceneHeight: number;
  /** Normalized tap: standing = base contact point, wall/flat = centre. */
  point: { x: number; y: number };
  cutout: {
    widthPx: number;
    heightPx: number;
    /**
     * Row of the cutout (as a fraction of its height, in (0, 1]) where the
     * object touches its support. 1 = the very bottom row (default).
     */
    baseRowFraction?: number;
  };
  dimensions: SimpleDimensionPair;
  /** Pixels per centimetre on the support at the point, when known. */
  pixelsPerCm: number | null;
  /** How `pixelsPerCm` was obtained. Defaults from its nullness. */
  scaleSource?: SimpleScaleSource;
  kind?: SimplePlacementKind;
}

export interface SimplePlacementBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SimplePlacementResult {
  kind: SimplePlacementKind;
  /** Full (un-cropped) box; left/top may be negative or exceed the frame. */
  widthPx: number;
  heightPx: number;
  left: number;
  top: number;
  /** Anchor in scene pixels: round(x*W), round(y*H). Never moves. */
  baseX: number;
  baseY: number;
  /** Intersection of the box with the frame, null when nothing is visible. */
  visible: SimplePlacementBox | null;
  /** Fraction of the box area outside the frame, 0..1. */
  croppedByFrame: number;
  /** Factor applied on top of the pure cm→px conversion (1 = none). */
  sizeFactor: number;
  clamped: boolean;
  scaleSource: SimpleScaleSource;
  /** Effective pixels per centimetre after the fallback, before clamping. */
  pixelsPerCm: number;
  /** Real-world silhouette size; standing height ends at the contact row. */
  impliedWidthCm: number;
  impliedHeightCm: number;
  /**
   * (lengthCm / heightCm) / cutoutAspect for height_length inputs. 1 means the
   * entered dimensions match the photographed silhouette (a front view);
   * null when the pair does not allow the check.
   */
  dimensionConsistency: number | null;
  /** Sort key: smaller = farther from the camera = composited first. */
  depthKey: number;
}

/** Fallback when no calibration exists: the long side spans about 300 cm. */
export const ASSUMED_ROOM_WIDTH_CM = 300;
/**
 * Preview minimum for uncalibrated guesses on the LONGEST side, so the mask,
 * blend ring and the shadow ellipse are not degenerate. Deliberately not the
 * smallest side: a 5 x 30 cm candle is a legitimate sliver, and forcing its
 * width up to a floor would make it render twice its real height — the very
 * "pas à l'échelle" bug this module exists to remove.
 */
export const MIN_OBJECT_PX = 24;
/** Calibrated objects may exceed the frame, but never absurdly. */
export const SAFETY_MAX_FRAME_FACTOR = 1.5;
/**
 * Guesses (no calibration) keep a ceiling, never a width floor. A floor at a
 * fraction of the frame width inflates exactly the objects it should leave
 * alone: a narrow vase or a candle is a legitimate sliver, and growing its
 * width also grows its height, so a 40 cm vase came out 53 cm tall.
 * `MIN_OBJECT_PX` on the longest side already keeps an object renderable.
 */
export const FALLBACK_MAX_WIDTH_FRACTION = 0.6;
export const FALLBACK_MAX_HEIGHT_FRACTION = 0.85;
/** Screen height of a flat object's footprint relative to its top view. */
export const FLAT_FORESHORTENING = 0.45;

const DEPTH_RANK: Record<SimplePlacementKind, number> = {
  wall: 0,
  flat: 1,
  standing: 2,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function computeSimplePlacement(
  input: SimplePlacementInput,
): SimplePlacementResult {
  assertFinitePositive(input.sceneWidth, "sceneWidth");
  assertFinitePositive(input.sceneHeight, "sceneHeight");
  assertFinitePositive(input.cutout.widthPx, "cutout.widthPx");
  assertFinitePositive(input.cutout.heightPx, "cutout.heightPx");
  assertUnit(input.point.x, "point.x");
  assertUnit(input.point.y, "point.y");
  if (input.pixelsPerCm !== null)
    assertFinitePositive(input.pixelsPerCm, "pixelsPerCm");
  if (input.cutout.baseRowFraction !== undefined) {
    assertUnit(input.cutout.baseRowFraction, "cutout.baseRowFraction");
    assertFinitePositive(
      input.cutout.baseRowFraction,
      "cutout.baseRowFraction",
    );
  }
  assertFinitePositive(input.dimensions.lengthCm, "lengthCm");
  if (input.dimensions.mode === "height_length") {
    assertFinitePositive(input.dimensions.heightCm, "heightCm");
  } else {
    assertFinitePositive(input.dimensions.widthCm, "widthCm");
  }
  const W = input.sceneWidth;
  const H = input.sceneHeight;
  const kind = input.kind ?? "standing";
  const baseRowFraction = input.cutout.baseRowFraction ?? 1;
  const heightFraction = kind === "standing" ? baseRowFraction : 1;
  const aspect = clamp(
    input.cutout.widthPx / Math.max(1, input.cutout.heightPx),
    0.05,
    20,
  );
  const calibrated = input.pixelsPerCm !== null;
  const perCm = calibrated
    ? (input.pixelsPerCm as number)
    : Math.max(W, H) / ASSUMED_ROOM_WIDTH_CM;
  const scaleSource: SimpleScaleSource =
    input.scaleSource ?? (calibrated ? "vision" : "assumed_room_width");

  let w: number;
  let h: number;
  let dimensionConsistency: number | null = null;
  if (input.dimensions.mode === "height_length") {
    // Height is the yaw-invariant anchor: a three-quarter view still stands
    // exactly heightCm tall. The entered length is a plausibility check only.
    // Pixels below the measured contact row can contain residual shadow. They
    // are not part of the catalog object's physical height.
    h = (input.dimensions.heightCm * perCm) / heightFraction;
    w = h * aspect;
    dimensionConsistency =
      (input.dimensions.lengthCm / input.dimensions.heightCm / aspect) *
      heightFraction;
  } else {
    // A footprint: both numbers are used. Deriving the second side from the
    // product photo's aspect instead would let the framing of that photo,
    // not the customer's measurements, decide how deep the rug is.
    const longCm = Math.max(
      input.dimensions.lengthCm,
      input.dimensions.widthCm,
    );
    const shortCm = Math.min(
      input.dimensions.lengthCm,
      input.dimensions.widthCm,
    );
    const foreshorten = kind === "flat" ? FLAT_FORESHORTENING : 1;
    // A photo taller than it is wide shows the long side going away from the
    // camera; swapping keeps the silhouette from being stretched sideways.
    const longSideIsHorizontal = aspect >= 1;
    w = (longSideIsHorizontal ? longCm : shortCm) * perCm;
    h = (longSideIsHorizontal ? shortCm : longCm) * perCm * foreshorten;
    dimensionConsistency = w / Math.max(1e-6, h) / aspect;
  }

  let factor: number;
  if (calibrated) {
    const shrink = Math.min(
      1,
      (W * SAFETY_MAX_FRAME_FACTOR) / w,
      (H * SAFETY_MAX_FRAME_FACTOR) / h,
    );
    // A measured object must not silently grow to a technical minimum. A
    // 1 cm object at 2 px/cm stays 2 px tall, rather than becoming 12 cm tall.
    factor = shrink;
  } else {
    const shrink = Math.min(
      1,
      (W * FALLBACK_MAX_WIDTH_FRACTION) / w,
      (H * FALLBACK_MAX_HEIGHT_FRACTION) / h,
    );
    const grow = Math.max(1, MIN_OBJECT_PX / Math.max(w, h));
    factor = shrink < 1 ? shrink : grow;
  }
  const widthPx = Math.max(1, Math.round(w * factor));
  const heightPx = Math.max(1, Math.round(h * factor));

  const baseX = Math.round(input.point.x * W);
  const baseY = Math.round(input.point.y * H);
  const left = baseX - Math.round(widthPx / 2);
  const top =
    kind === "standing"
      ? baseY - Math.round(baseRowFraction * heightPx)
      : baseY - Math.round(heightPx / 2);

  const visibleLeft = Math.max(0, left);
  const visibleTop = Math.max(0, top);
  const visibleRight = Math.min(W, left + widthPx);
  const visibleBottom = Math.min(H, top + heightPx);
  const visible =
    visibleRight > visibleLeft && visibleBottom > visibleTop
      ? {
          left: visibleLeft,
          top: visibleTop,
          width: visibleRight - visibleLeft,
          height: visibleBottom - visibleTop,
        }
      : null;
  const boxArea = widthPx * heightPx;
  const visibleArea = visible ? visible.width * visible.height : 0;
  const croppedByFrame = boxArea > 0 ? 1 - visibleArea / boxArea : 1;

  return {
    kind,
    widthPx,
    heightPx,
    left,
    top,
    baseX,
    baseY,
    visible,
    croppedByFrame,
    sizeFactor: factor,
    clamped: Math.abs(factor - 1) > 0.05,
    scaleSource,
    pixelsPerCm: perCm,
    impliedWidthCm: widthPx / perCm,
    impliedHeightCm: (heightPx * heightFraction) / perCm,
    dimensionConsistency,
    depthKey: kind === "standing" ? baseY : top,
  };
}

/**
 * Stable back-to-front ordering: farther objects first. Standing objects sort
 * by their base row; wall and flat objects by their top edge, and on ties a
 * wall object is behind a flat one, which is behind a standing one.
 */
export function orderByDepth<
  T extends { depthKey: number; kind: SimplePlacementKind },
>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        a.item.depthKey - b.item.depthKey ||
        DEPTH_RANK[a.item.kind] - DEPTH_RANK[b.item.kind] ||
        a.index - b.index,
    )
    .map((entry) => entry.item);
}

export interface FootprintCollisionInput {
  kind: SimplePlacementKind;
  left: number;
  widthPx: number;
  baseY: number;
}

/** Same-depth tolerance as a fraction of the scene height. */
export const COLLISION_DEPTH_TOLERANCE = 0.03;
/** Overlap of the inner base bands (10–90 % of width) that counts as a clash. */
export const COLLISION_OVERLAP_RATIO = 0.35;

/**
 * Two standing objects whose bases sit on the same row and whose inner base
 * bands overlap would occupy the same physical spot: a real clash, not a
 * legitimate occlusion. Objects at different depths never collide.
 */
export function footprintsCollide(
  a: FootprintCollisionInput,
  b: FootprintCollisionInput,
  sceneHeight: number,
): boolean {
  if (a.kind !== "standing" || b.kind !== "standing") return false;
  if (Math.abs(a.baseY - b.baseY) >= COLLISION_DEPTH_TOLERANCE * sceneHeight) {
    return false;
  }
  const bandA = [a.left + 0.1 * a.widthPx, a.left + 0.9 * a.widthPx] as const;
  const bandB = [b.left + 0.1 * b.widthPx, b.left + 0.9 * b.widthPx] as const;
  const overlap = Math.min(bandA[1], bandB[1]) - Math.max(bandA[0], bandB[0]);
  if (overlap <= 0) return false;
  const smallest = Math.min(bandA[1] - bandA[0], bandB[1] - bandB[0]);
  return smallest > 0 && overlap / smallest > COLLISION_OVERLAP_RATIO;
}

export interface DomRectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Normalizes a pointer position against the rectangle that actually paints
 * the photograph. Returns null for taps outside it (letterbox bars, borders)
 * instead of clamping them onto the edge of the image.
 */
export function normalizeTap(
  clientX: number,
  clientY: number,
  rect: DomRectLike,
): { x: number; y: number } | null {
  if (
    ![clientX, clientY, rect.left, rect.top, rect.width, rect.height].every(
      Number.isFinite,
    ) ||
    rect.width <= 0 ||
    rect.height <= 0
  )
    return null;
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return {
    x: Math.round(clamp(x, 0, 1) * 10_000) / 10_000,
    y: Math.round(clamp(y, 0, 1) * 10_000) / 10_000,
  };
}

/**
 * The rectangle an `object-fit: contain` image paints inside its box. Useful
 * when the box cannot be forced to the photo's aspect ratio.
 */
export function containedImageRect(
  box: DomRectLike,
  naturalWidth: number,
  naturalHeight: number,
): DomRectLike {
  if (naturalWidth <= 0 || naturalHeight <= 0) return box;
  const scale = Math.min(box.width / naturalWidth, box.height / naturalHeight);
  const width = naturalWidth * scale;
  const height = naturalHeight * scale;
  return {
    left: box.left + (box.width - width) / 2,
    top: box.top + (box.height - height) / 2,
    width,
    height,
  };
}

function assertFinitePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be finite and positive`);
  }
}

function assertUnit(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be finite and between 0 and 1`);
  }
}
