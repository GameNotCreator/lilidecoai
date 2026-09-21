import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "mongodb";
import type { RenderDocument } from "../lib/server/types";
import { mongoStore } from "./helpers/mongo-store";

const mocks = vi.hoisted(() => ({ collections: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/mongodb", () => ({ collections: mocks.collections }));
vi.mock("../lib/server/config", () => ({
  serverConfig: { aiMockMode: false },
}));
import { durableContext } from "../lib/server/durable-context";
import {
  completeDurableRender,
  endDurableRender,
  reserveDurableCredit,
  claimRender,
  workerFingerprint,
  heartbeat,
  expireDurableRenders,
} from "../lib/server/durable-queue";

let renders: ReturnType<typeof mongoStore>;
let wallets: ReturnType<typeof mongoStore>;
let journals: ReturnType<typeof mongoStore>;
let assets: ReturnType<typeof mongoStore>;
let render: RenderDocument;
let db: Db;

beforeEach(() => {
  renders = mongoStore();
  wallets = mongoStore();
  journals = mongoStore();
  assets = mongoStore();
  mocks.collections.mockReturnValue({
    renders,
    wallets,
    creditTransactions: journals,
    assets,
  });
  // Deliberately a transaction simulator, not proof of replica-set behavior.
  // Snapshot rollback and serialization exercise our application invariants.
  let tail = Promise.resolve();
  db = {
    collection: () => ({ updateOne: async () => ({ matchedCount: 1 }) }),
    client: {
      startSession: () => ({
        endSession: async () => {},
        withTransaction: async (call: () => Promise<unknown>) => {
          const before = tail;
          let done!: () => void;
          tail = new Promise<void>((resolve) => {
            done = resolve;
          });
          await before;
          const stores = [renders, wallets, journals, assets];
          const copies = stores.map((store) => structuredClone(store.rows));
          try {
            return await call();
          } catch (reason) {
            stores.forEach((store, i) =>
              store.rows.splice(0, store.rows.length, ...copies[i]!),
            );
            throw reason;
          } finally {
            done();
          }
        },
      }),
    },
  } as unknown as Db;
  render = {
    id: "r",
    organizationId: "org",
    status: "processing",
    creditCharged: false,
    execution: {
      version: "render-durable-v2",
      configFingerprint: workerFingerprint(),
      token: "first",
      attempts: 1,
      leaseUntil: new Date(Date.now() + 90_000),
      availableAt: new Date(0),
      deadlineAt: new Date(Date.now() + 900_000),
      steps: {},
    },
  } as RenderDocument;
  renders.rows.push(
    structuredClone(render) as unknown as Record<string, unknown>,
  );
  wallets.rows.push({
    organizationId: "org",
    balance: 1,
    reserved: 0,
    holds: [],
  });
  assets.rows.push({
    id: "result",
    organizationId: "org",
    expiresAt: new Date(Date.now() + 900_000),
  });
});
const run = <T>(call: () => Promise<T>) =>
  durableContext.run({ render, token: "first" }, call);
const accepted = {
  resultAssetId: "result",
  qualityDecision: {
    version: "test",
    status: "accepted" as const,
    score: 1,
    feedback: "ok",
    checks: [],
  },
};

describe("durable settlement", () => {
  it("atomically captures a hold and publishes once despite duplicate completion", async () => {
    await run(() => reserveDurableCredit(db, render));
    const outcomes = await run(() =>
      Promise.allSettled([
        completeDurableRender(db, render, accepted),
        completeDurableRender(db, render, accepted),
      ]),
    );
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(wallets.rows[0]).toMatchObject({
      balance: 0,
      reserved: 0,
      holds: [],
    });
    expect(journals.rows).toHaveLength(1);
    expect(renders.rows[0]).toMatchObject({
      status: "succeeded",
      creditCharged: true,
      resultAssetId: "result",
    });
  });
  it("rolls back delivery and the debit if the credit journal fails", async () => {
    await run(() => reserveDurableCredit(db, render));
    vi.spyOn(journals, "updateOne").mockRejectedValueOnce(
      new Error("journal down"),
    );
    await expect(
      run(() => completeDurableRender(db, render, accepted)),
    ).rejects.toThrow("journal down");
    expect(renders.rows[0]!.status).toBe("processing");
    expect(wallets.rows[0]!.reserved).toBe(1);
    await run(() => completeDurableRender(db, render, accepted));
    expect(journals.rows).toHaveLength(1);
  });
  it("cancellation prevents a late debit, reservation and delivery", async () => {
    await run(() => reserveDurableCredit(db, render));
    await endDurableRender(db, render, "cancelled");
    await expect(
      run(() => completeDurableRender(db, render, accepted)),
    ).rejects.toMatchObject({ code: "lease_lost" });
    await expect(
      run(() => reserveDurableCredit(db, render)),
    ).rejects.toMatchObject({ code: "lease_lost" });
    expect(wallets.rows[0]).toMatchObject({ balance: 1, reserved: 0 });
    expect(journals.rows).toHaveLength(1);
  });
  it("a cancelled completed render remains delivered and charged", async () => {
    await run(() => reserveDurableCredit(db, render));
    await run(() => completeDurableRender(db, render, accepted));
    expect(await endDurableRender(db, render, "cancelled")).toBeNull();
    expect(wallets.rows[0]!.balance).toBe(0);
    expect(renders.rows[0]!.status).toBe("succeeded");
  });
  it("an expired candidate cannot be delivered or charged", async () => {
    await run(() => reserveDurableCredit(db, render));
    assets.rows[0]!.expiresAt = new Date(0);
    await expect(
      run(() => completeDurableRender(db, render, accepted)),
    ).rejects.toMatchObject({ code: "permanent" });
    expect(wallets.rows[0]!.reserved).toBe(1);
    expect(renders.rows[0]!.status).toBe("processing");
  });
  it("a technical QA failure cannot be finalized", async () => {
    await run(() => reserveDurableCredit(db, render));
    await expect(
      run(() =>
        completeDurableRender(db, render, {
          ...accepted,
          qualityDecision: {
            ...accepted.qualityDecision,
            status: "unavailable",
          },
        }),
      ),
    ).rejects.toThrow();
    expect(journals.rows).toHaveLength(0);
  });
});

describe("durable dispatch", () => {
  it("resumes an expired lease and excludes duplicate claims", async () => {
    await renders.updateOne(
      { id: "r" },
      { $set: { "execution.leaseUntil": new Date(0) } },
    );
    const results = await Promise.all([
      claimRender(db, "a"),
      claimRender(db, "b"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.find(Boolean)?.execution?.attempts).toBe(2);
    expect(await heartbeat(db, render, "first")).toBe(false);
  });
  it("never steals a job running under another engine configuration", async () => {
    await renders.updateOne(
      { id: "r" },
      {
        $set: {
          status: "queued",
          "execution.leaseUntil": new Date(0),
          "execution.configFingerprint": "other-revision",
        },
      },
    );
    expect(await claimRender(db, "worker")).toBeNull();
  });
  it("enforces tenant concurrency while serving another tenant", async () => {
    vi.stubEnv("RENDER_TENANT_CONCURRENCY", "1");
    try {
      for (const [id, organizationId] of [
        ["r2", "org"],
        ["r3", "other"],
      ])
        renders.rows.push({
          ...structuredClone(render),
          id,
          organizationId,
          status: "queued",
          execution: {
            ...structuredClone(render.execution),
            leaseUntil: new Date(0),
          },
        });
      expect((await claimRender(db, "worker"))?.id).toBe("r3");
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("enforces the global concurrency ceiling", async () => {
    vi.stubEnv("RENDER_GLOBAL_CONCURRENCY", "1");
    try {
      renders.rows.push({
        ...structuredClone(render),
        id: "r2",
        status: "queued",
        execution: {
          ...structuredClone(render.execution),
          leaseUntil: new Date(0),
        },
      });
      expect(await claimRender(db, "worker")).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("expires jobs explicitly and returns their hold once", async () => {
    await run(() => reserveDurableCredit(db, render));
    await renders.updateOne(
      { id: "r" },
      { $set: { "execution.deadlineAt": new Date(0) } },
    );
    expect(await expireDurableRenders(db)).toBe(1);
    expect(await expireDurableRenders(db)).toBe(0);
    expect(wallets.rows[0]).toMatchObject({ balance: 1, reserved: 0 });
    expect(renders.rows[0]!.status).toBe("failed");
  });
});
