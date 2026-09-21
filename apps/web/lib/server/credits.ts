import "server-only";

import type { Db } from "mongodb";

import { collections } from "./mongodb";

/**
 * Credit accounting for renders — audit finding A11.
 *
 * The wallet used to be debited only at the very end of a successful render,
 * so a burst of concurrent requests could all pass the (non-existent) balance
 * check and spend real provider money against a single credit. Money is now
 * held before the first paid call and settled afterwards:
 *
 *     reserve → (paid pipeline) → capture on delivery
 *                              └→ release on failure, cancel or rejection
 *
 * Every transition is one atomic update of the single wallet document, which
 * is what MongoDB guarantees without a replica set — this deployment has no
 * multi-document transactions, and pretending otherwise would be the same
 * fiction the audit found elsewhere. The consequence is stated rather than
 * hidden: the wallet is authoritative, and the `credit_transactions` journal
 * is written immediately after and can lag behind by one crash. A held credit
 * whose process dies is neither captured nor released until a sweeper reclaims
 * it; `reservedAt` exists for that sweeper, which is not built yet.
 *
 * All three operations are idempotent on `idempotencyKey`, so a replayed
 * request never holds, spends or returns a credit twice.
 */

/** A credit held for one render, waiting to be captured or released. */
export interface CreditHold {
  key: string;
  reservedAt: Date;
}

/**
 * How many recent capture keys the wallet keeps.
 *
 * The array used to grow without bound, one entry per render for the life of
 * the organization, inside a single document with a 16 MB ceiling. It is now
 * a bounded cache: the durable record is `credit_transactions`, whose unique
 * index on `(organizationId, idempotencyKey)` is what actually makes a replay
 * impossible. Trimming the cache can therefore only cost one extra lookup,
 * never a double charge.
 */
export const PROCESSED_KEY_WINDOW = 2_000;

/** The journal, not the wallet cache, is the durable answer. */
async function alreadyCaptured(
  db: Db,
  organizationId: string,
  idempotencyKey: string,
): Promise<boolean> {
  const c = collections(db);
  const wallet = await c.wallets.findOne(
    { organizationId },
    { projection: { processedKeys: 1 } },
  );
  if (wallet?.processedKeys?.includes(idempotencyKey)) return true;
  const journaled = await c.creditTransactions.findOne({
    organizationId,
    idempotencyKey,
  });
  return Boolean(journaled);
}

export type ReservationOutcome =
  | "reserved"
  | "already_reserved"
  | "already_captured";

export async function getCredits(db: Db, organizationId: string) {
  const c = collections(db);
  const wallet = await c.wallets.findOne({ organizationId });
  const transactions = await c.creditTransactions
    .find({ organizationId })
    .sort({ createdAt: -1 })
    .limit(30)
    .toArray();
  return {
    balance: wallet?.balance ?? 0,
    /** Held for renders in flight: spendable neither now nor by anyone else. */
    reserved: wallet?.reserved ?? 0,
    transactions: transactions.map((item) => ({
      id: item.id,
      type: item.type,
      amount: item.amount,
      status: item.status,
      balanceAfter: item.balanceAfter,
      createdAt: item.createdAt.toISOString(),
    })),
  };
}

async function journal(
  db: Db,
  organizationId: string,
  idempotencyKey: string,
  type: string,
  amount: number,
  status: "captured" | "released",
  balanceAfter: number,
): Promise<void> {
  await collections(db).creditTransactions.updateOne(
    { organizationId, idempotencyKey },
    {
      $setOnInsert: {
        id: crypto.randomUUID(),
        organizationId,
        idempotencyKey,
        type,
        amount,
        status,
        balanceAfter,
        createdAt: new Date(),
      },
    },
    { upsert: true },
  );
}

/**
 * Take one credit out of the spendable balance and hold it for this render.
 * Call before the first paid provider call, never after.
 *
 * Throws `CreditError` when nothing is available. A missing wallet is
 * indistinguishable from an empty one, as before.
 */
export async function reserveCredit(
  db: Db,
  organizationId: string,
  idempotencyKey: string,
): Promise<ReservationOutcome> {
  const c = collections(db);
  const wallet = await c.wallets.findOneAndUpdate(
    {
      organizationId,
      balance: { $gte: 1 },
      "holds.key": { $ne: idempotencyKey },
      processedKeys: { $ne: idempotencyKey },
    },
    {
      $inc: { balance: -1, reserved: 1 },
      $push: { holds: { key: idempotencyKey, reservedAt: new Date() } },
      $set: { updatedAt: new Date() },
    },
    { returnDocument: "after" },
  );
  if (wallet) return "reserved";
  // No hold taken: either this key already holds or already spent a credit,
  // or there is nothing left to hold.
  const current = await c.wallets.findOne({ organizationId });
  if (current?.holds?.some((hold) => hold.key === idempotencyKey)) {
    return "already_reserved";
  }
  if (await alreadyCaptured(db, organizationId, idempotencyKey)) {
    return "already_captured";
  }
  throw new CreditError("Crédits insuffisants");
}

/**
 * Spend a held credit. Returns whether this call is the one that spent it —
 * `false` means an earlier attempt with the same key already did, which is a
 * successful outcome, not a failure.
 *
 * Falls back to a direct debit when no hold exists, so a render started before
 * reservations existed still settles instead of failing at delivery.
 */
export async function captureCredit(
  db: Db,
  organizationId: string,
  idempotencyKey: string,
): Promise<boolean> {
  const c = collections(db);
  const captured = await c.wallets.findOneAndUpdate(
    { organizationId, "holds.key": idempotencyKey },
    {
      $inc: { reserved: -1 },
      $pull: { holds: { key: idempotencyKey } },
      $push: {
        processedKeys: {
          $each: [idempotencyKey],
          $slice: -PROCESSED_KEY_WINDOW,
        },
      },
      $set: { updatedAt: new Date() },
    },
    { returnDocument: "after" },
  );
  if (captured) {
    await journal(
      db,
      organizationId,
      idempotencyKey,
      "render_capture",
      -1,
      "captured",
      captured.balance,
    );
    return true;
  }
  if (await alreadyCaptured(db, organizationId, idempotencyKey)) return false;
  // No hold and never captured: a render that predates reservations, or one
  // whose hold a sweeper released. Debit directly, still refusing to go
  // negative.
  const wallet = await c.wallets.findOneAndUpdate(
    {
      organizationId,
      balance: { $gte: 1 },
      processedKeys: { $ne: idempotencyKey },
    },
    {
      $inc: { balance: -1 },
      $push: {
        processedKeys: {
          $each: [idempotencyKey],
          $slice: -PROCESSED_KEY_WINDOW,
        },
      },
      $set: { updatedAt: new Date() },
    },
    { returnDocument: "after" },
  );
  if (!wallet) throw new CreditError("Crédits insuffisants");
  await journal(
    db,
    organizationId,
    idempotencyKey,
    "render_capture",
    -1,
    "captured",
    wallet.balance,
  );
  return true;
}

/**
 * Give a held credit back. Safe to call when nothing is held: a render that
 * failed before reserving, or one already captured, returns `false` and
 * changes nothing. A captured credit is never un-spent here — refunding a
 * delivered render is a separate, deliberate decision.
 */
export async function releaseCredit(
  db: Db,
  organizationId: string,
  idempotencyKey: string,
): Promise<boolean> {
  const c = collections(db);
  const wallet = await c.wallets.findOneAndUpdate(
    { organizationId, "holds.key": idempotencyKey },
    {
      $inc: { balance: 1, reserved: -1 },
      $pull: { holds: { key: idempotencyKey } },
      $set: { updatedAt: new Date() },
    },
    { returnDocument: "after" },
  );
  if (!wallet) return false;
  await journal(
    db,
    organizationId,
    `${idempotencyKey}:release`,
    "render_release",
    1,
    "released",
    wallet.balance,
  );
  return true;
}

/**
 * Longer than any possible run: the route caps at 300 s (`maxDuration`), so a
 * hold three times older than that belongs to a process that died between
 * reserving and settling.
 */
export const STALE_HOLD_MS = 900_000;

/**
 * Gives back credits held by runs that never finished.
 *
 * A reservation is released by the code path that fails, cancels or rejects —
 * but a process killed mid-render runs none of them, and the credit would stay
 * held forever. `reservedAt` is written for exactly this. Each hold is released
 * through the same idempotent `releaseCredit`, so a run that turns out to have
 * settled after all changes nothing.
 *
 * Returns how many credits were reclaimed. Scheduled from the purge cron
 * rather than a new job: it is the one thing already running on a timer.
 */
export async function releaseStaleHolds(
  db: Db,
  now = new Date(),
  limit = 200,
): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_HOLD_MS);
  const wallets = await collections(db)
    .wallets.find(
      { "holds.reservedAt": { $lte: cutoff } },
      { projection: { organizationId: 1, holds: 1 } },
    )
    .limit(limit)
    .toArray();
  let released = 0;
  for (const wallet of wallets) {
    for (const hold of wallet.holds ?? []) {
      if (!hold.reservedAt || hold.reservedAt.getTime() > cutoff.getTime()) {
        continue;
      }
      // Durable holds live until transactional settlement/cancellation/expiry.
      // A fixed 15-minute sweep must not refund a healthy long-running job.
      if (hold.key.startsWith("render:") && await collections(db).renders?.findOne({
        id: hold.key.slice(7), organizationId: wallet.organizationId,
        execution: { $exists: true }, status: { $in: ["queued", "processing"] },
      })) continue;
      if (await releaseCredit(db, wallet.organizationId, hold.key)) released++;
    }
  }
  return released;
}

export async function addCredits(
  db: Db,
  organizationId: string,
  amount: number,
  idempotencyKey: string,
  type = "pack_purchase",
): Promise<boolean> {
  const c = collections(db);
  const wallet = await c.wallets.findOneAndUpdate(
    { organizationId, processedKeys: { $ne: idempotencyKey } },
    {
      $inc: { balance: amount },
      $push: { processedKeys: idempotencyKey },
      $set: { updatedAt: new Date() },
    },
    { returnDocument: "after" },
  );
  if (!wallet) return false;
  await journal(
    db,
    organizationId,
    idempotencyKey,
    type,
    amount,
    "captured",
    wallet.balance,
  );
  return true;
}

export class CreditError extends Error {
  readonly status = 422;
}
