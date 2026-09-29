import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  database: vi.fn(),
  assert: vi.fn(),
  expire: vi.fn(),
  run: vi.fn(),
  enabled: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/config", () => ({
  serverConfig: { cronSecret: "test-cron-only" },
}));
vi.mock("../lib/server/mongodb", () => ({ database: mocks.database }));
vi.mock("../lib/server/render-worker", () => ({ runWorkerOnce: mocks.run }));
vi.mock("../lib/server/durable-queue", () => ({
  assertDurableDatabase: mocks.assert,
  expireDurableRenders: mocks.expire,
  durableEnabled: mocks.enabled,
  boundedSetting: () => 2,
}));
import {
  runVercelRenderWorker,
  scheduleVercelRenderWorker,
} from "../lib/server/vercel-render-worker";
afterEach(() => vi.resetAllMocks());
const request = () =>
  new Request("https://example.test/api/cron/render-worker", {
    headers: { authorization: "Bearer test-cron-only" },
  });
describe("Vercel worker scheduler", () => {
  it("rejects unauthenticated execution before database access", async () => {
    expect(
      (await runVercelRenderWorker(new Request("https://example.test"))).status,
    ).toBe(401);
    expect(mocks.database).not.toHaveBeenCalled();
  });
  it("never starts work when the durable switch is off", async () => {
    mocks.enabled.mockReturnValue(false);
    expect(await (await runVercelRenderWorker(request())).json()).toEqual({
      enabled: false,
    });
    expect(mocks.database).not.toHaveBeenCalled();
  });
  it("runs two bounded slices and reports partial infrastructure failure", async () => {
    const db = {};
    mocks.enabled.mockReturnValue(true);
    mocks.database.mockResolvedValue(db);
    mocks.expire.mockResolvedValue(0);
    mocks.run
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("temporary"));
    const response = await runVercelRenderWorker(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      enabled: true,
      expired: 0,
      processed: 1,
      errors: 1,
    });
    expect(mocks.run).toHaveBeenCalledTimes(2);
    expect(mocks.run).toHaveBeenCalledWith(
      db,
      expect.stringMatching(/^vercel:/),
      { yieldAfterMs: 300_000 },
    );
  });
  it("authenticates POST before scheduling background work", () => {
    const schedule = vi.fn();
    expect(
      scheduleVercelRenderWorker(
        new Request("https://example.test", { method: "POST" }),
        schedule,
      ).status,
    ).toBe(401);
    expect(schedule).not.toHaveBeenCalled();
    expect(mocks.database).not.toHaveBeenCalled();
  });
  it("does not schedule POST work when durable mode is disabled", async () => {
    mocks.enabled.mockReturnValue(false);
    const schedule = vi.fn();
    const response = scheduleVercelRenderWorker(request(), schedule);
    expect(await response.json()).toEqual({ enabled: false });
    expect(schedule).not.toHaveBeenCalled();
  });
  it("acknowledges the kick before starting the same checked bounded batch", async () => {
    mocks.enabled.mockReturnValue(true);
    const db = {};
    mocks.database.mockResolvedValue(db);
    mocks.expire.mockResolvedValue(1);
    mocks.run.mockResolvedValue(true);
    const tasks: Array<() => Promise<void>> = [];
    const response = scheduleVercelRenderWorker(request(), (task) =>
      tasks.push(task),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ enabled: true, scheduled: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.database).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(1);
    await tasks[0]!();
    expect(mocks.assert).toHaveBeenCalledWith(db);
    expect(mocks.expire).toHaveBeenCalledWith(db);
    expect(mocks.run).toHaveBeenCalledTimes(2);
    expect(mocks.run).toHaveBeenCalledWith(
      db,
      expect.stringMatching(/^vercel:/),
      { yieldAfterMs: 300_000 },
    );
    expect(mocks.assert.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.run.mock.invocationCallOrder[0]!,
    );
  });
  it("contains a post-response infrastructure failure without logging its secrets", async () => {
    mocks.enabled.mockReturnValue(true);
    mocks.database.mockRejectedValue(new Error("connection-secret"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const tasks: Array<() => Promise<void>> = [];
    expect(
      scheduleVercelRenderWorker(request(), (task) => tasks.push(task)).status,
    ).toBe(202);
    await expect(tasks[0]!()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith("render_worker_kick_failed");
    expect(mocks.run).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
