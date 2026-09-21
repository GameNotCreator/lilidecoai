import "server-only";

import type { Db, UpdateFilter } from "mongodb";
import { captureCredit, releaseCredit, reserveCredit } from "./credits";
import { collections } from "./mongodb";
import type { RenderDocument } from "./types";
import { serverConfig } from "./config";
import { requireAcceptedQuality } from "./render-quality";
import { executionFence } from "./durable-context";
import { completeDurableRender, endDurableRender } from "./durable-queue";

export class RenderLifecycleError extends Error {
  readonly status = 409;
}

/**
 * One credit, held from the moment the render becomes billable until it is
 * delivered or abandoned. Keyed on the render document, so a replay of the
 * same render never holds twice, and a retry — which is a new document — is
 * a new hold.
 */
/**
 * How long a finalization claim is believed. The route caps at 300 s
 * (`maxDuration`), so three times that cannot still be running — the claim
 * belongs to a process that died mid-finalization.
 */
export const STALE_CLAIM_MS = 900_000;

export function staleClaimCutoff(now = Date.now()): Date {
  return new Date(now - STALE_CLAIM_MS);
}

export function renderCreditKey(renderId: string): string {
  return `render:${renderId}`;
}

/**
 * Hold a credit before the first paid provider call. Throws `CreditError`
 * when the organization has none left, which is what stops a burst of
 * concurrent renders from spending provider money against one credit.
 */
export async function reserveRenderCredit(
  db: Db,
  render: Pick<RenderDocument, "id" | "organizationId">,
): Promise<void> {
  await reserveCredit(db, render.organizationId, renderCreditKey(render.id));
}

/**
 * Give the held credit back. Called on every path that ends a render without
 * delivering it. Never throws: a render that already failed must not fail
 * again while cleaning up, and a credit that was already captured or never
 * held simply stays as it is.
 */
export async function releaseRenderCredit(
  db: Db,
  render: Pick<RenderDocument, "id" | "organizationId">,
): Promise<boolean> {
  try {
    return await releaseCredit(
      db,
      render.organizationId,
      renderCreditKey(render.id),
    );
  } catch (reason) {
    console.error("Credit release failed", reason);
    return false;
  }
}

export async function advanceRender(
  db: Db,
  id: string,
  update: UpdateFilter<RenderDocument>,
): Promise<void> {
  const result = await collections(db).renders.updateOne(
    { id, status: "processing", finalizationToken: { $exists: false }, ...executionFence(id) },
    update,
  );
  if (!result.matchedCount) {
    throw new RenderLifecycleError(
      "Ce rendu n’est plus en cours de traitement.",
    );
  }
}

/** A single-document claim linearizes cancel/delete against finalization.
 * This is deliberately not a substitute for the planned wallet transaction
 * and durable-worker recovery after process termination.
 */
export async function completeRender(
  db: Db,
  render: RenderDocument,
  update: Partial<RenderDocument>,
): Promise<boolean> {
  if (render.execution) return completeDurableRender(db, render, update);
  if (!update.qualityDecision)
    throw new RenderLifecycleError("Décision qualité manquante.");
  requireAcceptedQuality(update.qualityDecision, serverConfig.aiMockMode);
  const token = crypto.randomUUID();
  const renders = collections(db).renders;
  const claimed = await renders.updateOne(
    {
      id: render.id,
      status: "processing",
      finalizationToken: { $exists: false },
    },
    { $set: { finalizationToken: token, finalizationStartedAt: new Date() } },
  );
  if (!claimed.matchedCount) {
    throw new RenderLifecycleError(
      "Ce rendu a été arrêté ou est déjà finalisé.",
    );
  }
  const creditCharged = await captureCredit(
    db,
    render.organizationId,
    renderCreditKey(render.id),
  );
  const completed = await renders.updateOne(
    { id: render.id, status: "processing", finalizationToken: token },
    {
      $set: {
        ...update,
        status: "succeeded",
        pipelineState: "completed",
        creditCharged,
      },
      $unset: { error: "" },
    },
  );
  if (!completed.matchedCount) {
    throw new RenderLifecycleError(
      "La finalisation du rendu doit être rapprochée.",
    );
  }
  return creditCharged;
}

/**
 * `cancel` and `delete` both end a render that will never be delivered, so
 * both give the held credit back. A render already captured keeps its charge:
 * deleting a delivered image is not a refund, and nothing here pretends it is.
 */
/**
 * Marks renders that no live process can still be working on.
 *
 * The audit's operations gate is that no job stays without a terminal state.
 * `advanceRender` and `completeRender` cover every path a running render
 * takes; a process killed mid-render takes none of them, and its document
 * would stay `processing` for ever — visible to the customer as a render that
 * never ends. The credit is given back by the same sweep in `credits.ts`.
 *
 * This does not resume anything. The attempt is over and is recorded as
 * failed; a durable executor that could continue it is still to be built.
 */
export async function failAbandonedRenders(
  db: Db,
  now = new Date(),
  limit = 200,
): Promise<number> {
  const cutoff = staleClaimCutoff(now.getTime());
  const renders = collections(db).renders;
  const abandoned = await renders
    .find(
      { status: "processing", execution: { $exists: false }, updatedAt: { $lte: cutoff } },
      { projection: { id: 1 } },
    )
    .limit(limit)
    .toArray();
  let failed = 0;
  for (const render of abandoned) {
    const result = await renders.updateOne(
      { id: render.id, status: "processing", updatedAt: { $lte: cutoff } },
      {
        $set: {
          status: "failed",
          pipelineState: "failed",
          error:
            "Le rendu a été interrompu et n’a pas pu être repris. Aucun crédit n’est débité.",
          updatedAt: new Date(),
        },
      },
    );
    if (result.modifiedCount) failed++;
  }
  return failed;
}

export async function stopRender(
  db: Db,
  render: RenderDocument,
  action: "cancel" | "delete",
): Promise<RenderDocument> {
  if (render.execution) {
    const stopped = await endDurableRender(db, render, action === "cancel" ? "cancelled" : "deleted");
    return stopped ?? (await collections(db).renders.findOne({ id: render.id, organizationId: render.organizationId })) ?? render;
  }
  const renders = collections(db).renders;
  // A claim held by a process that died would otherwise last forever, leaving
  // a render nobody can cancel, delete or refund. The claim is honoured only
  // while it could still belong to a live run.
  const unclaimed = {
    $or: [
      { finalizationToken: { $exists: false } },
      { finalizationStartedAt: { $lte: staleClaimCutoff() } },
    ],
  };
  const updated = await renders.findOneAndUpdate(
    {
      id: render.id,
      organizationId: render.organizationId,
      ...(action === "cancel"
        ? {
            status: { $in: ["queued", "processing"] },
            ...unclaimed,
          }
        : {
            $or: [
              { status: { $nin: ["queued", "processing"] } },
              ...unclaimed.$or,
            ],
          }),
    },
    {
      $set:
        action === "cancel"
          ? {
              status: "cancelled",
              pipelineState: "refunded",
              cancelledAt: new Date(),
              updatedAt: new Date(),
            }
          : { status: "deleted", updatedAt: new Date() },
    },
    { returnDocument: "after" },
  );
  if (updated) {
    await releaseRenderCredit(db, render);
    return updated;
  }
  const current = await renders.findOne({
    id: render.id,
    organizationId: render.organizationId,
  });
  if (current && !["queued", "processing"].includes(current.status))
    return current;
  throw new RenderLifecycleError(
    "Le rendu est en cours de finalisation. Réessayez dans un instant.",
  );
}
