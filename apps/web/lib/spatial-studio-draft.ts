import {
  renderRequestSchema,
  spatialReferenceSchema,
  surfaceTypeSchema,
} from "@lili/types";
import { z } from "zod";
import { spatialRetrySubmissionSchema } from "./spatial-retry";

const point = z
  .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
  .strict();
export const spatialInsertionSubmissionSchema = renderRequestSchema.refine(
  (request) =>
    request.engine === "spatial" &&
    request.mode === "insert" &&
    request.outputQuality === "final" &&
    request.workflow === "standard",
  "Seule une insertion spatiale finale peut être reprise.",
);
export const spatialSubmissionSchema = z.union([
  spatialRetrySubmissionSchema,
  spatialInsertionSubmissionSchema,
]);
export type SpatialSubmission = z.infer<typeof spatialSubmissionSchema>;
export const spatialStudioDraftSchema = z
  .object({
    version: z.literal(3),
    savedAt: z.number().finite(),
    sceneId: z.string().uuid(),
    productId: z.string().uuid(),
    surface: surfaceTypeSchema,
    point: point.nullable(),
    yaw: z.number().finite().min(-180).max(180),
    reference: spatialReferenceSchema.optional(),
    instructions: z.string().max(8000),
    renderId: z.string().uuid().optional(),
    pendingRequest: spatialSubmissionSchema.optional(),
  })
  .strict()
  .refine(
    (draft) =>
      !draft.pendingRequest ||
      (!draft.renderId &&
        draft.pendingRequest.placement.sceneId === draft.sceneId &&
        draft.pendingRequest.placement.productId === draft.productId),
    "Demande incohérente avec le brouillon.",
  );
export type SpatialStudioDraft = z.infer<typeof spatialStudioDraftSchema>;
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
export const spatialDraftKey = (scope: string) =>
  `lili:spatial-studio:v1:${scope}`;
const lifetimeMs = 24 * 60 * 60 * 1000;

/** Tab-local identifiers only. Scene URLs and render statuses come from the server. */
export function readSpatialDraft(
  storage: Storage,
  scope: string,
  now = Date.now(),
): SpatialStudioDraft | null {
  try {
    const raw = storage.getItem(spatialDraftKey(scope));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // v1 had only placements; v2 also had pending initial submissions.
    const result = spatialStudioDraftSchema.safeParse(
      (parsed?.version === 1 && !("pendingRequest" in parsed)) ||
        parsed?.version === 2
        ? { ...parsed, version: 3 }
        : parsed,
    );
    if (
      !result.success ||
      result.data.savedAt > now ||
      now - result.data.savedAt > lifetimeMs
    ) {
      clearSpatialDraft(storage, scope);
      return null;
    }
    return result.data;
  } catch {
    clearSpatialDraft(storage, scope);
    return null;
  }
}

export function saveSpatialDraft(
  storage: Storage,
  scope: string,
  draft: unknown,
): boolean {
  try {
    const validated = spatialStudioDraftSchema.parse(draft);
    storage.setItem(spatialDraftKey(scope), JSON.stringify(validated));
    return true;
  } catch {
    return false;
  }
}

export function clearSpatialDraft(storage: Storage, scope: string) {
  try {
    storage.removeItem(spatialDraftKey(scope));
  } catch {
    /* Storage can be disabled. */
  }
}
