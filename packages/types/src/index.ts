import { z } from "zod";

export const placementModeSchema = z.enum(["quick", "wall", "surface"]);
export const placementTypeSchema = z.enum([
  "table",
  "nightstand",
  "shelf",
  "niche",
  "wall",
  "floor",
]);
export const renderStatusSchema = z.enum([
  "queued",
  "processing",
  "succeeded",
  "failed",
  "deleted",
]);

export const productSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().default(""),
  widthCm: z.coerce.number().positive(),
  heightCm: z.coerce.number().positive(),
  depthCm: z.coerce.number().nonnegative(),
  material: z.string(),
  placementType: placementTypeSchema,
  status: z.enum(["draft", "processing", "ready", "archived"]),
  buyUrl: z.string().nullable().optional(),
  assetUrl: z.string().nullable().optional(),
  cutoutUrl: z.string().nullable().optional(),
});

export const renderSchema = z.object({
  id: z.string().uuid(),
  status: renderStatusSchema,
  provider: z.string().nullable(),
  model: z.string().nullable(),
  requestedSize: z.string(),
  resultUrl: z.string().nullable(),
  qualityScore: z.coerce.number().nullable(),
  creditCharged: z.boolean(),
  createdAt: z.string(),
});

export type Product = z.infer<typeof productSchema>;
export type Render = z.infer<typeof renderSchema>;
export type PlacementMode = z.infer<typeof placementModeSchema>;
export type PlacementType = z.infer<typeof placementTypeSchema>;

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
