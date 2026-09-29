import {
  intersectSupport,
  projectSpatialPoint,
  type SpatialCamera,
  type ScreenPoint,
  type SpatialSize,
  projectSpatialBox,
} from "./spatial-projection";
/** Eight matching corners keep the preview contract compatible; for a plane the
 * top and bottom coincide. The saved physical thickness is not used as depth. */
export function projectSpatialEnvelope(
  camera: SpatialCamera,
  anchor: ScreenPoint,
  size: SpatialSize,
  yawDegrees: number,
  shape: "plane" | "volume" = "volume",
): ReturnType<typeof projectSpatialBox> {
  if (shape === "volume")
    return projectSpatialBox(camera, anchor, size, yawDegrees);
  const plane = projectSpatialPlane(camera, anchor, size, yawDegrees);
  return {
    version: plane.version,
    origin: plane.origin,
    size,
    yawDegrees,
    world: [...plane.world, ...plane.world],
    points: [...plane.corners, ...plane.corners],
    footprint: plane.corners,
    bounds: {
      left: Math.min(...plane.corners.map((p) => p.x)),
      right: Math.max(...plane.corners.map((p) => p.x)),
      top: Math.min(...plane.corners.map((p) => p.y)),
      bottom: Math.max(...plane.corners.map((p) => p.y)),
    },
    metricVerified: false,
  };
}
/** Floor texture corners: far-left, far-right, near-right, near-left before yaw.
 * Width follows the first edge; depth follows the second. Thickness is not used. */
export function projectSpatialPlane(
  camera: SpatialCamera,
  anchor: ScreenPoint,
  size: { widthCm: number; depthCm: number },
  yawDegrees: number,
) {
  if (
    camera.heightAboveSupportCm <= 0 ||
    ![size.widthCm, size.depthCm].every(
      (n) => Number.isFinite(n) && n > 0 && n <= 2000,
    ) ||
    !Number.isFinite(yawDegrees)
  )
    throw new Error("Invalid horizontal plane");
  const origin = intersectSupport(camera, anchor),
    angle = (yawDegrees * Math.PI) / 180;
  const world = [
    [-1, 1],
    [1, 1],
    [1, -1],
    [-1, -1],
  ].map(([sx, sz]) => {
    const x = (sx! * size.widthCm) / 2,
      z = (sz! * size.depthCm) / 2;
    return {
      x: origin.x + x * Math.cos(angle) + z * Math.sin(angle),
      y: 0,
      z: origin.z - x * Math.sin(angle) + z * Math.cos(angle),
    };
  });
  const corners = world.map((p) => projectSpatialPoint(camera, p)) as [
    ScreenPoint,
    ScreenPoint,
    ScreenPoint,
    ScreenPoint,
  ];
  return {
    version: "spatial-plane-v1" as const,
    origin,
    world,
    corners,
    dimensions: size,
    yawDegrees,
    metricVerified: false as const,
    fits: corners.every(
      (p) =>
        p.x >= 0 && p.x <= camera.width && p.y >= 0 && p.y <= camera.height,
    ),
  };
}
