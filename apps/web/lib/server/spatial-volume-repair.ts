import "server-only";
import { z } from "zod";
import {
  validateVolumeTransform,
  volumeToModel,
  type VolumeCropTransform,
} from "./spatial-volume-geometry";

export const SPATIAL_VOLUME_NUMERIC_REPAIR_POLICY =
  "spatial-volume-numeric-repair-v1" as const;
const unit = z.number().finite().min(0).max(1);
const pointSchema = z.object({ x: unit, y: unit }).strict();
const boxSchema = z
  .object({ xMin: unit, yMin: unit, xMax: unit, yMax: unit })
  .strict()
  .refine((v) => v.xMin < v.xMax && v.yMin < v.yMax, "Invalid observation box");
export const volumeReviewObservationsSchema = z
  .object({
    policy: z.literal(SPATIAL_VOLUME_NUMERIC_REPAIR_POLICY),
    source: z.literal("validated-visual-review"),
    coordinateSpace: z.literal("normalized-original-room"),
    reviewConfidence: unit,
    products: z
      .array(
        z
          .object({
            productId: z.string().min(1).max(160),
            confidence: unit,
            foregroundOccluded: z.boolean(),
            expectedBox: boxSchema,
            expectedContact: pointSchema,
            observedBox: boxSchema.nullable(),
            observedContact: pointSchema.nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict()
  .refine(
    (v) =>
      new Set(v.products.map((p) => p.productId)).size === v.products.length,
    "Duplicate observed placement",
  );
export type VolumeReviewObservations = z.infer<
  typeof volumeReviewObservationsSchema
>;
type Box = z.infer<typeof boxSchema>;
type Point = z.infer<typeof pointSchema>;
type PixelBox = { left: number; top: number; right: number; bottom: number };
const sameBox = (a: Box, b: Box) =>
  (Object.keys(a) as Array<keyof Box>).every((k) => a[k] === b[k]);
const samePoint = (a: Point, b: Point) => a.x === b.x && a.y === b.y;

/** Diagnostic feedback only. It cannot change geometry, masks, candidate bytes or acceptance. */
export function prepareSpatialVolumeNumericRepair(input: {
  observations: VolumeReviewObservations | undefined;
  productId: string;
  expectedBox: Box;
  expectedContact: Point;
  dimensions: { widthCm: number; heightCm: number; depthCm: number };
  yawDegrees: number;
  transform: VolumeCropTransform;
  candidateSha256: string;
}) {
  validateVolumeTransform(input.transform);
  const unavailable = (reason: string) => ({
    policy: SPATIAL_VOLUME_NUMERIC_REPAIR_POLICY,
    status: "unavailable" as const,
    candidateSha256: input.candidateSha256,
    reason,
  });
  if (!/^[a-f0-9]{64}$/.test(input.candidateSha256))
    return unavailable("invalid-candidate-provenance");
  const parsed = volumeReviewObservationsSchema.safeParse(input.observations);
  if (!parsed.success)
    return unavailable("missing-or-invalid-validated-observation");
  const data = parsed.data,
    observation = data.products.find((p) => p.productId === input.productId);
  const expected = boxSchema.safeParse(input.expectedBox),
    contact = pointSchema.safeParse(input.expectedContact);
  if (
    !observation ||
    !expected.success ||
    !contact.success ||
    !sameBox(observation.expectedBox, expected.data) ||
    !samePoint(observation.expectedContact, contact.data)
  )
    return unavailable("observation-contract-mismatch");
  if (
    data.reviewConfidence < 0.9 ||
    observation.confidence < 0.9 ||
    observation.foregroundOccluded ||
    !observation.observedBox ||
    !observation.observedContact
  )
    return unavailable("observation-not-sufficiently-localized");
  if (
    ![
      input.dimensions.widthCm,
      input.dimensions.heightCm,
      input.dimensions.depthCm,
    ].every((v) => Number.isFinite(v) && v > 0 && v <= 2000) ||
    !Number.isFinite(input.yawDegrees) ||
    Math.abs(input.yawDegrees) > 180
  )
    return unavailable("invalid-fixed-volume-contract");
  const t = input.transform;
  const pixelPoint = (p: Point) =>
    volumeToModel({ x: p.x * t.frame.width, y: p.y * t.frame.height }, t);
  const pixelBox = (b: Box): PixelBox => {
    const low = pixelPoint({ x: b.xMin, y: b.yMin }),
      high = pixelPoint({ x: b.xMax, y: b.yMax });
    return { left: low.x, top: low.y, right: high.x, bottom: high.y };
  };
  const target = pixelBox(expected.data),
    observed = pixelBox(observation.observedBox);
  const targetContact = pixelPoint(contact.data),
    observedContact = pixelPoint(observation.observedContact);
  // Exactly the existing envelope QA tolerance; this diagnostic never sets acceptance.
  const tolerance = {
    x:
      Math.max(0.003, (expected.data.xMax - expected.data.xMin) * 0.04) *
      t.frame.width *
      t.scale,
    y:
      Math.max(0.003, (expected.data.yMax - expected.data.yMin) * 0.04) *
      t.frame.height *
      t.scale,
  };
  const delta = {
    left: observed.left - target.left,
    top: observed.top - target.top,
    right: observed.right - target.right,
    bottom: observed.bottom - target.bottom,
  };
  const excessBeyondTolerance = {
    left: Math.max(0, target.left - tolerance.x - observed.left),
    top: Math.max(0, target.top - tolerance.y - observed.top),
    right: Math.max(0, observed.right - target.right - tolerance.x),
    bottom: Math.max(0, observed.bottom - target.bottom - tolerance.y),
  };
  const feedbackData = {
    coordinateSpace: "fixed-model-crop-pixels" as const,
    canvas: t.model,
    target,
    observed,
    targetContact,
    observedContact,
    observedMinusTargetEdges: delta,
    observedMinusTargetContact: {
      x: observedContact.x - targetContact.x,
      y: observedContact.y - targetContact.y,
    },
    excessBeyondUnchangedQaTolerance: excessBeyondTolerance,
    qaTolerance: tolerance,
    targetWidth: target.right - target.left,
    targetHeight: target.bottom - target.top,
    observedWidth: observed.right - observed.left,
    observedHeight: observed.bottom - observed.top,
    dimensionsCm: input.dimensions,
    yawDegreesAlreadyApplied: input.yawDegrees,
  };
  const readable = JSON.stringify(feedbackData, (_key, value) =>
    typeof value === "number" ? Number(value.toFixed(3)) : value,
  );
  return {
    policy: SPATIAL_VOLUME_NUMERIC_REPAIR_POLICY,
    status: "ready" as const,
    source: data.source,
    candidateSha256: input.candidateSha256,
    observation: { ...observation, reviewConfidence: data.reviewConfidence },
    feedbackData,
    prompt: [
      "NUMERIC REPAIR DIAGNOSTIC: the following observation describes the previous rejected output, not a new placement target. No previous image is supplied; regenerate from the same original proxy, catalogue and guide.",
      readable,
      "All coordinates are in the unchanged model crop, with x to the right and y down. Signed edge deltas are observed minus target; positive excess values identify a rejected overshoot after the unchanged QA tolerance. The target envelope and contact remain the goal; the tolerance is localization noise, never a request to enlarge or move the target.",
      "Restore the original projected edge directions, nominal outer bounds and support anchor. Keep the catalogue dimensions, all characteristic parts, openings, yaw and camera unchanged. Yaw has already been applied to the guide. Do not crop off genuine product parts, fill natural empty corners, resize the canvas, alter the mask, shift the anchor or fit the silhouette after generation. These observations are visual estimates, not physical measurements.",
    ].join("\n"),
  };
}
