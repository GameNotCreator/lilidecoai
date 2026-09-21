import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "mongodb";

const mocks = vi.hoisted(() => ({ collections: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/mongodb", () => ({ collections: mocks.collections }));

import {
  captureCredit,
  CreditError,
  getCredits,
  releaseCredit,
  PROCESSED_KEY_WINDOW,
  releaseStaleHolds,
  reserveCredit,
  STALE_HOLD_MS,
} from "../lib/server/credits";
import { mongoStore } from "./helpers/mongo-store";

const db = {} as Db;
const ORG = "org";

let wallets: ReturnType<typeof mongoStore>;
let creditTransactions: ReturnType<typeof mongoStore>;

function seed(balance: number): void {
  wallets.rows.push({
    organizationId: ORG,
    balance,
    reserved: 0,
    holds: [],
    processedKeys: [],
    updatedAt: new Date(),
  });
}

beforeEach(() => {
  wallets = mongoStore();
  creditTransactions = mongoStore();
  mocks.collections.mockReturnValue({ wallets, creditTransactions });
});

describe("reservation", () => {
  it("holds a credit out of the spendable balance", async () => {
    seed(3);
    expect(await reserveCredit(db, ORG, "render:a")).toBe("reserved");
    const wallet = wallets.rows[0]!;
    expect(wallet.balance).toBe(2);
    expect(wallet.reserved).toBe(1);
    expect(wallet.holds).toHaveLength(1);
    // A held credit is not spendable and not yet spent.
    expect((await getCredits(db, ORG)).balance).toBe(2);
    expect((await getCredits(db, ORG)).reserved).toBe(1);
  });

  // A11 of the audit: ten concurrent renders used to reach the paid provider
  // with a single credit between them, because nothing was checked up front.
  it("lets exactly one of ten concurrent renders hold the last credit", async () => {
    seed(1);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        reserveCredit(db, ORG, `render:${index}`),
      ),
    );
    const reserved = outcomes.filter(
      (outcome) =>
        outcome.status === "fulfilled" && outcome.value === "reserved",
    );
    expect(reserved).toHaveLength(1);
    expect(
      outcomes.every(
        (outcome) =>
          outcome.status === "fulfilled" ||
          outcome.reason instanceof CreditError,
      ),
    ).toBe(true);
    expect(wallets.rows[0]!.balance).toBe(0);
    expect(wallets.rows[0]!.reserved).toBe(1);
  });

  it("is idempotent: a replayed key holds nothing more", async () => {
    seed(2);
    expect(await reserveCredit(db, ORG, "render:a")).toBe("reserved");
    expect(await reserveCredit(db, ORG, "render:a")).toBe("already_reserved");
    expect(wallets.rows[0]!.balance).toBe(1);
    expect(wallets.rows[0]!.holds).toHaveLength(1);
  });

  it("refuses when nothing is left", async () => {
    seed(0);
    await expect(reserveCredit(db, ORG, "render:a")).rejects.toBeInstanceOf(
      CreditError,
    );
  });
});

describe("capture", () => {
  it("spends the held credit without touching the balance again", async () => {
    seed(2);
    await reserveCredit(db, ORG, "render:a");
    expect(await captureCredit(db, ORG, "render:a")).toBe(true);
    const wallet = wallets.rows[0]!;
    expect(wallet.balance).toBe(1);
    expect(wallet.reserved).toBe(0);
    expect(wallet.holds).toHaveLength(0);
    expect(wallet.processedKeys).toEqual(["render:a"]);
    expect(creditTransactions.rows).toHaveLength(1);
    expect(creditTransactions.rows[0]).toMatchObject({
      type: "render_capture",
      amount: -1,
      status: "captured",
      balanceAfter: 1,
    });
  });

  it("reports a replayed capture as already spent, not as a new charge", async () => {
    seed(2);
    await reserveCredit(db, ORG, "render:a");
    expect(await captureCredit(db, ORG, "render:a")).toBe(true);
    expect(await captureCredit(db, ORG, "render:a")).toBe(false);
    expect(wallets.rows[0]!.balance).toBe(1);
    expect(creditTransactions.rows).toHaveLength(1);
  });

  // Renders started before reservations existed must still settle.
  it("debits directly when no hold exists", async () => {
    seed(2);
    expect(await captureCredit(db, ORG, "render:legacy")).toBe(true);
    expect(wallets.rows[0]!.balance).toBe(1);
    expect(wallets.rows[0]!.processedKeys).toEqual(["render:legacy"]);
  });

  it("refuses a direct debit with an empty balance", async () => {
    seed(0);
    await expect(
      captureCredit(db, ORG, "render:legacy"),
    ).rejects.toBeInstanceOf(CreditError);
  });
});

describe("release", () => {
  it("returns a held credit to the spendable balance", async () => {
    seed(2);
    await reserveCredit(db, ORG, "render:a");
    expect(await releaseCredit(db, ORG, "render:a")).toBe(true);
    const wallet = wallets.rows[0]!;
    expect(wallet.balance).toBe(2);
    expect(wallet.reserved).toBe(0);
    expect(wallet.holds).toHaveLength(0);
    expect(creditTransactions.rows[0]).toMatchObject({
      type: "render_release",
      amount: 1,
      status: "released",
    });
  });

  it("is idempotent and never un-spends a captured credit", async () => {
    seed(2);
    await reserveCredit(db, ORG, "render:a");
    expect(await releaseCredit(db, ORG, "render:a")).toBe(true);
    expect(await releaseCredit(db, ORG, "render:a")).toBe(false);
    expect(wallets.rows[0]!.balance).toBe(2);

    await reserveCredit(db, ORG, "render:b");
    await captureCredit(db, ORG, "render:b");
    expect(await releaseCredit(db, ORG, "render:b")).toBe(false);
    expect(wallets.rows[0]!.balance).toBe(1);
  });

  it("releases nothing for a render that never reserved", async () => {
    seed(1);
    expect(await releaseCredit(db, ORG, "render:never")).toBe(false);
    expect(wallets.rows[0]!.balance).toBe(1);
  });

  it("frees the credit for the next render after a failure", async () => {
    seed(1);
    await reserveCredit(db, ORG, "render:a");
    await expect(reserveCredit(db, ORG, "render:b")).rejects.toBeInstanceOf(
      CreditError,
    );
    await releaseCredit(db, ORG, "render:a");
    expect(await reserveCredit(db, ORG, "render:b")).toBe("reserved");
  });
});

/**
 * Found by the adversarial review: a render killed between reserving and
 * settling runs none of the paths that give the credit back, so the hold would
 * last forever.
 */
describe("stale holds", () => {
  function age(key: string, ms: number): void {
    const wallet = wallets.rows[0]!;
    const holds = wallet.holds as Array<{ key: string; reservedAt: Date }>;
    const hold = holds.find((item) => item.key === key)!;
    hold.reservedAt = new Date(Date.now() - ms);
  }

  it("reclaims a credit whose run can no longer be alive", async () => {
    seed(2);
    await reserveCredit(db, ORG, "render:dead");
    age("render:dead", STALE_HOLD_MS + 1_000);
    expect(await releaseStaleHolds(db)).toBe(1);
    expect(wallets.rows[0]!.balance).toBe(2);
    expect(wallets.rows[0]!.holds).toHaveLength(0);
    expect(wallets.rows[0]!.reserved).toBe(0);
  });

  it("leaves a hold that could still belong to a running render", async () => {
    seed(2);
    await reserveCredit(db, ORG, "render:live");
    age("render:live", 30_000);
    expect(await releaseStaleHolds(db)).toBe(0);
    expect(wallets.rows[0]!.balance).toBe(1);
    expect(wallets.rows[0]!.holds).toHaveLength(1);
  });

  it("is idempotent: a second sweep reclaims nothing more", async () => {
    seed(1);
    await reserveCredit(db, ORG, "render:dead");
    age("render:dead", STALE_HOLD_MS + 1_000);
    expect(await releaseStaleHolds(db)).toBe(1);
    expect(await releaseStaleHolds(db)).toBe(0);
    expect(wallets.rows[0]!.balance).toBe(1);
  });
});

/**
 * Found by the adversarial review: `processedKeys` grew one entry per render,
 * for ever, inside a document with a 16 MB ceiling.
 */
describe("bounded replay cache", () => {
  // Two thousand captures against an in-memory store that scans linearly:
  // seconds of test time, well past vitest's 5 s default on a loaded machine.
  // The production path is an indexed lookup.
  it(
    "keeps the cache bounded",
    async () => {
      seed(PROCESSED_KEY_WINDOW + 5);
      for (let index = 0; index < PROCESSED_KEY_WINDOW + 3; index++) {
        await captureCredit(db, ORG, `render:${index}`);
      }
      const keys = wallets.rows[0]!.processedKeys as string[];
      expect(keys).toHaveLength(PROCESSED_KEY_WINDOW);
      // The oldest keys have fallen out of the cache.
      expect(keys).not.toContain("render:0");
    },
    30_000,
  );

  it("still refuses a replay whose key has left the cache", async () => {
    seed(3);
    await captureCredit(db, ORG, "render:old");
    // Simulate the key ageing out of the bounded cache; the journal remains.
    wallets.rows[0]!.processedKeys = [];
    expect(await captureCredit(db, ORG, "render:old")).toBe(false);
    expect(wallets.rows[0]!.balance).toBe(2);
    expect(creditTransactions.rows).toHaveLength(1);
  });
});
