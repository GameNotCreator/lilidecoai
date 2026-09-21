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
import { runVercelRenderWorker } from "../lib/server/vercel-render-worker";
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
});
