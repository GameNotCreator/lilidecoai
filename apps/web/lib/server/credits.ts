import "server-only";

import type { Db } from "mongodb";

import { collections } from "./mongodb";

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

export async function captureCredit(
  db: Db,
  organizationId: string,
  idempotencyKey: string,
): Promise<boolean> {
  const c = collections(db);
  const wallet = await c.wallets.findOneAndUpdate(
    {
      organizationId,
      balance: { $gte: 1 },
      processedKeys: { $ne: idempotencyKey },
    },
    {
      $inc: { balance: -1 },
      $push: { processedKeys: idempotencyKey },
      $set: { updatedAt: new Date() },
    },
    { returnDocument: "after" },
  );
  if (!wallet) {
    const alreadyProcessed = await c.wallets.findOne({
      organizationId,
      processedKeys: idempotencyKey,
    });
    if (alreadyProcessed) return false;
    throw new CreditError("Crédits insuffisants");
  }
  await c.creditTransactions.updateOne(
    { organizationId, idempotencyKey },
    {
      $setOnInsert: {
        id: crypto.randomUUID(),
        organizationId,
        idempotencyKey,
        type: "render_capture",
        amount: -1,
        status: "captured",
        balanceAfter: wallet.balance,
        createdAt: new Date(),
      },
    },
    { upsert: true },
  );
  return true;
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
  await c.creditTransactions.updateOne(
    { organizationId, idempotencyKey },
    {
      $setOnInsert: {
        id: crypto.randomUUID(),
        organizationId,
        idempotencyKey,
        type,
        amount,
        status: "captured",
        balanceAfter: wallet.balance,
        createdAt: new Date(),
      },
    },
    { upsert: true },
  );
  return true;
}

export class CreditError extends Error {}
