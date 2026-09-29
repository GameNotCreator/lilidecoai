import "server-only";
import type { ScreenPoint } from "@lili/geometry";

export type VolumeBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};
export type VolumeCropTransform = {
  version: 1;
  frame: { width: number; height: number };
  model: { width: number; height: number };
  window: { left: number; top: number; width: number; height: number };
  intersection: { left: number; top: number; width: number; height: number };
  padding: { left: number; top: number; right: number; bottom: number };
  scale: number;
  contextMarginPx: number;
};
export class SpatialVolumeEditError extends Error {
  readonly status = 422;
}
export function volumeRequire(value: unknown, message: string): asserts value {
  if (!value) throw new SpatialVolumeEditError(message);
}
export function validateVolumeGrid(width: number, height: number) {
  volumeRequire(
    [width, height].every((v) => Number.isInteger(v) && v > 0 && v <= 8192) &&
      width * height <= 25_000_000,
    "Invalid volume image dimensions",
  );
}
export function volumeMaskBounds(
  mask: Uint8Array,
  width: number,
  height: number,
): VolumeBounds {
  validateVolumeGrid(width, height);
  volumeRequire(mask.length === width * height, "Invalid mask dimensions");
  let left = width,
    top = height,
    right = -1,
    bottom = -1;
  for (let i = 0; i < mask.length; i++) {
    volumeRequire(mask[i] === 0 || mask[i] === 255, "Mask is not binary");
    if (!mask[i]) continue;
    const x = i % width,
      y = Math.floor(i / width);
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  volumeRequire(right >= left, "Empty volume authorization");
  return { left, top, right: right + 1, bottom: bottom + 1 };
}
export function planVolumeCrop(
  width: number,
  height: number,
  authorization: VolumeBounds,
  nominal: VolumeBounds,
): VolumeCropTransform {
  validateVolumeGrid(width, height);
  for (const b of [authorization, nominal]) {
    volumeRequire(
      Object.values(b).every(Number.isFinite) &&
        b.left >= 0 &&
        b.top >= 0 &&
        b.right <= width &&
        b.bottom <= height &&
        b.right > b.left &&
        b.bottom > b.top,
      "Volume bounds outside frame",
    );
  }
  volumeRequire(
    nominal.left >= authorization.left &&
      nominal.top >= authorization.top &&
      nominal.right <= authorization.right &&
      nominal.bottom <= authorization.bottom,
    "Nominal volume outside authorization",
  );
  const contextMarginPx = Math.max(
    32,
    Math.ceil(
      0.5 *
        Math.max(nominal.right - nominal.left, nominal.bottom - nominal.top),
    ),
  );
  const side = Math.max(
    512,
    Math.ceil(
      Math.max(
        authorization.right - authorization.left,
        authorization.bottom - authorization.top,
      ) +
        contextMarginPx * 2,
    ),
  );
  volumeRequire(
    side <= 2048,
    "Required volume context exceeds crop limit; shrinking is forbidden",
  );
  const origin = (low: number, high: number, frame: number) =>
    side <= frame
      ? Math.max(0, Math.min(frame - side, Math.floor((low + high - side) / 2)))
      : Math.floor((frame - side) / 2);
  const left = origin(authorization.left, authorization.right, width),
    top = origin(authorization.top, authorization.bottom, height);
  volumeRequire(
    left <= authorization.left &&
      top <= authorization.top &&
      left + side >= authorization.right &&
      top + side >= authorization.bottom,
    "Crop clips volume authorization",
  );
  const x = Math.max(0, left),
    y = Math.max(0, top),
    right = Math.min(width, left + side),
    bottom = Math.min(height, top + side);
  return {
    version: 1,
    frame: { width, height },
    model: { width: 1024, height: 1024 },
    window: { left, top, width: side, height: side },
    intersection: { left: x, top: y, width: right - x, height: bottom - y },
    padding: {
      left: x - left,
      top: y - top,
      right: left + side - right,
      bottom: top + side - bottom,
    },
    scale: 1024 / side,
    contextMarginPx,
  };
}
export function validateVolumeTransform(t: VolumeCropTransform) {
  volumeRequire(
    t?.version === 1 && t.model?.width === 1024 && t.model.height === 1024,
    "Unsupported volume transform",
  );
  validateVolumeGrid(t.frame.width, t.frame.height);
  volumeRequire(
    Object.values(t.window).every(Number.isInteger) &&
      t.window.width === t.window.height &&
      t.window.width >= 512 &&
      t.window.width <= 2048 &&
      t.scale === 1024 / t.window.width,
    "Invalid volume crop transform",
  );
  volumeRequire(
    Number.isInteger(t.contextMarginPx) && t.contextMarginPx >= 32,
    "Invalid context margin",
  );
  const x = Math.max(0, t.window.left),
    y = Math.max(0, t.window.top),
    right = Math.min(t.frame.width, t.window.left + t.window.width),
    bottom = Math.min(t.frame.height, t.window.top + t.window.height);
  volumeRequire(
    t.intersection.left === x &&
      t.intersection.top === y &&
      t.intersection.width === right - x &&
      t.intersection.height === bottom - y &&
      right > x &&
      bottom > y,
    "Invalid volume crop intersection",
  );
  volumeRequire(
    t.padding.left === x - t.window.left &&
      t.padding.top === y - t.window.top &&
      t.padding.right === t.window.left + t.window.width - right &&
      t.padding.bottom === t.window.top + t.window.height - bottom &&
      Object.values(t.padding).every((v) => v >= 0),
    "Invalid volume crop padding",
  );
}
export const volumeToModel = (
  p: ScreenPoint,
  t: VolumeCropTransform,
): ScreenPoint => ({
  x: (p.x - t.window.left) * t.scale,
  y: (p.y - t.window.top) * t.scale,
});
export const volumeToFrame = (
  p: ScreenPoint,
  t: VolumeCropTransform,
): ScreenPoint => ({
  x: p.x / t.scale + t.window.left,
  y: p.y / t.scale + t.window.top,
});

const cross = (a: ScreenPoint, b: ScreenPoint, c: ScreenPoint) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const touchesSegment = (p: ScreenPoint, a: ScreenPoint, b: ScreenPoint) =>
  Math.abs(cross(a, b, p)) < 1e-12 &&
  p.x >= Math.min(a.x, b.x) &&
  p.x <= Math.max(a.x, b.x) &&
  p.y >= Math.min(a.y, b.y) &&
  p.y <= Math.max(a.y, b.y);
export function volumeSegmentsIntersect(
  a: ScreenPoint,
  b: ScreenPoint,
  c: ScreenPoint,
  d: ScreenPoint,
) {
  return (
    Math.max(a.x, b.x) >= Math.min(c.x, d.x) &&
    Math.max(c.x, d.x) >= Math.min(a.x, b.x) &&
    Math.max(a.y, b.y) >= Math.min(c.y, d.y) &&
    Math.max(c.y, d.y) >= Math.min(a.y, b.y) &&
    cross(a, b, c) * cross(a, b, d) <= 0 &&
    cross(c, d, a) * cross(c, d, b) <= 0
  );
}
export function volumeInside(
  p: ScreenPoint,
  polygon: ScreenPoint[],
  boundaryInside = false,
) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!,
      b = polygon[j]!;
    if (touchesSegment(p, a, b)) return boundaryInside;
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}
export function validateVolumePolygon(points: ScreenPoint[]) {
  volumeRequire(
    Array.isArray(points) &&
      points.length >= 3 &&
      points.length <= 16 &&
      points.every(
        (p) =>
          Number.isFinite(p.x) &&
          Number.isFinite(p.y) &&
          p.x >= 0 &&
          p.x <= 1 &&
          p.y >= 0 &&
          p.y <= 1,
      ),
    "Invalid support polygon",
  );
  volumeRequire(
    new Set(points.map((p) => `${p.x},${p.y}`)).size === points.length,
    "Repeated support vertex",
  );
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!,
      b = points[(i + 1) % points.length]!;
    area += a.x * b.y - b.x * a.y;
    for (let j = i + 1; j < points.length; j++) {
      if (j === (i + 1) % points.length || i === (j + 1) % points.length)
        continue;
      volumeRequire(
        !volumeSegmentsIntersect(
          a,
          b,
          points[j]!,
          points[(j + 1) % points.length]!,
        ),
        "Self-intersecting support polygon",
      );
    }
  }
  volumeRequire(Math.abs(area) > 1e-12, "Degenerate support polygon");
}
export function volumePolygonsIntersect(a: ScreenPoint[], b: ScreenPoint[]) {
  return (
    a.some((p, i) =>
      b.some((q, j) =>
        volumeSegmentsIntersect(
          p,
          a[(i + 1) % a.length]!,
          q,
          b[(j + 1) % b.length]!,
        ),
      ),
    ) ||
    volumeInside(a[0]!, b, true) ||
    volumeInside(b[0]!, a, true)
  );
}
export function volumeFootprintOnSupport(
  footprint: ScreenPoint[],
  boundary: ScreenPoint[],
  exclusions: ScreenPoint[][],
) {
  return (
    footprint.every((p) => volumeInside(p, boundary)) &&
    !footprint.some((p, i) =>
      boundary.some((q, j) =>
        volumeSegmentsIntersect(
          p,
          footprint[(i + 1) % footprint.length]!,
          q,
          boundary[(j + 1) % boundary.length]!,
        ),
      ),
    ) &&
    !exclusions.some((p) => volumePolygonsIntersect(footprint, p))
  );
}
/** Sampling is a finite plausibility grid, not a continuous or statistical bound. */
export function volumeUncertaintyAxis(
  bounds: [number, number],
  nominal: number,
  positive: boolean,
) {
  volumeRequire(
    Array.isArray(bounds) &&
      bounds.length === 2 &&
      [...bounds, nominal].every(Number.isFinite) &&
      bounds[0] <= nominal &&
      nominal <= bounds[1] &&
      (positive ? bounds[0] > 0 : bounds[0] > -89.5 && bounds[1] < 89.5),
    "Invalid or missing camera uncertainty",
  );
  return [
    ...new Set(
      [
        ...Array.from(
          { length: 9 },
          (_, i) => bounds[0] + ((bounds[1] - bounds[0]) * i) / 8,
        ),
        nominal,
      ].map((v) => Number(v.toFixed(12))),
    ),
  ].sort((a, b) => a - b);
}
/** Inverse pixel-center nearest sampling; padding is always fully protected. */
export function volumeModelProtection(
  authorized: Uint8Array,
  t: VolumeCropTransform,
) {
  validateVolumeTransform(t);
  volumeRequire(
    authorized.length === t.frame.width * t.frame.height &&
      authorized.every((v) => v === 0 || v === 255),
    "Invalid nominal authorization mask",
  );
  const rgba = Buffer.alloc(t.model.width * t.model.height * 4, 255);
  for (let y = 0; y < t.model.height; y++)
    for (let x = 0; x < t.model.width; x++) {
      const p = volumeToFrame({ x: x + 0.5, y: y + 0.5 }, t),
        sx = Math.floor(p.x),
        sy = Math.floor(p.y);
      if (
        sx >= 0 &&
        sy >= 0 &&
        sx < t.frame.width &&
        sy < t.frame.height &&
        authorized[sy * t.frame.width + sx] === 255
      )
        rgba[(y * t.model.width + x) * 4 + 3] = 0;
    }
  return rgba;
}
