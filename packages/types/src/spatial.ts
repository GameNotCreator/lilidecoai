import { z } from "zod";
export const SPATIAL_SUPPORT_LIMITS = {
  holes: 12,
  obstacles: 30,
  evidence: 800,
} as const;

const point = z
  .object({ x: z.number().finite(), y: z.number().finite() })
  .strict();
const vector = point.extend({ z: z.number().finite() });
const unit = z.number().min(0).max(1);
const normalized = z.object({ x: unit, y: unit }).strict();
const dimension = z.number().positive().max(2000);
export const planarTextureInputSchema = z
  .object({
    assetId: z.string().min(1).max(160),
    corners: z.tuple([normalized, normalized, normalized, normalized]).refine(
      (points) =>
        points.every((a, i) => {
          const b = points[(i + 1) % 4]!,
            c = points[(i + 2) % 4]!;
          return (
            (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) > 0.00001
          );
        }),
      "Choisissez quatre coins distincts dans l’ordre indiqué, sans croiser les côtés.",
    ),
  })
  .strict();
export const planarTextureSchema = planarTextureInputSchema
  .extend({
    version: z.literal(1),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    widthPx: z.number().int().positive(),
    heightPx: z.number().int().positive(),
    productWidthCm: dimension,
    productDepthCm: dimension,
    confirmedAt: z.string().datetime(),
  })
  .strict();
export type PlanarTexture = z.infer<typeof planarTextureSchema>;
export const spatialReferenceSchema = z
  .object({
    sceneFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    surfaceId: z.string().min(1).max(80),
    points: z.tuple([normalized, normalized]),
    lengthCm: z.number().finite().positive().max(10000),
  })
  .strict();
export type SpatialReference = z.infer<typeof spatialReferenceSchema>;
export const spatialCalibrationSchema = z.enum([
  "approximate",
  "reference_scaled",
]);
export const spatialPreviewRequestSchema = z
  .object({
    productId: z.string().uuid(),
    point: normalized,
    surfaceType: z.enum(["floor", "table", "tabletop", "nightstand", "shelf"]),
    yawDegrees: z.number().finite().min(-180).max(180).optional(),
    reference: spatialReferenceSchema.optional(),
  })
  .strict();
export const spatialPreviewSchema = z.object({
  sceneFingerprint: z.string(),
  surfaceId: z.string(),
  calibration: spatialCalibrationSchema,
  corners: z.array(point).length(8),
  fits: z.boolean(),
  supportFits: z.boolean(),
  assumptions: z.array(z.string()),
});
export type SpatialPreview = z.infer<typeof spatialPreviewSchema>;
export const renderEngineSchema = z.enum(["legacy", "spatial"]);
export const spatialProductMetadataSchema = z
  .object({
    measurementConvention: z.string().trim().min(1).max(500),
    dimensionSource: z.enum(["catalog", "measured", "estimated"]),
    supports: z
      .array(z.enum(["floor", "table", "shelf", "wall"]))
      .min(1)
      .max(4),
    characteristicParts: z.array(z.string().trim().min(1).max(150)).max(30),
    contactProfile: z.literal("solid-base").optional(),
    volumeFamily: z.enum(["basket", "vase"]).optional(),
  })
  .strict();
export const productGeometrySchema = z
  .object({
    planarTexture: planarTextureSchema.optional(),
    version: z.literal(1),
    fingerprint: z.string().min(1),
    productId: z.string().min(1),
    dimensions: z
      .object({
        widthCm: dimension,
        heightCm: dimension,
        depthCm: dimension,
        unit: z.literal("cm"),
      })
      .strict(),
    measurementConvention: z.string().min(1).max(500),
    dimensionSource: z.enum(["catalog", "measured", "estimated"]),
    shape: z.enum(["plane", "volume"]),
    contactProfile: z.literal("solid-base").optional(),
    volumeFamily: z.enum(["basket", "vase"]).optional(),
    supports: z.array(z.enum(["floor", "table", "shelf", "wall"])).min(1),
    characteristicParts: z.array(z.string().min(1).max(150)).max(30),
    references: z
      .array(
        z
          .object({
            assetId: z.string().min(1),
            view: z.string().min(1),
            supplied: z.literal(true),
          })
          .strict(),
      )
      .min(1),
    limitations: z.array(z.string().max(500)),
  })
  .strict();
export const sceneGeometrySchema = z
  .object({
    version: z.literal(1),
    fingerprint: z.string().min(1),
    camera: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        focalPx: z.number().positive(),
        heightAboveSupportCm: z.number().finite(),
        pitchDownDegrees: z.number().min(-80).max(80),
      })
      .strict(),
    transform: z
      .object({
        offsetX: z.number().nonnegative(),
        offsetY: z.number().nonnegative(),
        paddedWidth: z.number().positive(),
        paddedHeight: z.number().positive(),
      })
      .strict(),
    support: z.string().min(1),
    supportBoundary: z.array(normalized).min(3).max(16),
    supportHoles: z
      .array(z.array(normalized).min(3).max(16))
      .max(SPATIAL_SUPPORT_LIMITS.holes + SPATIAL_SUPPORT_LIMITS.obstacles),
    observations: z.array(z.string()),
    calibration: spatialCalibrationSchema,
    reference: spatialReferenceSchema.optional(),
    cameraUncertainty: z
      .object({
        source: z.literal("model_estimate_not_statistical"),
        focalLengthInImageWidths: z.tuple([
          z.number().finite(),
          z.number().finite(),
        ]),
        pitchDownDegrees: z.tuple([z.number().finite(), z.number().finite()]),
        heightAboveSupportCm: z.tuple([
          z.number().finite(),
          z.number().finite(),
        ]),
      })
      .strict()
      .optional(),
  })
  .strict();
export const placementPlanSchema = z
  .object({
    version: z.literal(1),
    productFingerprint: z.string().min(1),
    sceneFingerprint: z.string().min(1),
    contact: normalized,
    origin: vector,
    yawDegrees: z.number().min(-180).max(180),
    projectedCorners: z.array(point).length(8),
    calibration: spatialCalibrationSchema,
    assumptions: z.array(z.string()),
    interactionPolicy: z.enum([
      "experimental-local-region",
      "volume-and-contact-v1",
      "plane-and-contact-v1",
    ]),
    reviewGeometry: z
      .enum(["volume-envelope-contact-v1", "projected-silhouette-v1"])
      .optional(),
    backgroundBoundaryPolicy: z.literal("spatial-boundary-v1").optional(),
    reviewExecutionPolicy: z.literal("spatial-review-execution-v1").optional(),
    volumeIntegrationPolicy: z
      .literal("spatial-volume-local-matte-v1")
      .optional(),
    volumeRepairPolicy: z
      .literal("spatial-volume-numeric-repair-v1")
      .optional(),
    interactionMask: z
      .object({
        objectMarginPx: z.number().nonnegative(),
        contactFeatherPx: z.number().int().min(2).max(8).optional(),
        contactMarginPx: z.number().positive(),
        objectPixels: z.number().int().positive(),
        contactPixels: z.number().int().nonnegative(),
        limitation: z.string(),
      })
      .strict()
      .optional(),
    planarTexture: z
      .object({
        version: z.enum(["planar-texture-v1", "planar-texture-v2"]),
        filtering: z.literal("source-area-v1").optional(),
        filteredPixels: z.number().int().nonnegative().optional(),
        sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        sourceCorners: z.array(point).length(4),
        targetCorners: z.array(point).length(4),
        lightingPolicy: z.enum([
          "planar-neutral-light-v1",
          "planar-neutral-light-v2",
        ]),
        limitations: z.array(z.string()),
      })
      .strict()
      .optional(),
  })
  .strict();
export const renderEvidenceSchema = z
  .object({
    version: z.literal(1),
    engine: z.enum([
      "spatial-v1",
      "spatial-v2",
      "spatial-v3",
      "spatial-v4",
      "spatial-v5",
      "spatial-v6",
      "spatial-v7",
      "spatial-v8",
      "spatial-v9",
      "spatial-v10",
      "spatial-v11",
      "spatial-v12",
      "spatial-v13",
    ]),
    product: productGeometrySchema,
    scene: sceneGeometrySchema,
    plan: placementPlanSchema,
    editModel: z.string().min(1),
    visionModel: z.string().min(1),
    qualification: z.literal("internal-only"),
  })
  .strict();
export type ProductGeometry = z.infer<typeof productGeometrySchema>;
export type SceneGeometry = z.infer<typeof sceneGeometrySchema>;
export type PlacementPlan = z.infer<typeof placementPlanSchema>;
export type RenderEvidence = z.infer<typeof renderEvidenceSchema>;
