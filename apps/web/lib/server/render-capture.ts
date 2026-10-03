import "server-only";

import type { Db } from "mongodb";

import { deleteAsset, privateVisibility, storeAsset } from "./assets";
import { serverConfig } from "./config";
import { collections } from "./mongodb";
import type { RenderDocument } from "./types";
import { executionFence } from "./durable-context";

/**
 * Keeps the intermediate images a render normally throws away — audit PRO-007,
 * phase 0: "chaque échec se localise entre source, détourage, placement,
 * nettoyage, harmonisation et export".
 *
 * Only two of those six stages survive a normal render: the deterministic
 * composite and, when quality accepts, the delivered image. Everything between
 * them is a local variable — the room after an obstacle was removed, the
 * letterboxed input and mask handed to the model, and the model's own answer
 * before the paste-back. (The marked photo the scale pass saw is built per
 * object inside a loop and is not captured yet.) Without them a
 * reference case can say a render is wrong and not where it went wrong, which
 * is the whole point of the corpus.
 *
 * Off by default. It multiplies what a render stores, and these are the
 * customer's own photos at every stage: turning it on is a deliberate act, for
 * a corpus run or a support investigation, not a production default.
 *
 * Captures inherit the scene's retention like every other render image, so a
 * corpus run must copy what it needs to disk rather than rely on them staying.
 */

export type RenderStage =
  | "scene_cleaned"
  | "model_input"
  | "model_mask"
  | "model_output"
  | "hybrid_rejected"
  | "hybrid_repair_output"
  | "hybrid_pose_output"
  | "hybrid_room_refinement_output"
  | "hybrid_room_refinement_guide"
  | "final_rejected";

export function stageCaptureEnabled(): boolean {
  return serverConfig.renderStageCapture;
}

/**
 * Stores one intermediate image and records it on the render.
 *
 * Never throws: losing a diagnostic must not fail the render it documents. A
 * failure is logged, and the missing stage is visible as a gap in `stages`.
 */
export async function captureStage(
  db: Db,
  render: Pick<RenderDocument, "id" | "organizationId" | "publicSessionId">,
  stage: RenderStage,
  // A producer, so that any re-encoding a call site needs runs only when
  // capture is on and inside the try: with capture off it costs nothing, and
  // with it on a failing encode cannot escape the never-throws guarantee.
  image: Buffer | (() => Promise<Buffer>),
  contentType: "image/webp" | "image/png",
  expiresAt?: Date,
): Promise<void> {
  if (!stageCaptureEnabled()) return;
  try {
    const buffer = typeof image === "function" ? await image() : image;
    const asset = await storeAsset(db, {
      organizationId: render.organizationId,
      kind: "render",
      visibility: privateVisibility(render.publicSessionId),
      buffer,
      contentType,
      ...(expiresAt ? { expiresAt } : {}),
    });
    // Conditional on the render still running: a capture landing after a
    // cancel or delete would attach an image to a render nobody can reach,
    // and that its deletion already cleaned up.
    const attached = await collections(db).renders.updateOne(
      { id: render.id, status: "processing", ...executionFence(render.id) },
      { $set: { [`stages.${stage}`]: asset.id } },
    );
    if (!attached.matchedCount) {
      await deleteAsset(db, asset.id).catch(() => undefined);
    }
  } catch (reason) {
    console.error(`Render stage capture failed (${stage})`, reason);
  }
}
