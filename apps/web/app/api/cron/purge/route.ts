import { deleteExpiredAsset } from "@/lib/server/assets";
import { releaseStaleHolds } from "@/lib/server/credits";
import { failAbandonedRenders } from "@/lib/server/render-lifecycle";
import { expireDurableRenders } from "@/lib/server/durable-queue";
import { serverConfig } from "@/lib/server/config";
import { collections, database } from "@/lib/server/mongodb";

export const runtime = "nodejs";
export const maxDuration = 300;

const BATCH = 500;

function isAuthorized(request: Request): boolean {
  if (!serverConfig.cronSecret) {
    return process.env.NODE_ENV !== "production";
  }
  return (
    request.headers.get("authorization") === `Bearer ${serverConfig.cronSecret}`
  );
}

/**
 * Physical deletion of what has logically expired.
 *
 * Reads are already refused at expiry (`readAsset`), so this cron decides when
 * the bytes go, not when the promise ends. It reports the backlog it could not
 * reach in this run: a purge that silently truncates at its batch size reads
 * as "everything is deleted" when it is not.
 *
 * There is deliberately no separate pass for derived images. Every image a
 * render or a segmentation stores — composite, mask, result — inherits
 * `scene.expiresAt` at creation, so this single query already covers them. A
 * pass that looked them up through their scene could not work anyway: the
 * `scenes` collection carries a TTL index on `expiresAt` (`mongodb.ts`), so
 * MongoDB removes those rows on its own before such a query could join through
 * them. The derived images that genuinely used to survive forever were a
 * product's, and they are now stamped with an expiry when it is archived.
 */
export async function GET(request: Request): Promise<Response> {
  if (!isAuthorized(request)) {
    return Response.json({ error: "Non autorisé" }, { status: 401 });
  }

  const db = await database();
  const c = collections(db);
  const now = new Date();
  const expired = await c.assets
    .find({ expiresAt: { $lte: now } }, { projection: { id: 1 } })
    .limit(BATCH)
    .toArray();

  // Re-checked at destruction time: an expiry lifted since the batch was
  // selected must not be destroyed anyway.
  const results = await Promise.allSettled(
    expired.map((asset) => deleteExpiredAsset(db, asset.id, now)),
  );
  // Only rows still expired when reached: a lifted expiry resolves `false` and
  // is reported as skipped, not as deleted.
  const deleted = results.filter(
    (result) => result.status === "fulfilled" && result.value,
  ).length;
  const failed = results.filter(
    (result) => result.status === "rejected",
  ).length;

  // Expired product documents were left behind: only assets were ever purged,
  // and `products` carries no TTL index — deliberately, since a TTL would also
  // remove the row a merchant is entitled to restore before its retention ends.
  // Their images went with the pass above; the rows go here.
  const staleProducts = await c.products
    .find({ expiresAt: { $lte: now } }, { projection: { id: 1 } })
    .limit(BATCH)
    .toArray();
  const productsDeleted = staleProducts.length
    ? (
        await c.products.deleteMany({
          id: { $in: staleProducts.map((product) => product.id) },
          expiresAt: { $lte: now },
        })
      ).deletedCount
    : 0;

  // A render killed mid-flight runs none of the paths that end it: without
  // this it stays `processing` for ever and its credit stays held. Marked
  // terminal first, then the credit is given back — the release is idempotent,
  // so a run that turns out to have finished changes nothing.
  const rendersFailed = await failAbandonedRenders(db, now);
  const durableRendersExpired = await expireDurableRenders(db);
  const creditsReleased = await releaseStaleHolds(db, now);

  const remaining = await c.assets.countDocuments({ expiresAt: { $lte: now } });

  return Response.json({
    ok: true,
    deleted,
    failed,
    skipped: results.length - deleted - failed,
    productsDeleted,
    rendersFailed,
    durableRendersExpired,
    creditsReleased,
    // Non-zero means this run hit its batch ceiling or failed on some rows:
    // schedule another pass.
    remaining,
  });
}
