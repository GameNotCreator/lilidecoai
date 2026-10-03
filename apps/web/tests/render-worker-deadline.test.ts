import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "mongodb";
import type { RenderDocument } from "../lib/server/types";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(), heartbeat: vi.fn(), reserve: vi.fn(), validate: vi.fn(),
  end: vi.fn(), retry: vi.fn(), reconcile: vi.fn(), execute: vi.fn(),
  find: vi.fn(), prepared: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/durable-queue", () => ({
  claimRender: mocks.claim, heartbeat: mocks.heartbeat,
  reserveDurableCredit: mocks.reserve, validateExecutionSources: mocks.validate,
  endDurableRender: mocks.end, retryDurableRender: mocks.retry,
  reconcileRenderDeadline: mocks.reconcile,
}));
vi.mock("../lib/server/rendering", () => ({ executeDurableRender: mocks.execute }));
vi.mock("../lib/server/mongodb", () => ({ collections: () => ({ renders: { findOne: mocks.find } }) }));
vi.mock("../lib/server/prepared-view-tasks", () => ({ runPreparedViewTasks: mocks.prepared }));

import { runWorkerOnce } from "../lib/server/render-worker";

const db = {} as Db;
let render: RenderDocument;
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  render = { id: "render", organizationId: "org", status: "processing",
    execution: { token: "lease", deadlineAt: new Date(Date.now() + 180_000) },
  } as RenderDocument;
  mocks.claim.mockResolvedValue(render);
  mocks.heartbeat.mockResolvedValue(true);
  mocks.find.mockImplementation(async () => render);
  mocks.reconcile.mockImplementation(async () => {
    render.status = "failed";
    render.execution!.errorCode = "deadline";
    return render;
  });
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("worker end-to-end deadline", () => {
  it("settles an expired render even while its provider promise remains pending", async () => {
    let finish!: () => void;
    mocks.execute.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const work = runWorkerOnce(db, "worker");
    await vi.advanceTimersByTimeAsync(179_999);
    expect(mocks.reconcile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(work).resolves.toBe(true);
    expect(mocks.reconcile).toHaveBeenCalledExactlyOnceWith(db, render);
    expect(render.status).toBe("failed");
    finish();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.reconcile).toHaveBeenCalledOnce();
    expect(mocks.retry).not.toHaveBeenCalled();
  });

  it("does not leave a timer that expires an already completed render", async () => {
    mocks.execute.mockImplementation(async () => { render.status = "succeeded"; });
    await expect(runWorkerOnce(db, "worker")).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(render.status).toBe("succeeded");
  });

  it("a retryable error arriving at the deadline ends the job instead of re-queuing it", async () => {
    mocks.execute.mockImplementation(async () => {
      render.execution!.deadlineAt = new Date(Date.now() - 1);
      throw new Error("provider transport failed");
    });
    await expect(runWorkerOnce(db, "worker")).resolves.toBe(true);
    expect(mocks.reconcile).toHaveBeenCalledExactlyOnceWith(db, render);
    expect(mocks.retry).not.toHaveBeenCalled();
  });
});
