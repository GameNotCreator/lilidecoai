import type { Point } from "@lili/geometry";

type Polygon = readonly Point[];
type Sample = { alpha: number; premultiplied: number[] };

function clipHalfPlane(
  polygon: Polygon,
  distance: (p: Point) => number,
): Point[] {
  const result: Point[] = [];
  if (!polygon.length) return result;
  let previous = polygon[polygon.length - 1]!,
    before = distance(previous);
  for (const current of polygon) {
    const after = distance(current);
    if (before >= 0 !== after >= 0) {
      const t = before / (before - after);
      result.push({
        x: previous.x + t * (current.x - previous.x),
        y: previous.y + t * (current.y - previous.y),
      });
    }
    if (after >= 0) result.push(current);
    previous = current;
    before = after;
  }
  return result;
}

/** Both polygons have positive signed area in image coordinates. */
export function clipTexturePolygon(
  polygon: Polygon,
  boundary: Polygon,
): Point[] {
  let result = [...polygon];
  for (let i = 0; i < boundary.length && result.length; i++) {
    const a = boundary[i]!,
      b = boundary[(i + 1) % boundary.length]!;
    result = clipHalfPlane(
      result,
      (p) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x),
    );
  }
  return result;
}

function clipRectangle(
  polygon: Polygon,
  left: number,
  top: number,
  right: number,
  bottom: number,
) {
  let result = clipHalfPlane(polygon, (p) => p.x - left);
  result = clipHalfPlane(result, (p) => right - p.x);
  result = clipHalfPlane(result, (p) => p.y - top);
  return clipHalfPlane(result, (p) => bottom - p.y);
}

function area(polygon: Polygon): number {
  if (polygon.length < 3) return 0;
  const origin = polygon[0]!;
  let sum = 0;
  for (let i = 1; i < polygon.length - 1; i++) {
    const a = polygon[i]!,
      b = polygon[i + 1]!;
    sum +=
      (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
  }
  return Math.abs(sum) / 2;
}

/** Integrates piecewise-constant source texels over an inverse pixel footprint.
 * Fully covered blocks use cached premultiplied sums; only boundary blocks are
 * subdivided. No fixed sample count can lock onto a periodic motif. The weights
 * are source-space areas (a local approximation under projective distortion).
 * Source-crop coverage and texture alpha are deliberately separate. */
export function createPlanarAreaSampler(
  rgba: Buffer,
  width: number,
  height: number,
  crop: Polygon,
) {
  const levels: Array<{ width: number; height: number; sums: Float32Array }> =
    [];
  function buildSums() {
    let w = width,
      h = height;
    while (w > 1 || h > 1) {
      const nextWidth = Math.ceil(w / 2),
        nextHeight = Math.ceil(h / 2);
      const sums = new Float32Array(nextWidth * nextHeight * 4);
      const previous = levels[levels.length - 1];
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const from = (y * w + x) * 4,
            to = (Math.floor(y / 2) * nextWidth + Math.floor(x / 2)) * 4;
          if (previous) {
            for (let c = 0; c < 4; c++)
              sums[to + c]! += previous.sums[from + c]!;
          } else {
            const alpha = rgba[from + 3]! / 255;
            for (let c = 0; c < 3; c++)
              sums[to + c]! += rgba[from + c]! * alpha;
            sums[to + 3]! += alpha;
          }
        }
      levels.push({ width: nextWidth, height: nextHeight, sums });
      w = nextWidth;
      h = nextHeight;
    }
  }
  return (footprint: Polygon): Sample | undefined => {
    const polygon = clipTexturePolygon(footprint, crop),
      coverage = area(polygon);
    if (coverage <= 1e-9) return undefined;
    const total = [0, 0, 0, 0];
    function addTexel(x: number, y: number, weight: number) {
      const offset = (y * width + x) * 4,
        alpha = (rgba[offset + 3]! / 255) * weight;
      for (let c = 0; c < 3; c++) total[c]! += rgba[offset + c]! * alpha;
      total[3]! += alpha;
    }
    const left = Math.max(0, Math.floor(Math.min(...polygon.map((p) => p.x))));
    const top = Math.max(0, Math.floor(Math.min(...polygon.map((p) => p.y))));
    const right = Math.min(
      width,
      Math.ceil(Math.max(...polygon.map((p) => p.x))),
    );
    const bottom = Math.min(
      height,
      Math.ceil(Math.max(...polygon.map((p) => p.y))),
    );
    if ((right - left) * (bottom - top) <= 64) {
      for (let y = top; y < bottom; y++)
        for (let x = left; x < right; x++)
          addTexel(x, y, area(clipRectangle(polygon, x, y, x + 1, y + 1)));
    } else {
      if (!levels.length) buildSums();
      function visit(level: number, x: number, y: number, polygon: Polygon) {
        const size = 2 ** level,
          left = x * size,
          top = y * size;
        if (left >= width || top >= height) return;
        const right = Math.min(width, left + size),
          bottom = Math.min(height, top + size);
        const clipped = clipRectangle(polygon, left, top, right, bottom),
          covered = area(clipped);
        if (covered <= 1e-9) return;
        if (level === 0) {
          addTexel(x, y, covered);
          return;
        }
        if (Math.abs(covered - (right - left) * (bottom - top)) <= 1e-8) {
          const data = levels[level - 1]!,
            offset = (y * data.width + x) * 4;
          for (let c = 0; c < 4; c++) total[c]! += data.sums[offset + c]!;
          return;
        }
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++)
            visit(level - 1, x * 2 + dx, y * 2 + dy, clipped);
      }
      visit(levels.length, 0, 0, polygon);
    }
    return {
      alpha: Math.min(1, total[3]! / coverage),
      premultiplied: total.slice(0, 3).map((value) => value / coverage),
    };
  };
}
