import { afterEach, describe, expect, it, vi } from "vitest";
import type { RenderDocument, SceneDocument } from "../lib/server/types";

vi.mock("server-only", () => ({}));
vi.mock("../lib/server/config", () => ({
  serverConfig: { aiMockMode: false },
}));

import { prepareExecution } from "../lib/server/durable-queue";
import {
  durableAbortSignal,
  durableContext,
  executionFence,
  renderDeadline,
} from "../lib/server/durable-context";
import {
  effectiveRenderDeadline,
  isTimedStorefrontRender,
  storefrontRenderDeadlineExpired,
} from "../lib/server/storefront-render-deadline";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function storefront(): RenderDocument {
  return {
    id: "render",
    engine: "legacy",
    publicSessionId: "storefront:visitor",
    createdAt: new Date("2026-09-30T10:00:00Z"),
    requestSnapshot: { version: 1, input: { workflow: "simple_point" } },
  } as RenderDocument;
}
const scene = {
  assetId: "room",
  expiresAt: new Date("2026-10-01T10:00:00Z"),
} as SceneDocument;

describe("storefront admission deadline", () => {
  it("starts the three-minute budget at admission, including time already spent preparing or queued", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T10:00:45Z"));
    const render = storefront();
    render.execution = prepareExecution(scene, [], render);
    expect(render.execution.deadlineAt.toISOString()).toBe(
      "2026-09-30T10:03:00.000Z",
    );
    expect(effectiveRenderDeadline(render) - Date.now()).toBe(135_000);
    expect(storefrontRenderDeadlineExpired(render)).toBe(false);
    vi.advanceTimersByTime(135_000);
    expect(storefrontRenderDeadlineExpired(render)).toBe(true);
  });
  it("does not admit an already exhausted budget", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T10:03:00Z"));
    expect(() => prepareExecution(scene, [], storefront())).toThrow(
      "3 minutes",
    );
  });
  it.each([
    { publicSessionId: undefined },
    { publicSessionId: "guest:visitor" },
    { publicSessionId: "public-widget-session" },
    { engine: "spatial" },
    { requestSnapshot: { version: 1, input: { workflow: "standard" } } },
  ])(
    "preserves the configured merchant, guest and spatial deadline: %j",
    (change) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-30T10:00:45Z"));
      const render = { ...storefront(), ...change } as RenderDocument;
      expect(isTimedStorefrontRender(render)).toBe(false);
      render.execution = prepareExecution(scene, [], render);
      expect(render.execution.deadlineAt.getTime() - Date.now()).toBe(
        1_800_000,
      );
    },
  );
  it("refuses paid-step fences and late finalization at the exact deadline", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T10:00:00Z"));
    const render = storefront();
    render.execution = prepareExecution(scene, [], render);
    durableContext.run({ render, token: "worker" }, () => {
      expect(renderDeadline(Date.now())).toBe(
        render.createdAt.getTime() + 180_000,
      );
      expect(() => executionFence(render.id)).not.toThrow();
      vi.advanceTimersByTime(180_000);
      expect(() => executionFence(render.id)).toThrow("3 minutes");
    });
  });
  it("combines the provider timeout with the worker stop signal", () => {
    const local = new AbortController();
    const worker = new AbortController();
    const signal = durableContext.run(
      { render: storefront(), token: "worker", signal: worker.signal },
      () => durableAbortSignal(local.signal),
    );
    expect(signal?.aborted).toBe(false);
    worker.abort("deadline");
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBe("deadline");
    expect(local.signal.aborted).toBe(false);
    expect(durableAbortSignal(local.signal)).toBe(local.signal);
  });
});
