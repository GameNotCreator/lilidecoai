import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, InvalidApiResponseError } from "../lib/api";
import {
  findSpatialSubmission,
  sendSpatialSubmission,
} from "../lib/spatial-submission";
import {
  spatialInsertionSubmissionSchema,
  spatialStudioDraftSchema,
} from "../lib/spatial-studio-draft";
import { spatialRetrySubmissionSchema } from "../lib/spatial-retry";

const request = spatialInsertionSubmissionSchema.parse({
  engine: "spatial",
  placement: {
    sceneId: "22222222-2222-4222-8222-222222222222",
    productId: "11111111-1111-4111-8111-111111111111",
  },
  placementPoint: { x: 0.4, y: 0.8 },
  surfaceType: "floor",
  idempotencyKey: "web-stable-key",
  userInstructions: "same placement",
  quality: "high",
});
const rendered = {
  id: "33333333-3333-4333-8333-333333333333",
  engine: "spatial",
  status: "queued",
  placement: request.placement,
  provider: null,
  model: null,
  requestedSize: "auto",
  resultUrl: null,
  qualityScore: null,
  creditCharged: false,
  createdAt: new Date().toISOString(),
};
afterEach(() => vi.useRealTimers());
describe("spatial request recovery", () => {
  it("does not accept the parent render as a completed retry lookup", async () => {
    const retry = spatialRetrySubmissionSchema.parse({
      kind: "retry",
      sourceRenderId: rendered.id,
      idempotencyKey: `retry:${rendered.id}:${crypto.randomUUID()}`,
      placement: request.placement,
    });
    const api = vi.fn().mockResolvedValue(rendered);
    await expect(sendSpatialSubmission(retry, api)).rejects.toBeInstanceOf(
      InvalidApiResponseError,
    );
    expect(api).toHaveBeenCalledOnce();
  });
  it.each([true, false])(
    "recovers a retry with the same key after a lost response (admitted=%s)",
    async (admitted) => {
      const retry = spatialRetrySubmissionSchema.parse({
        kind: "retry",
        sourceRenderId: rendered.id,
        idempotencyKey: `retry:${rendered.id}:${crypto.randomUUID()}`,
        placement: request.placement,
      });
      const result = {
        ...rendered,
        id: "44444444-4444-4444-8444-444444444444",
      };
      const api = vi
        .fn()
        .mockRejectedValueOnce(new ApiError("missing", 404))
        .mockRejectedValueOnce(new Error("response lost"));
      if (admitted) api.mockResolvedValueOnce(result);
      else
        api
          .mockRejectedValueOnce(new ApiError("missing", 404))
          .mockResolvedValueOnce(result);
      await expect(sendSpatialSubmission(retry, api)).rejects.toThrow(
        "response lost",
      );
      expect(await sendSpatialSubmission(retry, api)).toMatchObject({
        id: result.id,
      });
      const posts = api.mock.calls.filter((call) => call[1]?.method === "POST");
      expect(posts).toHaveLength(admitted ? 1 : 2);
      for (const [path, options] of posts) {
        expect(path).toBe(`/v1/renders/${rendered.id}/retry`);
        expect(JSON.parse(options.body)).toEqual({
          idempotencyKey: retry.idempotencyKey,
        });
      }
    },
  );
  it("reads a missing request without submitting anything", async () => {
    const api = vi.fn().mockRejectedValue(new ApiError("not yet", 404));
    expect(await findSpatialSubmission(request, api)).toBeNull();
    expect(api).toHaveBeenCalledOnce();
    expect(api.mock.calls[0]![1]).toMatchObject({ cache: "no-store" });
  });
  it("recovers a lost response without repeating its POST", async () => {
    const api = vi
      .fn()
      .mockRejectedValueOnce(new ApiError("missing", 404))
      .mockRejectedValueOnce(new TypeError("connection lost"))
      .mockResolvedValueOnce(rendered);
    await expect(sendSpatialSubmission(request, api)).rejects.toThrow(
      "connection lost",
    );
    expect(await sendSpatialSubmission(request, api)).toMatchObject({
      id: rendered.id,
    });
    const posts = api.mock.calls.filter((call) => call[1]?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]![1].body)).toEqual(request);
  });
  it("uses the same frozen payload and key on an explicit resend when still missing", async () => {
    const api = vi
      .fn()
      .mockRejectedValueOnce(new ApiError("missing", 404))
      .mockRejectedValueOnce(new TypeError("lost before admission"))
      .mockRejectedValueOnce(new ApiError("missing", 404))
      .mockResolvedValueOnce(rendered);
    await expect(sendSpatialSubmission(request, api)).rejects.toThrow();
    await sendSpatialSubmission(request, api);
    const bodies = api.mock.calls
      .filter((call) => call[1]?.method === "POST")
      .map((call) => call[1].body);
    expect(bodies).toEqual([JSON.stringify(request), JSON.stringify(request)]);
  });
  it.each([401, 403, 429, 500, 503])(
    "does not POST after lookup HTTP %s",
    async (status) => {
      const api = vi.fn().mockRejectedValue(new ApiError("denied", status));
      await expect(sendSpatialSubmission(request, api)).rejects.toThrow();
      expect(api).toHaveBeenCalledOnce();
    },
  );
  it.each([
    {},
    { ...rendered, engine: "legacy" },
    { ...rendered, placement: { ...request.placement, sceneId: "foreign" } },
    { ...rendered, placement: { ...request.placement, productId: "foreign" } },
  ])("rejects an inconsistent lookup without POST", async (value) => {
    const api = vi.fn().mockResolvedValue(value);
    await expect(sendSpatialSubmission(request, api)).rejects.toBeInstanceOf(
      InvalidApiResponseError,
    );
    expect(api).toHaveBeenCalledOnce();
  });
  it("bounds a hung lookup without starting a second call", async () => {
    vi.useFakeTimers();
    const api = vi
      .fn()
      .mockImplementation(
        (_path, init) =>
          new Promise((_resolve, reject) =>
            init.signal.addEventListener("abort", () =>
              reject(new Error("aborted")),
            ),
          ),
      );
    const outcome = expect(sendSpatialSubmission(request, api)).rejects.toThrow(
      "aborted",
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await outcome;
    expect(api).toHaveBeenCalledOnce();
  });
  it("refuses a pending request for a different draft or engine", () => {
    const draft = {
      version: 3,
      savedAt: Date.now(),
      sceneId: request.placement.sceneId,
      productId: request.placement.productId,
      surface: "floor",
      point: request.placementPoint,
      yaw: 0,
      instructions: "",
      pendingRequest: request,
    };
    expect(spatialStudioDraftSchema.safeParse(draft).success).toBe(true);
    expect(
      spatialStudioDraftSchema.safeParse({ ...draft, sceneId: rendered.id })
        .success,
    ).toBe(false);
    expect(
      spatialStudioDraftSchema.safeParse({ ...draft, renderId: rendered.id })
        .success,
    ).toBe(false);
    expect(
      spatialStudioDraftSchema.safeParse({
        ...draft,
        pendingRequest: { ...request, engine: "legacy" },
      }).success,
    ).toBe(false);
  });
});
