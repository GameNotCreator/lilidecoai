import { z } from "zod";

const id = z.string().trim().min(1).max(160);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const unit = z.number().finite().min(0).max(1);
const point = z.object({ x: unit, y: unit }).strict();
export const preparedViewOrientationSchema = z.object({
  azimuthDeg: z.number().finite().min(-180).max(180),
  elevationDeg: z.number().finite().min(0).max(90),
  rollDeg: z.number().finite().min(-180).max(180),
}).strict();
export const preparedViewCoverageSchema = z.object({
  azimuthMinDeg: z.number().finite().min(-180).max(180),
  azimuthMaxDeg: z.number().finite().min(-180).max(180),
  elevationMinDeg: z.number().finite().min(0).max(90),
  elevationMaxDeg: z.number().finite().min(0).max(90),
}).strict().refine(v => v.azimuthMinDeg <= v.azimuthMaxDeg && v.elevationMinDeg <= v.elevationMaxDeg,
  "La couverture doit être ordonnée, sans franchir -180/180 degrés.");
const criterion = z.enum(["pass", "fail", "indeterminate"]);
export const preparedViewCriteriaSchema = z.object({
  identity: criterion, silhouette: criterion, color: criterion, pattern: criterion,
  alpha: criterion, contact: criterion,
}).strict();
export const preparedViewReviewSchema = z.object({
  id, kind: z.enum(["human", "automated", "agent"]), actorId: id,
  decision: z.enum(["approved", "rejected", "needs_review"]),
  criteria: preparedViewCriteriaSchema,
  coverage: preparedViewCoverageSchema.nullable(),
  allowedUsage: z.literal("internal_preview"),
  limits: z.array(z.string().trim().min(1).max(1000)).max(30),
  unknownFaces: z.array(z.string().trim().min(1).max(200)).max(12),
  evidenceAssetIds: z.array(id).min(1).max(30),
  policyVersion: z.literal("prepared-review-v1"), reviewedAt: z.iso.datetime(),
}).strict();
export const preparedViewAssetSchema = z.object({
  assetId: id, sha256: hash, widthPx: z.number().int().positive(), heightPx: z.number().int().positive(),
}).strict();
export const preparedProductViewSchema = z.object({
  schemaVersion: z.literal(1), id, organizationId: id, productId: id, variantId: id.nullable(),
  revision: z.number().int().positive(), sourceFingerprint: hash, geometryFingerprint: hash,
  sources: z.array(z.object({ assetId: id, sha256: hash, role: z.enum(["front", "top", "three_quarter", "side", "back", "detail"]) }).strict()).min(1).max(12),
  origin: z.enum(["photographed", "generated"]),
  state: z.enum(["queued", "preparing", "needs_review", "approved", "rejected", "revoked", "stale", "failed"]),
  image: preparedViewAssetSchema.nullable(), alpha: preparedViewAssetSchema.nullable(),
  visibleBounds: z.object({ x: unit, y: unit, width: unit, height: unit }).strict().refine(v => v.width > 0 && v.height > 0 && v.x + v.width <= 1.000001 && v.y + v.height <= 1.000001).nullable(),
  anchor: z.object({ x: unit, y: unit, confidence: unit }).strict().nullable(),
  // Annotated vertical segment, distinct from the total PNG height and projected depth.
  physicalHeightSegment: z.object({ bottom: point, top: point }).strict().refine(v => v.bottom.y > v.top.y).nullable(),
  orientation: z.object({
    convention: z.literal("camera-product-degrees-v1"),
    requested: preparedViewOrientationSchema, estimated: preparedViewOrientationSchema.nullable(),
    coverage: preparedViewCoverageSchema.nullable(),
  }).strict(),
  review: preparedViewReviewSchema.nullable(),
  reviewHistory: z.array(preparedViewReviewSchema).max(100).optional(),
  versions: z.object({ preparation: z.enum(["prepared-view-v1", "prepared-view-v2"]), mask: z.string().min(1), prompt: z.string().min(1), providerConfiguration: z.string().min(1) }).strict(),
  preparation: z.object({ taskId: id, costUsd: z.number().finite().nonnegative() }).strict(),
  revocation: z.object({ reason: z.string().trim().min(1).max(1000), kind: z.enum(["identity_incident", "superseded"]), actorId: id, revokedAt: z.iso.datetime() }).strict().optional(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict();
export const renderViewSnapshotSchema = z.object({
  schemaVersion: z.literal(1), view: preparedProductViewSchema,
  sourceAssetIds: z.array(id).min(1), admittedAt: z.iso.datetime(), snapshotFingerprint: hash,
}).strict();
export const prepareViewRequestSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(128), variantId: id.nullable().default(null),
  expectedProductRevision: z.iso.datetime(), preset: z.enum(["front", "three_quarter", "top"]),
}).strict();
export const retryPreparedViewMatteRequestSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(128),
  expectedRevision: z.number().int().positive(),
  expectedProductRevision: z.iso.datetime(),
}).strict();
export const reviewPreparedViewRequestSchema = z.object({
  expectedRevision: z.number().int().positive(), decision: z.enum(["approved", "rejected", "needs_review"]),
  criteria: preparedViewCriteriaSchema, coverage: preparedViewCoverageSchema.nullable(),
  estimatedOrientation: preparedViewOrientationSchema.nullable(),
  physicalHeightSegment: z.object({ bottom: point, top: point }).strict().refine(v => v.bottom.y > v.top.y).nullable(),
  limits: z.array(z.string().trim().min(1).max(1000)).max(30),
  unknownFaces: z.array(z.string().trim().min(1).max(200)).max(12),
}).strict();
export const revokePreparedViewRequestSchema = z.object({
  expectedRevision: z.number().int().positive(), reason: z.string().trim().min(1).max(1000),
  kind: z.enum(["identity_incident", "superseded"]),
}).strict();
export type PreparedProductView = z.infer<typeof preparedProductViewSchema>;
export type PreparedViewReview = z.infer<typeof preparedViewReviewSchema>;
export type RenderViewSnapshot = z.infer<typeof renderViewSnapshotSchema>;
export type PreparedViewOrientation = z.infer<typeof preparedViewOrientationSchema>;
export type PreparedViewCoverage = z.infer<typeof preparedViewCoverageSchema>;
export type PrepareViewRequest = z.infer<typeof prepareViewRequestSchema>;
