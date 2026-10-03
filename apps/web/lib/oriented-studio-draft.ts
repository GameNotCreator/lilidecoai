import { z } from "zod";
const assetUrl = z.string().regex(/^\/api\/assets\/[a-zA-Z0-9-]{1,160}$/);
const preview = z.object({
  previewUrl: assetUrl,
  planFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  reconstructed: z.boolean(),
  limitations: z.array(z.string()).max(30),
  unknownFaces: z.array(z.string()).max(12),
});
export const orientedStudioDraftSchema = z.object({
  productId: z.string().max(160),
  variantId: z.string().max(160),
  scene: z
    .object({
      id: z.string().uuid(),
      imageUrl: assetUrl,
      expiresAt: z.iso.datetime(),
    })
    .nullable(),
  point: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
  surfaceType: z.enum(["floor", "tabletop", "shelf"]),
  preview: preview.nullable(),
  requestKey: z.string().max(160),
  job: z
    .object({
      id: z.string().uuid(),
      status: z.enum([
        "queued",
        "processing",
        "succeeded",
        "failed",
        "cancelled",
        "deleted",
      ]),
      pipelineState: z.string().optional(),
      resultUrl: assetUrl.nullable().optional(),
      compositeUrl: assetUrl.nullable().optional(),
      error: z.string().nullable().optional(),
      qualityDecision: z.object({ feedback: z.string() }).nullable().optional(),
      execution: z.object({ errorCode: z.string().optional() }).optional(),
    })
    .nullable(),
});
