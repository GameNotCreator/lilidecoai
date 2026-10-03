import "server-only";
import type { Db } from "mongodb";
import { preparedCollections } from "./prepared-views";

/** Keep forensic sources while an identity incident or provider outcome is unresolved. */
export async function assetRequiredByPreparedWork(db: Db, assetId: string): Promise<boolean> {
  const c = preparedCollections(db);
  const task = await c.tasks.findOne({
    $and: [
      { $or: [{ state: { $in: ["queued", "preparing", "needs_review", "unknown"] } },
        { state: "failed", failureStage: "matte", "checkpoint.rawStored": true, retiredAssetsExpireAt: { $exists: false } }] },
      { $or: [{ "sources.assetId": assetId }, { sourceAssetId: assetId },
        { "checkpoint.rawAssetId": assetId }, { "checkpoint.imageAssetId": assetId }, { "checkpoint.alphaAssetId": assetId }, { stagedAssetIds: assetId }] },
    ],
  });
  if (task) return true;
  const view = await c.views.findOne({
    $and: [
      { $or: [{ state: { $in: ["queued", "preparing", "needs_review", "approved"] } },
        { state: "revoked", "revocation.kind": "identity_incident" }] },
      { $or: [{ "sources.assetId": assetId }, { "image.assetId": assetId }, { "alpha.assetId": assetId },
        { "review.evidenceAssetIds": assetId }] },
    ],
  });
  return Boolean(view);
}

/** Retiring a catalogue entry closes its reusable library. Bounded pins on
 * active render sources still protect work already admitted. */
export async function retirePreparedProduct(db: Db, organizationId: string, productId: string, expiresAt: Date) {
  const c = preparedCollections(db);
  const views = await c.views.find({ organizationId, productId }).toArray();
  const tasks = await c.tasks.find({ organizationId, productId }).toArray();
  const ids = [...new Set([
    ...views.flatMap(view => [view.image?.assetId, view.alpha?.assetId]),
    ...tasks.flatMap(task => [task.checkpoint?.rawAssetId, task.checkpoint?.imageAssetId, task.checkpoint?.alphaAssetId, ...(task.stagedAssetIds ?? [])]),
  ].filter((id): id is string => !!id))];
  // A provider callback can settle concurrently. CAS its exact observed state
  // instead of turning a sent/unknown paid intention into an ordinary failure.
  for (const initial of tasks) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const task = await c.tasks.findOne({ organizationId, productId, id: initial.id });
      if (!task || (!["queued", "preparing", "needs_review", "unknown"].includes(task.state) &&
          !(task.state === "failed" && task.failureStage === "matte"))) break;
      const providerState = task.provider?.state;
      const unknown = task.state === "unknown" || providerState === "sent" || providerState === "unknown";
      const retired = await c.tasks.updateOne({ organizationId, productId, id: task.id, state: task.state,
        "provider.state": providerState ?? { $exists: false } }, {
        $set: { state: unknown ? "unknown" : "failed", retiredAssetsExpireAt: expiresAt,
          ...(providerState === "sent" ? { "provider.state": "unknown" } : {}),
          failure: "Produit archivé ou supprimé. Aucune nouvelle génération ni publication.", updatedAt: new Date() },
        $unset: { lease: "" },
      });
      if (retired.matchedCount) break;
      if (attempt === 5) throw new Error("La préparation change pendant l’archivage. Réessayez l’archivage.");
    }
  }
  await c.views.updateMany({ organizationId, productId, state: { $in: ["queued", "preparing", "approved", "needs_review", "rejected"] } }, {
    $set: { state: "stale", updatedAt: new Date().toISOString() }, $inc: { revision: 1 }, $unset: { preparationLeaseToken: "" },
  });
  if (ids.length) {
    await db.collection("assets").updateMany({ organizationId, id: { $in: ids } }, { $set: { visibility: "private" } });
    await db.collection("assets").updateMany({ organizationId, id: { $in: ids }, expiresAt: { $exists: false } }, { $set: { expiresAt } });
  }
}
