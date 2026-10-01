import { MongoClient, type Db } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getVisualizationBudget, grantVisualizationCapacity } from "../lib/server/admin-visualization-budget";
import { collections } from "../lib/server/mongodb";

const uri = process.env.DURABLE_TEST_MONGODB_URI;

describe.skipIf(!uri)("visualization capacity on a real MongoDB replica set", () => {
  let client: MongoClient;
  let db: Db;
  const organizationId = "shop";
  let idempotencyKey: string;

  beforeAll(async () => {
    client = await new MongoClient(uri!).connect();
    db = client.db(`lili_capacity_test_${crypto.randomUUID().replaceAll("-", "")}`);
    const c = collections(db);
    await c.wallets.createIndex({ organizationId: 1 }, { unique: true });
    await c.creditTransactions.createIndex({ organizationId: 1, idempotencyKey: 1 }, { unique: true });
  });
  beforeEach(async () => {
    vi.stubEnv("RENDER_MAX_COST_USD", "2");
    idempotencyKey = crypto.randomUUID();
    await Promise.all(["wallets", "credit_transactions", "audit_logs"].map(name => db.collection(name).deleteMany({})));
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    if (db) await db.dropDatabase();
    if (client) await client.close();
  });
  const grant = (credits = 3, key = idempotencyKey, org = organizationId) =>
    grantVisualizationCapacity(db, org, { credits, idempotencyKey: key }, "LiliDeco");

  it("reads a missing wallet without changing any business data or inventing an organization", async () => {
    expect(await getVisualizationBudget(db, organizationId)).toEqual({ balance: 0, reserved: 0, maxCostPerRenderUsd: 2 });
    expect(await getVisualizationBudget(db)).toEqual({ balance: 0, reserved: 0, maxCostPerRenderUsd: 2 });
    for (const name of ["wallets", "credit_transactions", "audit_logs", "organizations"])
      expect(await db.collection(name).countDocuments({})).toBe(0);
  });

  it("explicitly initializes a missing wallet, ledger and audit in one grant", async () => {
    expect(await grant()).toEqual({ balance: 3, reserved: 0, maxCostPerRenderUsd: 2 });
    const c = collections(db);
    expect(await c.wallets.findOne({ organizationId })).toMatchObject({ balance: 3, reserved: 0, holds: [], processedKeys: [] });
    expect(await c.creditTransactions.findOne({ organizationId })).toMatchObject({
      type: "render_capacity_grant", amount: 3, balanceAfter: 3,
      idempotencyKey: `visualization-capacity:${idempotencyKey}`,
    });
    expect(await c.auditLogs.findOne({ organizationId })).toMatchObject({
      action: "render_capacity_grant", actorType: "backoffice", actor: "LiliDeco", credits: 3,
    });
  });

  it("replays the same grant without giving more capacity, even after consumption", async () => {
    await grant();
    await collections(db).wallets.updateOne({ organizationId }, { $inc: { balance: -1 } });
    expect(await grant()).toEqual({ balance: 2, reserved: 0, maxCostPerRenderUsd: 2 });
    expect(await db.collection("credit_transactions").countDocuments({})).toBe(1);
    expect(await db.collection("audit_logs").countDocuments({})).toBe(1);
  });

  it("rejects a reused key with a different amount without changing the grant", async () => {
    await grant(2);
    await expect(grant(3)).rejects.toMatchObject({ status: 409 });
    expect(await getVisualizationBudget(db, organizationId)).toEqual({ balance: 2, reserved: 0, maxCostPerRenderUsd: 2 });
    expect(await db.collection("credit_transactions").countDocuments({})).toBe(1);
    expect(await db.collection("audit_logs").countDocuments({})).toBe(1);
  });

  it("preserves existing holds, reserved capacity and processed keys", async () => {
    const holds = [{ key: "render:pending", reservedAt: new Date() }];
    await collections(db).wallets.insertOne({ organizationId, balance: 0, reserved: 1, holds, processedKeys: ["existing-key"], updatedAt: new Date() });
    expect(await grant()).toEqual({ balance: 3, reserved: 1, maxCostPerRenderUsd: 2 });
    expect(await collections(db).wallets.findOne({ organizationId })).toMatchObject({ holds, processedKeys: ["existing-key"], reserved: 1, balance: 3 });
  });

  it("keeps the same grant key and wallet balances isolated across organizations", async () => {
    await grant(3, idempotencyKey, "shop-a");
    await grant(1, idempotencyKey, "shop-b");
    expect((await getVisualizationBudget(db, "shop-a")).balance).toBe(3);
    expect((await getVisualizationBudget(db, "shop-b")).balance).toBe(1);
    expect((await getVisualizationBudget(db, "unknown")).balance).toBe(0);
    expect(await db.collection("credit_transactions").countDocuments({})).toBe(2);
  });

  it("grants once under ten concurrent retries, including creation of a missing wallet", async () => {
    const outcomes = await Promise.allSettled(Array.from({ length: 10 }, () => grant()));
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(10);
    expect((await getVisualizationBudget(db, organizationId)).balance).toBe(3);
    expect(await db.collection("wallets").countDocuments({})).toBe(1);
    expect(await db.collection("credit_transactions").countDocuments({})).toBe(1);
    expect(await db.collection("audit_logs").countDocuments({})).toBe(1);
  });

  it("serializes different concurrent grants without losing capacity", async () => {
    await Promise.all([grant(3, crypto.randomUUID()), grant(2, crypto.randomUUID()), grant(1, crypto.randomUUID())]);
    expect((await getVisualizationBudget(db, organizationId)).balance).toBe(6);
    expect(await db.collection("credit_transactions").countDocuments({})).toBe(3);
    expect(await db.collection("audit_logs").countDocuments({})).toBe(3);
  });

  it("rolls back the wallet and ledger when writing the administrative audit fails", async () => {
    const brokenAuditDb = {
      client: db.client,
      collection: (name: string) => name === "audit_logs"
        ? { insertOne: async () => { throw new Error("audit unavailable"); } }
        : db.collection(name),
    } as Db;
    await expect(grantVisualizationCapacity(brokenAuditDb, organizationId, { credits: 3, idempotencyKey }, "LiliDeco")).rejects.toThrow("audit unavailable");
    for (const name of ["wallets", "credit_transactions", "audit_logs"])
      expect(await db.collection(name).countDocuments({})).toBe(0);
  });

  it.each([0, 4, 1.5])("refuses %s capacity before creating a wallet or journal", async (credits) => {
    await expect(grant(credits)).rejects.toThrow();
    for (const name of ["wallets", "credit_transactions", "audit_logs"])
      expect(await db.collection(name).countDocuments({})).toBe(0);
  });
});
