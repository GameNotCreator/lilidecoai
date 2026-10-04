import { manualPlacementSchema, normalizedPointSchema, renderRequestSchema } from "@lili/types";
import { z } from "zod";

const point = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});
const draftSchema = z
  .object({
    version: z.literal(1),
    savedAt: z.number().finite(),
    productIds: z.array(z.string().uuid()).min(1).max(3),
    sceneId: z.string().uuid(),
    points: z.array(point.nullable()).min(1).max(3),
    manualPlacements: z.array(manualPlacementSchema.nullable()).min(1).max(3).optional(),
    planeCorners: z.array(z.array(normalizedPointSchema).max(4)).min(1).max(3).optional(),
    referenceBase: point.nullable(),
    referenceTop: point.nullable(),
    referenceHeight: z.string().max(20),
    sameDepth: z.boolean(),
    referenceReady: z.boolean(),
    useMeasurement: z.boolean(),
    replaceExisting: z.boolean().default(false),
    visualWidths: z.array(z.number().min(0.02).max(0.75).nullable()).min(1).max(3).optional(),
    replacementRegion: z.object({
      xMin: z.number().min(0).max(1), yMin: z.number().min(0).max(1),
      xMax: z.number().min(0).max(1), yMax: z.number().min(0).max(1),
    }).refine((box) => box.xMax > box.xMin && box.yMax > box.yMin &&
      (box.xMax - box.xMin) * (box.yMax - box.yMin) <= 0.5).nullable().optional(),
    replacementConfirmed: z.boolean().optional(),
    renderId: z.string().uuid().optional(),
    pendingBody: z.string().max(40_000).optional(),
  })
  .superRefine((draft, context) => {
    if (draft.points.length !== draft.productIds.length)
      context.addIssue({ code: "custom", message: "Sélection incohérente." });
    if (draft.visualWidths && draft.visualWidths.length !== draft.productIds.length)
      context.addIssue({ code: "custom", message: "Tailles incohérentes." });
    if (draft.manualPlacements && draft.manualPlacements.length !== draft.productIds.length)
      context.addIssue({ code: "custom", message: "Placements incohérents." });
    if (draft.planeCorners && draft.planeCorners.length !== draft.productIds.length)
      context.addIssue({ code: "custom", message: "Plans incohérents." });
    if (draft.replacementConfirmed && (!draft.replaceExisting || (!draft.manualPlacements && draft.productIds.length !== 1) || !draft.replacementRegion))
      context.addIssue({ code: "custom", message: "Zone de remplacement incohérente." });
    if (!draft.pendingBody) return;
    try {
      const request = renderRequestSchema.parse(JSON.parse(draft.pendingBody));
      if (
        draft.renderId ||
        request.workflow !== "simple_point" ||
        !request.idempotencyKey ||
        request.placement.sceneId !== draft.sceneId ||
        request.simplePlacements?.map((item) => item.productId).join(",") !==
          draft.productIds.join(",")
      )
        throw new Error("Mismatched pending request");
    } catch {
      context.addIssue({
        code: "custom",
        message: "Demande enregistrée incohérente.",
      });
    }
  });

export type StorefrontVisualizationDraft = z.infer<typeof draftSchema>;
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export const storefrontDraftKey = (productIds: string[]) =>
  `lili:storefront-visualization:v1:${productIds.join(",")}`;
const lifetime = 24 * 60 * 60 * 1000;

/** Tab-local IDs and placements only; images, tokens and statuses stay on the server. */
export function readStorefrontDraft(
  storage: DraftStorage,
  productIds: string[],
  now = Date.now(),
): StorefrontVisualizationDraft | null {
  try {
    const raw = storage.getItem(storefrontDraftKey(productIds));
    if (!raw) return null;
    const parsed = draftSchema.safeParse(JSON.parse(raw));
    if (
      !parsed.success ||
      parsed.data.productIds.join(",") !== productIds.join(",") ||
      parsed.data.savedAt > now ||
      now - parsed.data.savedAt > lifetime
    ) {
      storage.removeItem(storefrontDraftKey(productIds));
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

export function saveStorefrontDraft(
  storage: DraftStorage,
  draft: StorefrontVisualizationDraft,
): boolean {
  try {
    const parsed = draftSchema.parse(draft);
    storage.setItem(
      storefrontDraftKey(parsed.productIds),
      JSON.stringify(parsed),
    );
    return true;
  } catch {
    return false;
  }
}
