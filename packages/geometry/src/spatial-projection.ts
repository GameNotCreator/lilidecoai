/** Experimental pinhole scene proxy. Coordinates are cm, Y up, Z away from
 * the camera. Calibration from a single photograph remains an estimate. */
export interface SpatialCamera {
  width: number;
  height: number;
  focalPx: number;
  heightAboveSupportCm: number;
  pitchDownDegrees: number;
}
export interface SpatialPoint {
  x: number;
  y: number;
  z: number;
}
export interface ScreenPoint {
  x: number;
  y: number;
}
export interface SpatialSize {
  widthCm: number;
  heightCm: number;
  depthCm: number;
}
export const SPATIAL_PROJECTION_VERSION = "spatial-proxy-v1";

function cameraBasis(camera: SpatialCamera) {
  if (
    ![camera.width, camera.height, camera.focalPx].every(
      (n) => Number.isFinite(n) && n > 0,
    ) ||
    !Number.isFinite(camera.heightAboveSupportCm) ||
    Math.abs(camera.heightAboveSupportCm) < 1e-3 ||
    !Number.isFinite(camera.pitchDownDegrees) ||
    Math.abs(camera.pitchDownDegrees) >= 89.5
  )
    throw new Error("Invalid spatial camera");
  const pitch = (camera.pitchDownDegrees * Math.PI) / 180;
  return { sin: Math.sin(pitch), cos: Math.cos(pitch) };
}
export function projectSpatialPoint(
  camera: SpatialCamera,
  point: SpatialPoint,
): ScreenPoint {
  const { sin, cos } = cameraBasis(camera);
  if (![point.x, point.y, point.z].every(Number.isFinite))
    throw new Error("Invalid spatial point");
  const dy = point.y - camera.heightAboveSupportCm;
  const depth = -dy * sin + point.z * cos;
  if (depth <= 1e-3) throw new Error("Point behind camera");
  return {
    x: camera.width / 2 + (camera.focalPx * point.x) / depth,
    y:
      camera.height / 2 - (camera.focalPx * (dy * cos + point.z * sin)) / depth,
  };
}
export function intersectSupport(
  camera: SpatialCamera,
  pixel: ScreenPoint,
): SpatialPoint {
  const { sin, cos } = cameraBasis(camera);
  if (
    ![pixel.x, pixel.y].every(Number.isFinite) ||
    pixel.x < 0 ||
    pixel.x > camera.width ||
    pixel.y < 0 ||
    pixel.y > camera.height
  )
    throw new Error("Invalid support point");
  const x = (pixel.x - camera.width / 2) / camera.focalPx,
    up = (camera.height / 2 - pixel.y) / camera.focalPx;
  const dy = up * cos - sin,
    dz = up * sin + cos;
  if (Math.abs(dy) < 1e-5 || dz <= 0)
    throw new Error("Selected ray does not meet support in front of camera");
  const distance = -camera.heightAboveSupportCm / dy;
  if (distance <= 0)
    throw new Error("Selected ray does not meet support in front of camera");
  return { x: distance * x, y: 0, z: distance * dz };
}
export function projectSpatialBox(
  camera: SpatialCamera,
  anchor: ScreenPoint,
  size: SpatialSize,
  yawDegrees: number,
) {
  if (
    ![size.widthCm, size.heightCm, size.depthCm].every(
      (n) => Number.isFinite(n) && n > 0,
    ) ||
    !Number.isFinite(yawDegrees)
  )
    throw new Error("Invalid object volume");
  const origin = intersectSupport(camera, anchor),
    yaw = (yawDegrees * Math.PI) / 180;
  // L'ancre est le centre de la base sur Y=0, pas le coin de la boîte écran.
  // La boîte sert d'enveloppe dimensionnelle ; elle ne décrit pas la silhouette.
  // Near-left, near-right, far-right, far-left, followed by matching top corners.
  const offsets = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  const world = [0, size.heightCm].flatMap((height) =>
    offsets.map(([sx, sz]) => {
      const x = (sx! * size.widthCm) / 2,
        z = (sz! * size.depthCm) / 2;
      return {
        x: origin.x + x * Math.cos(yaw) + z * Math.sin(yaw),
        y: height,
        z: origin.z - x * Math.sin(yaw) + z * Math.cos(yaw),
      };
    }),
  );
  const points = world.map((p) => projectSpatialPoint(camera, p));
  const xs = points.map((p) => p.x),
    ys = points.map((p) => p.y);
  return {
    version: SPATIAL_PROJECTION_VERSION,
    origin,
    size,
    yawDegrees,
    world,
    points,
    footprint: points.slice(0, 4),
    bounds: {
      left: Math.min(...xs),
      top: Math.min(...ys),
      right: Math.max(...xs),
      bottom: Math.max(...ys),
    },
    metricVerified: false as const,
  };
}

/** A known segment fixes the scale of one horizontal plane, not camera intrinsics. */
export function calibrateSpatialSupport(
  camera: SpatialCamera,
  points: [ScreenPoint, ScreenPoint],
  lengthCm: number,
) {
  if (
    !Number.isFinite(lengthCm) ||
    lengthCm <= 0 ||
    lengthCm > 10000 ||
    Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) < 12
  )
    throw new Error("Invalid or too short reference segment");
  const [a, b] = points.map((p) => intersectSupport(camera, p));
  const estimatedLength = Math.hypot(a!.x - b!.x, a!.z - b!.z);
  const factor = lengthCm / estimatedLength;
  const height = camera.heightAboveSupportCm * factor;
  if (
    !Number.isFinite(height) ||
    Math.abs(height) < 1 ||
    Math.abs(height) > 1000
  )
    throw new Error("Reference implies an unusable camera height");
  return {
    camera: { ...camera, heightAboveSupportCm: height },
    scaleFactor: factor,
    referenceLengthCm: lengthCm,
    metricVerified: false as const,
  };
}
