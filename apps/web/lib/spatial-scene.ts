import { z } from "zod";
import {
  calibrateSpatialSupport,
  projectSpatialBox,
  projectSpatialEnvelope,
  type SpatialCamera,
  type SpatialSize,
} from "@lili/geometry";
import { SPATIAL_SUPPORT_LIMITS, type SpatialReference } from "@lili/types";

export const SPATIAL_SCENE_VERSION = "room-geometry-v1";
const point = z
  .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
  .strict();
const polygon = z.array(point).min(3).max(16);
const MAX_SUPPORT_HOLES = SPATIAL_SUPPORT_LIMITS.holes;
const MAX_SUPPORT_OBSTACLES = SPATIAL_SUPPORT_LIMITS.obstacles;
const MAX_SUPPORT_EVIDENCE = SPATIAL_SUPPORT_LIMITS.evidence;
/** Global planning combines all exclusions. Keep this distinct from the frozen
 * v1 provider response schema, which described at most twelve holes. */
export const plannedSupportSchema = z
  .object({
    kind: z.enum(["floor", "table", "shelf", "unsupported"]),
    pointOnVisibleSupport: z.boolean(),
    occupied: z.boolean(),
    boundary: polygon,
    holes: z.array(polygon).max(MAX_SUPPORT_HOLES + MAX_SUPPORT_OBSTACLES),
    evidence: z.string().min(1).max(MAX_SUPPORT_EVIDENCE),
  })
  .strict();
const interval = (min: number, max: number) =>
  z
    .object({
      min: z.number().min(min).max(max),
      estimate: z.number().min(min).max(max),
      max: z.number().min(min).max(max),
    })
    .strict()
    .refine(
      (v) => v.min <= v.estimate && v.estimate <= v.max,
      "Unordered uncertainty interval",
    );
export const globalSpatialSceneSchema = z
  .object({
    focalLengthInImageWidths: interval(0.35, 3),
    pitchDownDegrees: interval(-75, 80),
    cameraEvidence: z.string().min(1).max(1000),
    lighting: z.string().min(1).max(600),
    reflectiveRegions: z.array(polygon).max(12),
    surfaces: z
      .array(
        z
          .object({
            kind: z.enum(["floor", "table", "shelf"]),
            label: z.string().min(1).max(200),
            heightAboveSupportCm: interval(-400, 600).refine(
              (v) => v.min * v.max > 0 && Math.abs(v.estimate) >= 1,
              "Camera cannot cross the support",
            ),
            yawDegrees: z.number().min(-180).max(180),
            boundary: polygon,
            holes: z.array(polygon).max(MAX_SUPPORT_HOLES),
            obstacles: z.array(polygon).max(MAX_SUPPORT_OBSTACLES),
            scaleEvidence: z.string().min(1).max(MAX_SUPPORT_EVIDENCE),
          })
          .strict(),
      )
      .max(12),
  })
  .strict();
export type GlobalSpatialScene = z.infer<typeof globalSpatialSceneSchema>;
export type SpatialSurface = GlobalSpatialScene["surfaces"][number];
export function insidePolygon(
  p: { x: number; y: number },
  polygon: Array<{ x: number; y: number }>,
) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!,
      b = polygon[j]!;
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}
export function isFreeSupport(
  p: { x: number; y: number },
  surface: SpatialSurface,
) {
  return (
    insidePolygon(p, surface.boundary) &&
    ![...surface.holes, ...surface.obstacles].some((polygon) =>
      insidePolygon(p, polygon),
    )
  );
}
const cross = (
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
/** Conservative intersection: touching a support hole/edge is ambiguous and refused. */
function intersects(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
  d: { x: number; y: number },
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
export function segmentOnSupport(
  a: { x: number; y: number },
  b: { x: number; y: number },
  surface: SpatialSurface,
) {
  if (!isFreeSupport(a, surface) || !isFreeSupport(b, surface)) return false;
  return ![surface.boundary, ...surface.holes, ...surface.obstacles].some(
    (poly) =>
      poly.some((c, i) => intersects(a, b, c, poly[(i + 1) % poly.length]!)),
  );
}
export function footprintOnSupport(
  footprint: Array<{ x: number; y: number }>,
  surface: SpatialSurface,
) {
  return (
    footprint.every((p, i) =>
      segmentOnSupport(p, footprint[(i + 1) % footprint.length]!, surface),
    ) &&
    ![...surface.holes, ...surface.obstacles].some((polygon) =>
      polygon.some((p) => insidePolygon(p, footprint)),
    )
  );
}
export class SpatialPlanningError extends Error {
  readonly status = 422;
}
export function planSpatialPlacement(input: {
  scene: GlobalSpatialScene;
  fingerprint: string;
  width: number;
  height: number;
  point: { x: number; y: number };
  kind: "floor" | "table" | "shelf";
  size: SpatialSize;
  shape?: "plane" | "volume";
  yawDegrees?: number;
  reference?: SpatialReference;
}) {
  const { scene, point, reference } = input;
  const candidates = scene.surfaces
    .map((surface, index) => ({ surface, id: `surface-${index}` }))
    .filter(
      ({ surface }) =>
        surface.kind === input.kind && isFreeSupport(point, surface),
    );
  if (candidates.length !== 1)
    throw new SpatialPlanningError(
      candidates.length
        ? "Plusieurs supports se superposent ici. Choisissez une zone moins ambiguë."
        : "Choisissez un point sur le support libre sélectionné.",
    );
  const { surface, id: surfaceId } = candidates[0]!;
  let camera: SpatialCamera = {
    width: input.width,
    height: input.height,
    focalPx: input.width * scene.focalLengthInImageWidths.estimate,
    pitchDownDegrees: scene.pitchDownDegrees.estimate,
    heightAboveSupportCm: surface.heightAboveSupportCm.estimate,
  };
  const assumptions = [
    scene.cameraEvidence,
    surface.scaleEvidence,
    "La focale et l’inclinaison restent estimées ; les intervalles ne sont pas des garanties statistiques.",
  ];
  if (reference) {
    if (
      reference.sceneFingerprint !== input.fingerprint ||
      reference.surfaceId !== surfaceId ||
      !segmentOnSupport(reference.points[0], reference.points[1], surface)
    )
      throw new SpatialPlanningError(
        "La référence doit appartenir à cette photo et au même support libre que l’objet.",
      );
    try {
      camera = calibrateSpatialSupport(
        camera,
        reference.points.map((p) => ({
          x: p.x * input.width,
          y: p.y * input.height,
        })) as [{ x: number; y: number }, { x: number; y: number }],
        reference.lengthCm,
      ).camera;
    } catch {
      throw new SpatialPlanningError(
        "Éloignez les deux points de référence et vérifiez la longueur indiquée.",
      );
    }
    assumptions.push(
      `Longueur fournie par l’utilisateur : ${reference.lengthCm} cm sur ${surfaceId}. Elle fixe l’échelle du support, pas la précision de toute la caméra.`,
    );
  }
  let projection: ReturnType<typeof projectSpatialBox>;
  try {
    projection = projectSpatialEnvelope(
      camera,
      { x: point.x * input.width, y: point.y * input.height },
      input.size,
      input.yawDegrees ?? surface.yawDegrees,
      input.shape,
    );
  } catch {
    throw new SpatialPlanningError(
      "Ce volume ne peut pas être projeté ici. Déplacez le point ou changez de photo.",
    );
  }
  const b = projection.bounds;
  const footprint = projection.footprint.map((p) => ({
    x: p.x / input.width,
    y: p.y / input.height,
  }));
  return {
    camera,
    projection,
    surface,
    surfaceId,
    calibration: reference
      ? ("reference_scaled" as const)
      : ("approximate" as const),
    assumptions,
    fits:
      b.left >= 0 &&
      b.top >= 0 &&
      b.right <= input.width &&
      b.bottom <= input.height,
    supportFits: footprintOnSupport(footprint, surface),
  };
}
