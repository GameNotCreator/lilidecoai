import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "mongodb";
import type { RenderDocument } from "../lib/server/types";
import { documentStore } from "./helpers/render-store";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  reserve: vi.fn(),
  release: vi.fn(),
  collections: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/credits", () => ({
  captureCredit: mocks.capture,
  reserveCredit: mocks.reserve,
  releaseCredit: mocks.release,
}));
vi.mock("../lib/server/mongodb", () => ({ collections: mocks.collections }));
vi.mock("../lib/server/config", () => ({
  serverConfig: { aiMockMode: false },
}));
import {
  advanceRender,
  completeRender,
  failAbandonedRenders,
  STALE_CLAIM_MS,
  stopRender,
} from "../lib/server/render-lifecycle";

const db = {} as Db;
const accepted = {
  qualityDecision: {
    version: "v1",
    status: "accepted" as const,
    score: 0.9,
    feedback: "ok",
    checks: [],
  },
  resultAssetId: "result",
};
let store: ReturnType<typeof documentStore>;
let render: RenderDocument;
beforeEach(async () => {
  store = documentStore();
  render = {
    id: "r",
    organizationId: "org",
    status: "processing",
    creditCharged: false,
  } as RenderDocument;
  await store.insertOne({ ...render });
  mocks.collections.mockReturnValue({ renders: store });
  mocks.capture.mockReset().mockResolvedValue(true);
  mocks.reserve.mockReset().mockResolvedValue("reserved");
  mocks.release.mockReset().mockResolvedValue(true);
});

describe("finalization races", () => {
  it.each(["cancel", "delete"] as const)(
    "%s wins before finalization and prevents debit and resurrection",
    async (action) => {
      await stopRender(db, render, action);
      await expect(completeRender(db, render, accepted)).rejects.toThrow();
      await expect(
        advanceRender(db, render.id, { $set: { status: "processing" } }),
      ).rejects.toThrow();
      expect(mocks.capture).not.toHaveBeenCalled();
      expect(store.rows[0]!.status).toBe(
        action === "cancel" ? "cancelled" : "deleted",
      );
    },
  );
  it("a claimed finalization wins; cancellation and duplicate workers cannot interrupt the debit", async () => {
    let release!: (value: boolean) => void;
    mocks.capture.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const finishing = completeRender(db, render, accepted);
    await vi.waitFor(() => expect(mocks.capture).toHaveBeenCalledOnce());
    await expect(stopRender(db, render, "cancel")).rejects.toThrow(
      /finalisation/,
    );
    await expect(stopRender(db, render, "delete")).rejects.toThrow(
      /finalisation/,
    );
    await expect(completeRender(db, render, accepted)).rejects.toThrow();
    await expect(
      advanceRender(db, render.id, {
        $set: { pipelineState: "quality_check" },
      }),
    ).rejects.toThrow();
    release(true);
    await expect(finishing).resolves.toBe(true);
    expect(store.rows[0]).toMatchObject({
      status: "succeeded",
      creditCharged: true,
      resultAssetId: "result",
    });
    expect((await stopRender(db, render, "cancel")).status).toBe("succeeded");
    expect(mocks.capture).toHaveBeenCalledOnce();
  });
  it("does not charge if quality is missing or unavailable", async () => {
    await expect(completeRender(db, render, {})).rejects.toThrow(/qualité/);
    await expect(
      completeRender(db, render, {
        ...accepted,
        qualityDecision: {
          ...accepted.qualityDecision,
          status: "unavailable",
          score: null,
        },
      }),
    ).rejects.toThrow();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(store.rows[0]!.finalizationToken).toBeUndefined();
  });
});

/**
 * Found by the adversarial review: a claim held by a process that died left a
 * render nobody could cancel, delete or refund — both stopRender branches
 * refuse exactly "processing with a token".
 */
describe("a claim outliving its process", () => {
  it.each(["cancel", "delete"] as const)(
    "lets %s through once the claim is older than any possible run",
    async (action) => {
      await store.updateOne(
        { id: "r" },
        {
          $set: {
            finalizationToken: "abandoned",
            finalizationStartedAt: new Date(Date.now() - STALE_CLAIM_MS - 1),
          },
        },
      );
      const stopped = await stopRender(db, render, action);
      expect(stopped.status).toBe(
        action === "cancel" ? "cancelled" : "deleted",
      );
      expect(mocks.release).toHaveBeenCalledOnce();
    },
  );

  it("still refuses while the claim could belong to a live run", async () => {
    await store.updateOne(
      { id: "r" },
      {
        $set: {
          finalizationToken: "running",
          finalizationStartedAt: new Date(Date.now() - 1_000),
        },
      },
    );
    await expect(stopRender(db, render, "cancel")).rejects.toThrow(
      /finalisation/,
    );
  });
});

/**
 * The audit's operations gate: no job may stay without a terminal state. A
 * process killed mid-render takes none of the paths that end one.
 */
describe("abandoned renders", () => {
  it("fails a render no live process can still be working on", async () => {
    await store.updateOne(
      { id: "r" },
      { $set: { updatedAt: new Date(Date.now() - STALE_CLAIM_MS - 1) } },
    );
    expect(await failAbandonedRenders(db)).toBe(1);
    expect(store.rows[0]!.status).toBe("failed");
    expect(store.rows[0]!.pipelineState).toBe("failed");
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("leaves a render that was touched recently", async () => {
    await store.updateOne(
      { id: "r" },
      { $set: { updatedAt: new Date(Date.now() - 10_000) } },
    );
    expect(await failAbandonedRenders(db)).toBe(0);
    expect(store.rows[0]!.status).toBe("processing");
  });

  it("never revives a render that already reached a terminal state", async () => {
    await store.updateOne(
      { id: "r" },
      {
        $set: {
          status: "succeeded",
          updatedAt: new Date(Date.now() - STALE_CLAIM_MS - 1),
        },
      },
    );
    expect(await failAbandonedRenders(db)).toBe(0);
    expect(store.rows[0]!.status).toBe("succeeded");
  });
});
