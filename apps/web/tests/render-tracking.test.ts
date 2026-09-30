import { afterEach, describe, expect, it, vi } from "vitest";
import type { Render } from "@lili/types";

import { startRenderTracking } from "../lib/render-tracking";
import { ApiError, InvalidApiResponseError } from "../lib/api-errors";

const snapshot = (status: Render["status"]) =>
  ({ id: "render-1", status }) as Render;

afterEach(() => vi.useRealTimers());

describe("render tracking", () => {
  it.each([401, 403, 404, 410, 422])(
    "suspends automatic reads after HTTP %s, but permits a manual GET",
    async (status) => {
      vi.useFakeTimers();
      const fetchRender = vi
        .fn()
        .mockRejectedValueOnce(new ApiError("HTTP error", status))
        .mockResolvedValueOnce(snapshot("processing"));
      const onInterrupted = vi.fn();
      const onRender = vi.fn();
      const tracking = startRenderTracking({
        renderId: "render-1",
        fetchRender,
        onRender,
        onInterrupted,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(onInterrupted).toHaveBeenLastCalledWith(
        expect.objectContaining({
          automaticRetry: false,
          kind: status === 401 || status === 403 ? "access" : "unavailable",
        }),
      );
      expect(onRender).not.toHaveBeenCalled();
      tracking.resume();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(fetchRender).toHaveBeenCalledOnce();
      tracking.refresh();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchRender).toHaveBeenCalledTimes(2);
      expect(onInterrupted).toHaveBeenLastCalledWith(null);
      expect(onRender).toHaveBeenLastCalledWith(snapshot("processing"));
      tracking.stop();
    },
  );

  it("recovers from a malformed update without accepting it or restarting generation", async () => {
    vi.useFakeTimers();
    const fetchRender = vi
      .fn()
      .mockRejectedValueOnce(new InvalidApiResponseError())
      .mockResolvedValueOnce(snapshot("succeeded"));
    const onInterrupted = vi.fn();
    const onRender = vi.fn();
    const tracking = startRenderTracking({
      renderId: "render-1",
      fetchRender,
      onRender,
      onInterrupted,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchRender).toHaveBeenCalledOnce();
    expect(onRender).not.toHaveBeenCalled();
    expect(onInterrupted).toHaveBeenLastCalledWith(
      expect.objectContaining({
        automaticRetry: true,
        kind: "invalid_response",
      }),
    );
    await vi.advanceTimersByTimeAsync(3200);
    expect(fetchRender).toHaveBeenCalledTimes(2);
    expect(onInterrupted).toHaveBeenLastCalledWith(null);
    expect(onRender).toHaveBeenLastCalledWith(snapshot("succeeded"));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchRender).toHaveBeenCalledTimes(2);
    tracking.stop();
  });

  it.each([408, 429, 503])(
    "still retries transient HTTP %s",
    async (status) => {
      vi.useFakeTimers();
      const fetchRender = vi
        .fn()
        .mockRejectedValueOnce(new ApiError("Temporary", status))
        .mockResolvedValueOnce(snapshot("succeeded"));
      const onInterrupted = vi.fn();
      const tracking = startRenderTracking({
        renderId: "render-1",
        fetchRender,
        onRender: vi.fn(),
        onInterrupted,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(onInterrupted).toHaveBeenLastCalledWith(
        expect.objectContaining({ automaticRetry: true }),
      );
      await vi.advanceTimersByTimeAsync(3200);
      expect(fetchRender).toHaveBeenCalledTimes(2);
      tracking.stop();
    },
  );

  it("aborts a stalled GET after 15 seconds, then resumes status reads", async () => {
    vi.useFakeTimers();
    const fetchRender = vi
      .fn<(id: string, signal: AbortSignal) => Promise<Render>>()
      .mockImplementationOnce(
        (_id, signal) =>
          new Promise<Render>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          }),
      )
      .mockResolvedValueOnce(snapshot("succeeded"));
    const onInterrupted = vi.fn();
    const onRender = vi.fn();
    startRenderTracking({
      renderId: "render-1",
      fetchRender,
      onRender,
      onInterrupted,
    });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(fetchRender).toHaveBeenCalledOnce();
    expect(fetchRender.mock.calls[0]?.[1].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchRender.mock.calls[0]?.[1].aborted).toBe(true);
    expect(onInterrupted).toHaveBeenLastCalledWith(
      expect.objectContaining({ automaticRetry: true, kind: "connection" }),
    );
    await vi.advanceTimersByTimeAsync(3200);
    expect(fetchRender).toHaveBeenCalledTimes(2);
    expect(onRender).toHaveBeenLastCalledWith(snapshot("succeeded"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchRender).toHaveBeenCalledTimes(2);
  });

  it("never overlaps reads, including manual refreshes while a request is pending", async () => {
    vi.useFakeTimers();
    let resolve!: (value: Render) => void;
    const fetchRender = vi.fn(
      () =>
        new Promise<Render>((done) => {
          resolve = done;
        }),
    );
    const onRender = vi.fn();
    const tracking = startRenderTracking({
      renderId: "render-1",
      fetchRender,
      onRender,
      onInterrupted: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(0);
    tracking.refresh();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchRender).toHaveBeenCalledTimes(1);
    resolve(snapshot("processing"));
    await vi.advanceTimersByTimeAsync(0);
    expect(onRender).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1600);
    expect(fetchRender).toHaveBeenCalledTimes(2);
    tracking.stop();
  });

  it("recovers from a network error and stops after the terminal response", async () => {
    vi.useFakeTimers();
    const fetchRender = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(snapshot("processing"))
      .mockResolvedValueOnce(snapshot("succeeded"));
    const onInterrupted = vi.fn();
    const onRender = vi.fn();
    startRenderTracking({
      renderId: "render-1",
      fetchRender,
      onRender,
      onInterrupted,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(onInterrupted).toHaveBeenLastCalledWith(
      expect.objectContaining({ automaticRetry: true, kind: "connection" }),
    );
    await vi.advanceTimersByTimeAsync(3200);
    expect(onInterrupted).toHaveBeenLastCalledWith(null);
    expect(onRender).toHaveBeenLastCalledWith(snapshot("processing"));
    await vi.advanceTimersByTimeAsync(1600);
    expect(onRender).toHaveBeenLastCalledWith(snapshot("succeeded"));
    await vi.advanceTimersByTimeAsync(100_000);
    expect(fetchRender).toHaveBeenCalledTimes(3);
  });

  it("caps retry delays and allows an immediate manual status check", async () => {
    vi.useFakeTimers();
    const fetchRender = vi.fn().mockRejectedValue(new Error("offline"));
    const tracking = startRenderTracking({
      renderId: "render-1",
      fetchRender,
      onRender: vi.fn(),
      onInterrupted: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(0);
    for (const delay of [3200, 6400, 12800, 25600, 30000, 30000]) {
      const before = fetchRender.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(fetchRender.mock.calls.length).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchRender.mock.calls.length).toBe(before + 1);
    }
    const beforeRefresh = fetchRender.mock.calls.length;
    tracking.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchRender.mock.calls.length).toBe(beforeRefresh + 1);
    tracking.stop();
  });

  it("ignores an old in-flight response after reset or a change of render", async () => {
    vi.useFakeTimers();
    let resolve!: (value: Render) => void;
    const fetchRender = vi.fn<
      (id: string, signal: AbortSignal) => Promise<Render>
    >(
      () =>
        new Promise<Render>((done) => {
          resolve = done;
        }),
    );
    const onRender = vi.fn();
    const onInterrupted = vi.fn();
    const tracking = startRenderTracking({
      renderId: "render-1",
      fetchRender,
      onRender,
      onInterrupted,
    });
    await vi.advanceTimersByTimeAsync(0);
    tracking.stop();
    expect(fetchRender.mock.calls[0]?.[1].aborted).toBe(true);
    resolve(snapshot("succeeded"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onRender).not.toHaveBeenCalled();
    expect(onInterrupted).not.toHaveBeenCalled();
    expect(fetchRender).toHaveBeenCalledOnce();
  });
});
