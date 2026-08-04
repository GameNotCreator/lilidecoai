import { z } from "zod";

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
    if (value.mode === "replace") {
      if (!value.targetPoint) {
        context.addIssue({
          code: "custom",
          message: "Sélectionnez l’objet à remplacer.",
          path: ["targetPoint"],
        });
      }
      if (!value.targetMaskId) {
        context.addIssue({
          code: "custom",
          message: "Confirmez le masque avant de lancer le remplacement.",
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

export const productSchema = z.object({
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
  imageSourceUrl: z.string().url().optional(),
  imageCredit: z.string().optional(),
  assetUrl: z.string().nullable().optional(),
  cutoutUrl: z.string().nullable().optional(),
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

export const renderSchema = z.object({
  id: z.string().uuid(),
  status: renderStatusSchema,
  provider: z.string().nullable(),
  model: z.string().nullable(),
  requestedSize: z.string(),
  resultUrl: z.string().nullable(),
  error: z.string().nullable().optional(),
  qualityScore: z.coerce.number().nullable(),
  creditCharged: z.boolean(),
  placement: z.record(z.string(), z.unknown()).optional(),
  mode: renderModeSchema.optional(),
  outputQuality: outputQualitySchema.optional(),
  pipelineState: pipelineStateSchema.optional(),
  surfaceType: surfaceTypeSchema.or(z.string()).optional(),
  placementPoint: z.object({ x: z.number(), y: z.number() }).optional(),
  targetPoint: z.object({ x: z.number(), y: z.number() }).optional(),
  targetMaskUrl: z.string().nullable().optional(),
  promptVersion: z.string().optional(),
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
export type Render = z.infer<typeof renderSchema>;
export type PlacementMode = z.infer<typeof placementModeSchema>;
export type RenderMode = z.infer<typeof renderModeSchema>;
export type OutputQuality = z.infer<typeof outputQualitySchema>;
export type SurfaceType = z.infer<typeof surfaceTypeSchema>;
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
