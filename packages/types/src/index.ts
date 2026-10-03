import { z } from "zod";
import { renderEngineSchema, renderEvidenceSchema, spatialProductMetadataSchema, spatialReferenceSchema } from "./spatial";
export * from "./spatial";
export * from "./oriented";

export const placementModeSchema = z.enum(["quick", "wall", "surface"]);
export const renderModeSchema = z.enum(["insert", "replace"]);
export const outputQualitySchema = z.enum(["preview", "final"]);
export const surfaceTypeSchema = z.enum([
  "tabletop",
  "shelf",
  "niche",
  "wall",
  "floor",
  "rug_zone",
  "ceiling",
  "existing_object",
]);
export const productViewTypeSchema = z.enum([
  "top",
  "front",
  "three_quarter",
  "side",
  "back",
  "detail",
]);
export const pipelineStateSchema = z.enum([
  "uploaded",
  "analyzing_scene",
  "segmenting_target",
  "awaiting_mask_confirmation",
  "computing_geometry",
  "removing_target",
  "building_prompt",
  "generating_preview",
  "generating_final",
  "quality_check",
  "retrying",
  "completed",
  "failed",
  "refunded",
]);
export const normalizedPointSchema = z.object({
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
});
/** A customer-supplied height visible on the same support/depth as the product. */
export const storefrontScaleReferenceSchema = z.object({
  realHeightCm: z.number().finite().min(2).max(300),
  basePoint: normalizedPointSchema,
  topPoint: normalizedPointSchema,
  sameDepthConfirmed: z.literal(true),
}).strict();
export type StorefrontScaleReference = z.infer<typeof storefrontScaleReferenceSchema>;
const dimensionValueCmSchema = z.number().finite().positive().max(1_500);
const dimensionReferenceSchema = z.object({
  axis: z.enum(["width", "height"]),
  valueCm: dimensionValueCmSchema,
});
export const dimensionPairSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("height_length"),
    heightCm: dimensionValueCmSchema,
    lengthCm: dimensionValueCmSchema,
  }),
  z.object({
    mode: z.literal("length_width"),
    lengthCm: dimensionValueCmSchema,
    widthCm: dimensionValueCmSchema,
  }),
]);
export const simplePlacementKindSchema = z.enum(["standing", "wall", "flat"]);
export const simplePlacementSchema = z
  .object({
    productId: z.string().uuid(),
    placementPoint: normalizedPointSchema,
    dimensionPair: dimensionPairSchema.optional(),
    dimensionReference: dimensionReferenceSchema.optional(),
    /** How the object meets the room: on a support, on the wall, or flat. */
    placementKind: simplePlacementKindSchema.optional(),
    /**
     * Client-confirmed scale at the point (pixels per centimetre on the
     * support). Wins over the vision estimate; validated server-side.
     */
    pixelsPerCm: z.number().finite().min(0.2).max(200).optional(),
  })
  .refine((value) => value.dimensionPair || value.dimensionReference, {
    message: "Indiquez deux dimensions pour cet objet.",
    path: ["dimensionPair"],
  });
export const dimensionsCmSchema = z.object({
  width: z.number().finite().positive().max(1_500),
  height: z.number().finite().positive().max(1_500),
  depth: z.number().finite().nonnegative().max(1_500),
  unit: z.literal("cm").default("cm"),
});
export const lightingSchema = z
  .object({
    mode: z.enum(["automatic", "manual"]).default("automatic"),
    direction: z.string().trim().max(40).optional(),
    intensity: z.number().finite().min(0).max(1).optional(),
    colorTemperature: z.enum(["warm", "neutral", "cool"]).optional(),
    softness: z.number().finite().min(0).max(1).optional(),
    timeOfDay: z.string().trim().max(40).optional(),
  })
  .default({ mode: "automatic" });
export const calibrationInputSchema = z
  .object({
    realLength: z.number().finite().positive().max(10_000).optional(),
    unit: z.literal("cm").default("cm"),
    referencePoints: z.array(normalizedPointSchema).length(2).optional(),
    supportPolygon: z.array(normalizedPointSchema).min(3).max(12).optional(),
    source: z
      .enum(["manual", "estimated_depth", "ar_scan"])
      .default("estimated_depth"),
  })
  .optional();

const legacySurfaceSchema = z.enum([
  "table",
  "nightstand",
  "shelf",
  "niche",
  "wall",
  "floor",
]);

export const renderRequestSchema = z
  .object({
    engine: renderEngineSchema.optional(),
    orientedVariantId: z.string().min(1).max(160).nullable().optional(),
    orientedYawDegrees: z.number().finite().min(-180).max(180).optional(),
    orientedPlanFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    spatialReference: spatialReferenceSchema.optional(),
    scaleReference: storefrontScaleReferenceSchema.optional(),
    replaceExisting: z.boolean().optional(),
    workflow: z.enum(["standard", "simple_point"]).default("standard"),
    mode: renderModeSchema.default("insert"),
    placement: z.object({
      sceneId: z.string().uuid(),
      productId: z.string().uuid(),
      calibrationId: z.string().uuid().optional(),
      mode: z.string().trim().max(30).optional(),
      surfaceType: surfaceTypeSchema.or(legacySurfaceSchema).optional(),
      xNormalized: z.number().finite().min(0).max(1).optional(),
      yNormalized: z.number().finite().min(0).max(1).optional(),
      scale: z.number().finite().min(0.04).max(0.75).optional(),
      rotationDegrees: z.number().finite().min(-180).max(180).optional(),
      lighting: z.record(z.string(), z.unknown()).optional(),
    }),
    placementPoint: normalizedPointSchema.optional(),
    simplePlacements: z.array(simplePlacementSchema).min(1).max(3).optional(),
    targetPoint: normalizedPointSchema.optional(),
    targetMaskId: z.string().uuid().optional(),
    surfaceType: surfaceTypeSchema.or(legacySurfaceSchema).optional(),
    dimensionsCm: dimensionsCmSchema.optional(),
    anchorType: z.string().trim().max(50).default("bottom_center"),
    material: z.string().trim().max(160).optional(),
    lighting: lightingSchema,
    calibration: calibrationInputSchema,
    outputQuality: outputQualitySchema.default("final"),
    preserveBackground: z.boolean().default(true),
    userInstructions: z.string().trim().max(1_500).default(""),
    dimensionReference: dimensionReferenceSchema.optional(),
    idempotencyKey: z.string().trim().min(1).max(160),
    quality: z.enum(["low", "medium", "high"]).optional(),
  })
  .superRefine((value, context) => {
    const point =
      value.placementPoint ??
      (typeof value.placement.xNormalized === "number" &&
      typeof value.placement.yNormalized === "number"
        ? {
            x: value.placement.xNormalized,
            y: value.placement.yNormalized,
          }
        : undefined);
    if (!point) {
      context.addIssue({
        code: "custom",
        message: "Touchez la photo pour choisir un emplacement.",
        path: ["placementPoint"],
      });
    }
    if (
      value.workflow === "simple_point" &&
      !value.dimensionReference &&
      !value.simplePlacements
    ) {
      context.addIssue({
        code: "custom",
        message: "Indiquez les objets, leurs points et leurs dimensions.",
        path: ["simplePlacements"],
      });
    }
    if (value.mode === "replace" && value.workflow !== "simple_point") {
      if (!value.targetPoint) {
        context.addIssue({
          code: "custom",
          message: "Sélectionnez l’élément présent dans la zone.",
          path: ["targetPoint"],
        });
      }
      if (!value.targetMaskId) {
        context.addIssue({
          code: "custom",
          message: "Confirmez la zone sélectionnée avant de lancer le rendu.",
          path: ["targetMaskId"],
        });
      }
    }
  });

export const sceneAnalysisRequestSchema = z.object({
  placementPoint: normalizedPointSchema.default({ x: 0.5, y: 0.65 }),
  surfaceType: surfaceTypeSchema.default("floor"),
  dimensionsCm: dimensionsCmSchema.default({
    width: 50,
    height: 50,
    depth: 50,
    unit: "cm",
  }),
  calibration: calibrationInputSchema,
});

export const segmentationRequestSchema = z.object({
  point: normalizedPointSchema,
  positivePoints: z.array(normalizedPointSchema).max(20).default([]),
  negativePoints: z.array(normalizedPointSchema).max(20).default([]),
});
export const placementTypeSchema = z.enum([
  "table",
  "nightstand",
  "shelf",
  "niche",
  "wall",
  "floor",
]);
export const objectTypeSchema = z.enum([
  "vase",
  "lamp",
  "frame",
  "mirror",
  "rug",
  "furniture",
  "plant",
  "clock",
  "other",
]);
export const renderStatusSchema = z.enum([
  "queued",
  "processing",
  "succeeded",
  "failed",
  "cancelled",
  "deleted",
]);

export const productVariantSchema = z.object({
  id: z.string(),
  label: z.string(),
  sku: z.string().nullable().default(null),
  widthCm: z.coerce.number().nullable().default(null),
  heightCm: z.coerce.number().nullable().default(null),
  depthCm: z.coerce.number().nullable().default(null),
  priceCents: z.coerce.number().int().nullable().default(null),
  stock: z.coerce.number().int().nullable().default(null),
  available: z.boolean().default(true),
});

/** Measurements taken on the stored cutout during /prepare. */
export const cutoutMetadataSchema = z.object({
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
  /** Row (fraction of height, (0,1]) where the object touches its support. */
  baseRowFraction: z.number().min(0.05).max(1).default(1),
  source: z.enum(["heuristic", "model", "matting"]).default("heuristic"),
  /** True when a generative model re-rendered the product (not a matte). */
  synthetic: z.boolean().default(false),
  shadowRemoved: z.boolean().default(false),
  warnings: z.array(z.string()).default([]),
  /**
   * Version of the matte that produced this cutout. Its ABSENCE is what marks
   * a cutout as untrusted: a provenance gate written as a denylist over
   * `synthetic` would read a cutout with no metadata at all as trustworthy,
   * which is the opposite of the truth (PRO-008).
   */
  cutoutVersion: z.string().optional(),
  /**
   * Why the matte is doubted, when it is. Recorded on every prepare so a
   * corpus run can measure how often each cause fires before any refusal is
   * enforced on it.
   */
  verdict: z
    .object({
      usable: z.boolean(),
      code: z.string(),
      detail: z.string(),
    })
    .optional(),
});

export const productSchema = z.object({
  spatialMetadata: spatialProductMetadataSchema.optional(),
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().default(""),
  objectType: objectTypeSchema.default("other"),
  widthCm: z.coerce.number().positive(),
  heightCm: z.coerce.number().positive(),
  depthCm: z.coerce.number().nonnegative(),
  material: z.string(),
  placementType: placementTypeSchema,
  generationInstructions: z.string().default(""),
  sku: z.string().nullable().optional(),
  lightingProfile: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(["draft", "processing", "ready", "archived"]),
  buyUrl: z.string().nullable().optional(),
  brand: z.string().default(""),
  collection: z.string().default(""),
  tags: z.array(z.string()).default([]),
  priceCents: z.coerce.number().int().nullable().default(null),
  currency: z.string().default("TND"),
  stock: z.coerce.number().int().nullable().default(null),
  weightKg: z.coerce.number().nullable().default(null),
  variants: z.array(productVariantSchema).default([]),
  imageSourceUrl: z.string().url().optional(),
  imageCredit: z.string().optional(),
  assetUrl: z.string().nullable().optional(),
  cutoutUrl: z.string().nullable().optional(),
  cutout: cutoutMetadataSchema.optional(),
  views: z
    .array(
      z.object({
        id: z.string(),
        assetId: z.string(),
        type: productViewTypeSchema,
        widthPx: z.number().nonnegative(),
        heightPx: z.number().nonnegative(),
        validationStatus: z.enum(["pending", "valid", "rejected"]),
        url: z.string().nullable().optional(),
      }),
    )
    .default([]),
});

export const qualityDecisionSchema = z.object({
  version: z.string(),
  status: z.enum(["accepted", "rejected", "unavailable", "simulated"]),
  score: z.number().finite().min(0).max(1).nullable(),
  feedback: z.string(),
  checks: z.array(
    z.object({
      name: z.string(),
      score: z.number().finite().min(0).max(1),
      reason: z.string(),
    }),
  ),
});
export type QualityDecision = z.infer<typeof qualityDecisionSchema>;

export const renderSchema = z.object({
  engine: renderEngineSchema.optional(),
  spatialEvidence: renderEvidenceSchema.optional(),
  orientedEvidence: z.object({
    version: z.literal("oriented-v1"), selectedViewId: z.string(), snapshotFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    origin: z.enum(["photographed", "generated"]), metricVerified: z.literal(false), limitations: z.array(z.string()), plan: z.unknown(), checks: z.unknown().optional(),
  }).optional(),
  id: z.string().uuid(),
  status: renderStatusSchema,
  provider: z.string().nullable(),
  model: z.string().nullable(),
  requestedSize: z.string(),
  resultUrl: z.string().nullable(),
  /** Deterministic composite (before harmonization), when stored. */
  compositeUrl: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  qualityScore: z.coerce.number().nullable(),
  qualityDecision: qualityDecisionSchema.optional(),
  creditCharged: z.boolean(),
  placement: z.record(z.string(), z.unknown()).optional(),
  mode: renderModeSchema.optional(),
  outputQuality: outputQualitySchema.optional(),
  pipelineState: pipelineStateSchema.optional(),
  execution: z.object({
    version: z.string(), deadlineAt: z.string(), attempts: z.number(),
    retrying: z.boolean(), errorCode: z.string().optional(),
  }).optional(),
  surfaceType: surfaceTypeSchema.or(z.string()).optional(),
  placementPoint: z.object({ x: z.number(), y: z.number() }).optional(),
  targetPoint: z.object({ x: z.number(), y: z.number() }).optional(),
  targetMaskUrl: z.string().nullable().optional(),
  promptVersion: z.string().optional(),
  /** Resolved engine baseline; see RenderDocument.engineVersions. */
  engineVersions: z
    .object({
      placementGeometry: z.string(),
      composite: z.string(),
      scaleEstimation: z.string(),
      quality: z.string(),
      prompt: z.string(),
      mockMode: z.boolean(),
      imageQuality: z.string(),
      editModel: z.string(),
      repairImageModel: z.string().optional(),
      visionModel: z.string(),
    })
    .optional(),
  /** Intermediate images kept when stage capture is on, by stage name. */
  stages: z.record(z.string(), z.string()).optional(),
  /** Per-stage provenance of a simple_point render. */
  audit: z
    .object({
      scaleSources: z.array(z.string()),
      scaleFallbackFired: z.boolean(),
      cutoutSources: z.array(z.string()),
      cutoutWarnings: z.array(z.string()),
      obstaclesRemoved: z.number().int().nonnegative(),
      obstaclesSkipped: z.number().int().nonnegative(),
    })
    .optional(),
  attemptCount: z.number().int().nonnegative().optional(),
  estimatedCostUsd: z.number().nonnegative().optional(),
  degradedMode: z.boolean().optional(),
  qualityChecks: z
    .array(
      z.object({ name: z.string(), score: z.number(), reason: z.string() }),
    )
    .optional(),
  createdAt: z.string(),
});

export type Product = z.infer<typeof productSchema>;
export type ProductVariant = z.infer<typeof productVariantSchema>;
export type Render = z.infer<typeof renderSchema>;
export type PlacementMode = z.infer<typeof placementModeSchema>;
export type RenderMode = z.infer<typeof renderModeSchema>;
export type OutputQuality = z.infer<typeof outputQualitySchema>;
export type SurfaceType = z.infer<typeof surfaceTypeSchema>;
export type DimensionPair = z.infer<typeof dimensionPairSchema>;
export type SimplePlacementKind = z.infer<typeof simplePlacementKindSchema>;
export type CutoutMetadata = z.infer<typeof cutoutMetadataSchema>;
export type ProductViewType = z.infer<typeof productViewTypeSchema>;
export type RenderRequest = z.infer<typeof renderRequestSchema>;
export type PlacementType = z.infer<typeof placementTypeSchema>;
export type ObjectType = z.infer<typeof objectTypeSchema>;

export type AnalyticsEventName =
  | "visualizer_opened"
  | "room_uploaded"
  | "surface_selected"
  | "calibration_started"
  | "calibration_completed"
  | "placement_adjusted"
  | "render_requested"
  | "render_succeeded"
  | "render_failed"
  | "result_downloaded"
  | "result_shared"
  | "add_to_cart_clicked";
