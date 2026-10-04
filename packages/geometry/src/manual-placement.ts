import { GeometryError, distance, polygonArea, projectPoint, solveHomography, type Matrix3, type NormalizedBounds, type Point, type Quad } from "./index";

/** A visual estimate, with no implied physical units or camera calibration. */
export interface ManualPlacement {
  box: NormalizedBounds;
  plane?: [Point, Point, Point, Point];
}
const unitQuad: Quad = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

export function normalizeManualBox(first: Point, second: Point): NormalizedBounds {
  return { xMin: Math.min(first.x, second.x), yMin: Math.min(first.y, second.y),
    xMax: Math.max(first.x, second.x), yMax: Math.max(first.y, second.y) };
}

export function isManualPlaneValid(plane: readonly Point[]): plane is Quad {
  if (plane.length !== 4 || plane.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1)) return false;
  const turns = plane.map((a, i) => {
    const b = plane[(i + 1) % 4]!; const c = plane[(i + 2) % 4]!;
    return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
  });
  return polygonArea(plane) >= 0.001 && (turns.every(t => t > 1e-6) || turns.every(t => t < -1e-6));
}

/** Maps a fitted box to photo coordinates. UI and raster composition share this projection. */
export function manualPlacementQuad(placement: ManualPlacement): Quad {
  const b = placement.box;
  const corners: Quad = [{ x: b.xMin, y: b.yMin }, { x: b.xMax, y: b.yMin },
    { x: b.xMax, y: b.yMax }, { x: b.xMin, y: b.yMax }];
  if (!placement.plane) return corners;
  if (!isManualPlaneValid(placement.plane)) throw new GeometryError("Invalid manual plane", "DEGENERATE_SURFACE");
  const matrix = solveHomography(unitQuad, placement.plane);
  return corners.map(p => projectPoint(matrix, p)) as unknown as Quad;
}

export function projectManualPhotoPointToPlane(point: Point, plane: Quad): Point | null {
  try {
    const projected = projectPoint(solveHomography(plane, unitQuad), point);
    return Number.isFinite(projected.x) && Number.isFinite(projected.y) ? projected : null;
  } catch { return null; }
}

/** Aspect of a unit-plane rectangle in pixel space, estimated from opposing edges. */
function planeAspect(placement: ManualPlacement, width: number, height: number): number {
  if (!placement.plane) return width / height;
  const pixels = placement.plane.map(p => ({ x: p.x * width, y: p.y * height })) as unknown as Quad;
  return (distance(pixels[0], pixels[1]) + distance(pixels[3], pixels[2])) /
    (distance(pixels[0], pixels[3]) + distance(pixels[1], pixels[2]));
}

/** Fit the actual cropped alpha bounds, bottom-centred for a standing object. */
export function fitManualProductBox(placement: ManualPlacement, productAspectRatio: number,
  sceneWidthPx: number, sceneHeightPx: number, kind: "standing" | "flat" | "wall" = "standing"): ManualPlacement {
  if (![productAspectRatio, sceneWidthPx, sceneHeightPx].every(n => Number.isFinite(n) && n > 0))
    throw new GeometryError("Invalid manual product aspect", "INVALID_DIMENSION");
  const b = placement.box;
  const width = b.xMax - b.xMin; const height = b.yMax - b.yMin;
  const aspect = productAspectRatio / planeAspect(placement, sceneWidthPx, sceneHeightPx);
  const fittedWidth = Math.min(width, height * aspect);
  const fittedHeight = fittedWidth / aspect;
  const centerX = (b.xMin + b.xMax) / 2;
  const yMax = kind === "standing" ? b.yMax : (b.yMin + b.yMax + fittedHeight) / 2;
  return { ...placement, box: { xMin: centerX - fittedWidth / 2, xMax: centerX + fittedWidth / 2,
    yMin: yMax - fittedHeight, yMax } };
}

/** Resize around bottom contact (standing) or the centre (plane), bounded by the image. */
export function resizeManualPlacement(placement: ManualPlacement, requestedWidth: number,
  kind: "standing" | "flat" | "wall" = "standing"): ManualPlacement {
  const b = placement.box;
  const ratio = (b.yMax - b.yMin) / (b.xMax - b.xMin);
  const cx = (b.xMin + b.xMax) / 2; const cy = (b.yMin + b.yMax) / 2;
  const maxWidth = Math.min(2 * Math.min(cx, 1 - cx),
    (kind === "standing" ? b.yMax : 2 * Math.min(cy, 1 - cy)) / ratio);
  const width = Math.min(maxWidth, Math.max(0.005, requestedWidth)); const height = width * ratio;
  const yMax = kind === "standing" ? b.yMax : cy + height / 2;
  return { ...placement, box: { xMin: cx - width / 2, xMax: cx + width / 2, yMin: yMax - height, yMax } };
}

export function moveManualPlacement(placement: ManualPlacement, target: Point,
  kind: "standing" | "flat" | "wall" = "standing"): ManualPlacement {
  const b = placement.box; const width = b.xMax - b.xMin; const height = b.yMax - b.yMin;
  const cx = Math.max(width / 2, Math.min(1 - width / 2, target.x));
  const yMax = kind === "standing" ? Math.max(height, Math.min(1, target.y))
    : Math.max(height, Math.min(1, target.y + height / 2));
  return { ...placement, box: { xMin: cx - width / 2, xMax: cx + width / 2, yMin: yMax - height, yMax } };
}

export function manualPlacementAnchor(placement: ManualPlacement, kind: "standing" | "flat" | "wall" = "standing"): Point {
  const b = placement.box;
  const point = { x: (b.xMin + b.xMax) / 2, y: kind === "standing" ? b.yMax : (b.yMin + b.yMax) / 2 };
  return placement.plane ? projectPoint(solveHomography(unitQuad, placement.plane), point) : point;
}

/** CSS matrix for an element sized 1px by 1px; coordinates are displayed photo pixels. */
export function manualPlacementTransform(placement: ManualPlacement, displayWidthPx: number, displayHeightPx: number): string {
  const target = manualPlacementQuad(placement).map(p => ({ x: p.x * displayWidthPx, y: p.y * displayHeightPx })) as unknown as Quad;
  const h: Matrix3 = solveHomography(unitQuad, target);
  return `matrix3d(${h[0]},${h[3]},0,${h[6]},${h[1]},${h[4]},0,${h[7]},0,0,1,0,${h[2]},${h[5]},0,1)`;
}
