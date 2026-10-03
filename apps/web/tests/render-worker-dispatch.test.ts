import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "mongodb";
import type { RenderDocument } from "../lib/server/types";
import { mongoStore } from "./helpers/mongo-store";

const mocks = vi.hoisted(() => ({
  config: { cronSecret: "test-cron-only" as string | undefined },
  enabled: vi.fn(),
  collections: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/config", () => ({ serverConfig: mocks.config }));
vi.mock("../lib/server/durable-queue", () => ({
  durableEnabled: mocks.enabled,
}));
vi.mock("../lib/server/mongodb", () => ({ collections: mocks.collections }));

import {
  dispatchRenderWorker,
  dispatchQueuedRender,
  renderWorkerDispatchUrl,
  RENDER_WORKER_DISPATCH_TIMEOUT_MS,
} from "../lib/server/render-worker-dispatch";

beforeEach(() => {
  vi.stubEnv("RENDER_WORKER_ORIGIN", "");
  vi.stubEnv("VERCEL_URL", "");
  vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "");
  mocks.config.cronSecret = "test-cron-only";
  mocks.enabled.mockReturnValue(true);
});

describe("refresh recovery of a queued render", () => {
  function queued(): RenderDocument {
    return { id: "r", organizationId: "org", status: "queued", execution: {
      deadlineAt: new Date(Date.now() + 180_000), availableAt: new Date(0),
    } } as RenderDocument;
  }
  it("coalesces simultaneous refreshes and never submits a generation payload", async () => {
    const render = queued();
    const renders = mongoStore();
    renders.rows.push(structuredClone(render) as unknown as Record<string, unknown>);
    mocks.collections.mockReturnValue({ renders });
    vi.stubEnv("VERCEL_URL", "lili-team.vercel.app");
    const fetch = vi.fn().mockImplementation(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetch);
    const result = await Promise.all([dispatchQueuedRender({} as Db, render), dispatchQueuedRender({} as Db, render)]);
    expect(result.filter(Boolean)).toHaveLength(1);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![1]).not.toHaveProperty("body");
  });
  it("does not wake completed, processing, delayed or expired jobs", async () => {
    for (const mode of ["succeeded", "processing", "delayed", "expired"]) {
      const render = queued();
      if (mode === "delayed") render.execution!.availableAt = new Date(Date.now() + 5_000);
      else if (mode === "expired") render.execution!.deadlineAt = new Date(0);
      else render.status = mode as RenderDocument["status"];
      expect(await dispatchQueuedRender({} as Db, render)).toBe(false);
    }
    expect(mocks.collections).not.toHaveBeenCalled();
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("trusted worker target", () => {
  it("uses the immutable Vercel deployment rather than a request hostname", () => {
    vi.stubEnv("VERCEL_URL", "lili-a1b2-team.vercel.app");
    expect(renderWorkerDispatchUrl()?.href).toBe(
      "https://lili-a1b2-team.vercel.app/api/cron/render-worker",
    );
  });

  it("allows a server-configured HTTPS origin and takes precedence over Vercel", () => {
    vi.stubEnv("RENDER_WORKER_ORIGIN", "https://worker.example.com/");
    vi.stubEnv("VERCEL_URL", "other.vercel.app");
    expect(renderWorkerDispatchUrl()?.href).toBe(
      "https://worker.example.com/api/cron/render-worker",
    );
  });

  it.each([
    "http://worker.example.com",
    "https://user:pass@worker.example.com",
    "https://worker.example.com/path",
    "https://worker.example.com/?token=secret",
    "https://worker.example.com/#fragment",
    "https://worker.example.com:8443",
    "https://127.0.0.1",
    "https://[::1]",
    "https://169.254.169.254",
    "https://2130706433",
    "https://localhost",
    "https://worker.local",
    "https://metadata.internal",
    "https://worker.example.com.",
    "file:///tmp/worker",
    "not a URL",
  ])("rejects unsafe or non-origin configuration %s", (origin) => {
    vi.stubEnv("RENDER_WORKER_ORIGIN", origin);
    vi.stubEnv("VERCEL_URL", "valid.vercel.app");
    expect(renderWorkerDispatchUrl()).toBeNull();
  });

  it.each([
    "https://valid.vercel.app",
    "valid.vercel.app.evil.com",
    "127.0.0.1",
    "valid.vercel.app/path",
    "valid.vercel.app?next=evil",
    "user@valid.vercel.app",
  ])("rejects malformed VERCEL_URL %s", (host) => {
    vi.stubEnv("VERCEL_URL", host);
    expect(renderWorkerDispatchUrl()).toBeNull();
  });
});

describe("best effort immediate wakeup", () => {
  it("sends only server credentials to the dedicated POST with a short deadline and no redirects", async () => {
    vi.stubEnv("VERCEL_URL", "lili-team.vercel.app");
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ scheduled: true }, { status: 202 }));
    vi.stubGlobal("fetch", fetch);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    expect(await dispatchRenderWorker()).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://lili-team.vercel.app/api/cron/render-worker"),
      {
        method: "POST",
        headers: { Authorization: "Bearer test-cron-only" },
        redirect: "error",
        cache: "no-store",
        signal: expect.any(AbortSignal),
      },
    );
    expect(timeout).toHaveBeenCalledWith(RENDER_WORKER_DISPATCH_TIMEOUT_MS);
    expect(RENDER_WORKER_DISPATCH_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });

  it("forwards the optional deployment-protection secret only to Vercel", async () => {
    vi.stubEnv("VERCEL_URL", "lili-team.vercel.app");
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "test-bypass");
    const fetch = vi
      .fn()
      .mockImplementation(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetch);
    expect(await dispatchRenderWorker()).toBe(true);
    expect(fetch.mock.calls[0]![1].headers).toMatchObject({
      "x-vercel-protection-bypass": "test-bypass",
    });
    vi.stubEnv("RENDER_WORKER_ORIGIN", "https://worker.example.com");
    expect(await dispatchRenderWorker()).toBe(true);
    expect(fetch.mock.calls[1]![1].headers).not.toHaveProperty(
      "x-vercel-protection-bypass",
    );
  });

  it.each(["disabled", "no-secret", "no-origin", "invalid-origin"])(
    "is a silent no-op when %s",
    async (mode) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      if (mode !== "no-origin")
        vi.stubEnv("VERCEL_URL", "lili-team.vercel.app");
      if (mode === "disabled") mocks.enabled.mockReturnValue(false);
      if (mode === "no-secret") mocks.config.cronSecret = undefined;
      if (mode === "invalid-origin")
        vi.stubEnv("RENDER_WORKER_ORIGIN", "http://localhost");
      expect(await dispatchRenderWorker()).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([200, 301, 401, 403, 429, 500, 503])(
    "does not consider HTTP %s an accepted kick",
    async (status) => {
      vi.stubEnv("VERCEL_URL", "lili-team.vercel.app");
      const fetch = vi
        .fn()
        .mockResolvedValue(new Response("private diagnostics", { status }));
      vi.stubGlobal("fetch", fetch);
      expect(await dispatchRenderWorker()).toBe(false);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it.each([
    new Error("network credentials must not leak"),
    new DOMException("timeout", "TimeoutError"),
  ])(
    "contains network errors and timeouts without logging secrets",
    async (reason) => {
      vi.stubEnv("VERCEL_URL", "lili-team.vercel.app");
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(reason));
      const error = vi.spyOn(console, "error");
      const warn = vi.spyOn(console, "warn");
      const info = vi.spyOn(console, "info");
      expect(await dispatchRenderWorker()).toBe(false);
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledWith("render_worker_dispatch", {
        status: "unavailable",
      });
    },
  );
  it("makes incomplete production configuration observable without logging credentials", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const info = vi.spyOn(console, "info");
    expect(await dispatchRenderWorker()).toBe(false);
    expect(info).toHaveBeenCalledWith("render_worker_dispatch", {
      status: "skipped",
      reason: "unconfigured",
    });
  });
});
