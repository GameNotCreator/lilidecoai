import "server-only";
import type { Db } from "mongodb";
import sharp from "sharp";
import type { SpatialPreview, SpatialReference } from "@lili/types";
import type { SpatialSize } from "@lili/geometry";
import {
  planSpatialPlacement,
  plannedSupportSchema,
  type GlobalSpatialScene,
} from "../spatial-scene";
import { cachedSpatialRoom } from "./spatial-scene-cache";
import type { SceneDocument } from "./types";
import type { SpatialSceneEstimate } from "./ai/spatial-placement";

export async function getRoomGeometry(
  db: Db,
  scene: SceneDocument,
  room: Buffer,
  model: string,
  deadlineMs?: number,
  load?: Parameters<typeof cachedSpatialRoom>[2],
) {
  return cachedSpatialRoom(
    db,
    {
      organizationId: scene.organizationId,
      sessionId: scene.publicSessionId,
      assetId: scene.assetId,
      expiresAt: scene.expiresAt,
      room,
      model,
      deadlineMs,
    },
    load,
  );
}
export async function buildSpatialPlan(
  room: Buffer,
  analysis: { value: GlobalSpatialScene; fingerprint: string },
  input: {
    point: { x: number; y: number };
    kind: "floor" | "table" | "shelf";
    size: SpatialSize;
    shape?: "plane" | "volume";
    yawDegrees?: number;
    reference?: SpatialReference;
  },
) {
  const { width, height } = await sharp(room).metadata();
  if (!width || !height) throw new Error("Photo dimensions missing");
  const plan = planSpatialPlacement({
    ...input,
    scene: analysis.value,
    fingerprint: analysis.fingerprint,
    width,
    height,
  });
  const supportAssessment = plannedSupportSchema.parse({
    kind: plan.surface.kind,
    pointOnVisibleSupport: true,
    occupied: false,
    boundary: plan.surface.boundary,
    holes: [...plan.surface.holes, ...plan.surface.obstacles],
    evidence: plan.surface.scaleEvidence,
  });
  const estimate: SpatialSceneEstimate & {
    supportAssessment: typeof supportAssessment;
  } = {
    camera: {
      focalLengthInImageWidths: plan.camera.focalPx / width,
      heightAboveSupportCm: plan.camera.heightAboveSupportCm,
      pitchDownDegrees: plan.camera.pitchDownDegrees,
    },
    yawDegrees: plan.projection.yawDegrees,
    support: plan.surface.label,
    cameraEvidence: analysis.value.cameraEvidence,
    scaleReference: plan.assumptions.join(" "),
    visibleFaces:
      "Derive visible tops, sides and contacts from the room camera and volume guide. Hidden product faces remain hypotheses.",
    lighting: analysis.value.lighting,
    occlusions: JSON.stringify(plan.surface.obstacles),
    hiddenGeometryAssumptions:
      "Only supplied catalog views are factual; unseen faces are inferred.",
    confidence: 0,
    supportAssessment,
  };
  const preview: SpatialPreview = {
    sceneFingerprint: analysis.fingerprint,
    surfaceId: plan.surfaceId,
    calibration: plan.calibration,
    corners: plan.projection.points.map((p) => ({
      x: p.x / width,
      y: p.y / height,
    })),
    fits: plan.fits,
    supportFits: plan.supportFits,
    assumptions: plan.assumptions,
  };
  const uncertainty = {
    source: "model_estimate_not_statistical" as const,
    focalLengthInImageWidths: [
      analysis.value.focalLengthInImageWidths.min,
      analysis.value.focalLengthInImageWidths.max,
    ],
    pitchDownDegrees: [
      analysis.value.pitchDownDegrees.min,
      analysis.value.pitchDownDegrees.max,
    ],
    heightAboveSupportCm: [
      plan.surface.heightAboveSupportCm.min,
      plan.surface.heightAboveSupportCm.max,
    ],
  };
  return {
    ...plan,
    estimate,
    preview,
    uncertainty,
    reflectiveRegions: analysis.value.reflectiveRegions,
  };
}
