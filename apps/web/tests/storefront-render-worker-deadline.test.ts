import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "mongodb";
import type { RenderDocument } from "../lib/server/types";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  end: vi.fn(),
  heartbeat: vi.fn(),
  reserve: vi.fn(),
  retry: vi.fn(),
  sources: vi.fn(),
  execute: vi.fn(),
  findOne: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/durable-queue", () => ({
  claimRender: mocks.claim,
  endDurableRender: mocks.end,
  heartbeat: mocks.heartbeat,
  reserveDurableCredit: mocks.reserve,
  retryDurableRender: mocks.retry,
  validateExecutionSources: mocks.sources,
}));
vi.mock("../lib/server/rendering", () => ({
  executeDurableRender: mocks.execute,
}));
vi.mock("../lib/server/mongodb", () => ({
  collections: () => ({ renders: { findOne: mocks.findOne } }),
}));

import { durableAbortSignal } from "../lib/server/durable-context";
import { runWorkerOnce } from "../lib/server/render-worker";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-30T10:02:30Z"));
  mocks.heartbeat.mockResolvedValue(true);
  mocks.sources.mockResolvedValue(undefined);
  mocks.reserve.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

function render(): RenderDocument {
  return {
    id: "r",
    organizationId: "org",
    status: "processing",
    engine: "legacy",
    publicSessionId: "storefront:visitor",
    createdAt: new Date("2026-09-30T10:00:00Z"),
    requestSnapshot: { version: 1, input: { workflow: "simple_point" } },
    execution: {
      token: "worker",
      deadlineAt: new Date("2026-09-30T10:30:00Z"),
    },
  } as RenderDocument;
}

describe("storefront worker hard stop", () => {
  it("aborts a slow provider at 180 seconds including queue time and ends without another attempt", async () => {
    const job = render();
    mocks.claim.mockResolvedValue(job);
    mocks.findOne.mockImplementation(async () => job);
    mocks.end.mockImplementation(async () => {
      job.status = "failed";
      return job;
    });
    let providerSignal: AbortSignal | undefined;
    mocks.execute.mockImplementation(async () => {
      providerSignal = durableAbortSignal(new AbortController().signal);
      await new Promise<void>((_resolve, reject) => {
        providerSignal!.addEventListener(
          "abort",
          () => reject(providerSignal!.reason),
          { once: true },
        );
      });
    });
    const work = runWorkerOnce({} as Db, "worker");
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.execute).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(providerSignal?.aborted).toBe(false);
    expect(mocks.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(work).resolves.toBe(true);
    expect(providerSignal?.aborted).toBe(true);
    expect(mocks.end).toHaveBeenCalledWith(
      expect.anything(),
      job,
      "failed",
      expect.stringContaining("3 minutes"),
      "deadline",
    );
    expect(mocks.retry).not.toHaveBeenCalled();
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not apply the shop's three-minute timer to a merchant render", async () => {
    const job = render();
    delete job.publicSessionId;
    mocks.claim.mockResolvedValue(job);
    let resolve!: () => void;
    mocks.execute.mockImplementation(async () => {
      await new Promise<void>((done) => {
        resolve = done;
      });
    });
    const work = runWorkerOnce({} as Db, "worker");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(mocks.end).not.toHaveBeenCalled();
    resolve();
    await expect(work).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
