import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  run: vi.fn(),
  schedule: vi.fn(),
}));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/server/vercel-render-worker", () => ({
  runVercelRenderWorker: mocks.run,
  scheduleVercelRenderWorker: mocks.schedule,
}));
import {
  GET,
  POST,
  runtime,
  maxDuration,
  dynamic,
} from "../app/api/cron/render-worker/route";
afterEach(() => vi.resetAllMocks());

describe("dedicated worker route", () => {
  it("keeps cron GET and the dedicated 800-second execution window", () => {
    expect(GET).toBe(mocks.run);
    expect(runtime).toBe("nodejs");
    expect(maxDuration).toBe(800);
    expect(dynamic).toBe("force-dynamic");
  });

  it("registers POST work with Next after instead of running it in the admission route", () => {
    const task = vi.fn().mockResolvedValue(undefined);
    mocks.schedule.mockImplementation((_request, schedule) => {
      schedule(task);
      return new Response(null, { status: 202 });
    });
    const request = new Request("https://example.test/api/cron/render-worker", {
      method: "POST",
    });
    expect(POST(request).status).toBe(202);
    expect(mocks.schedule).toHaveBeenCalledWith(request, expect.any(Function));
    expect(mocks.after).toHaveBeenCalledWith(task);
    expect(task).not.toHaveBeenCalled();
  });
});
