import "server-only";

import type { Db } from "mongodb";
import { z } from "zod";

import { AdminProductError } from "./admin-products";
import { collections } from "./mongodb";
import { renderBudgetUsd } from "./provider-usage";
import type { WalletDocument } from "./types";

export const visualizationCapacityGrantSchema = z.object({
  credits: z.number().int().min(1).max(3),
  idempotencyKey: z.uuid(),
}).strict();

function budgetResponse(wallet: WalletDocument | null) {
  return {
    balance: wallet?.balance ?? 0,
    reserved: wallet?.reserved ?? 0,
    maxCostPerRenderUsd: renderBudgetUsd(),
  };
}

/** Reading capacity never creates, replenishes or settles a wallet. */
export async function getVisualizationBudget(db: Db, organizationId?: string) {
  const wallet = organizationId
    ? await collections(db).wallets.findOne({ organizationId })
    : null;
  return budgetResponse(wallet);
}

/** Explicit administrative capacity, distinct from purchases or provider USD. */
export async function grantVisualizationCapacity(
  db: Db,
  organizationId: string,
  input: unknown,
  username: string,
) {
  const { credits, idempotencyKey } = visualizationCapacityGrantSchema.parse(input);
  const ledgerKey = `visualization-capacity:${idempotencyKey}`;
  const c = collections(db);

  // A simultaneous first grant may race on the wallet's unique organization
  // index. Retry that transaction; the ledger still prevents a second grant.
  for (let attempt = 0; attempt < 3; attempt++) {
    const session = db.client.startSession();
    try {
      return await session.withTransaction(async () => {
        const existing = await c.creditTransactions.findOne(
          { organizationId, idempotencyKey: ledgerKey }, { session },
        );
        if (existing) {
          if (existing.type !== "render_capacity_grant" || existing.amount !== credits)
            throw new AdminProductError("Cette demande a déjà été utilisée pour une autre attribution.", 409);
          const wallet = await c.wallets.findOne({ organizationId }, { session });
          if (!wallet) throw new AdminProductError("Le budget de visualisation nécessite une vérification.", 409);
          return budgetResponse(wallet);
        }

        const now = new Date();
        const wallet = await c.wallets.findOneAndUpdate(
          { organizationId },
          {
            $inc: { balance: credits },
            $set: { updatedAt: now },
            $setOnInsert: { organizationId, reserved: 0, holds: [], processedKeys: [] },
          },
          { session, upsert: true, returnDocument: "after" },
        );
        if (!wallet) throw new Error("Attribution du budget non enregistrée.");
        await c.creditTransactions.insertOne({
          id: crypto.randomUUID(), organizationId, idempotencyKey: ledgerKey,
          type: "render_capacity_grant", amount: credits, status: "captured",
          balanceAfter: wallet.balance, createdAt: now,
        }, { session });
        await c.auditLogs.insertOne({
          id: crypto.randomUUID(), organizationId,
          actorType: "backoffice", actor: username,
          action: "render_capacity_grant", credits,
          idempotencyKey: ledgerKey, createdAt: now,
        }, { session });
        return budgetResponse(wallet);
      }, {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
        readPreference: "primary",
      });
    } catch (reason) {
      if (
        attempt === 2 || !reason || typeof reason !== "object" ||
        !("code" in reason) || reason.code !== 11000
      ) throw reason;
    } finally {
      await session.endSession();
    }
  }
  throw new Error("Attribution du budget impossible.");
}
