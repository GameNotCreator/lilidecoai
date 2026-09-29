import { afterEach, describe, expect, it, vi } from "vitest";

import { api, getRender, ApiError, InvalidApiResponseError } from "../lib/api";

afterEach(() => vi.unstubAllGlobals());

describe("client API errors", () => {
  it("preserves HTTP status and the existing user-facing error detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ detail: "Accès indisponible" }), {
            status: 403,
          }),
        ),
    );
    await expect(api("/v1/renders/test")).rejects.toMatchObject({
      name: "ApiError",
      status: 403,
      message: "Accès indisponible",
    });
    expect(new ApiError("test", 404)).toBeInstanceOf(Error);
  });

  it.each(["not-json", JSON.stringify({ status: "invented-state" })])(
    "identifies an unusable render response: %s",
    async (body) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(body, { status: 200 })),
      );
      await expect(getRender("test")).rejects.toBeInstanceOf(
        InvalidApiResponseError,
      );
    },
  );

  it("still parses a valid response and forwards cancellation to the GET", async () => {
    const response = {
      id: "00000000-0000-4000-8000-000000000099",
      status: "processing",
      provider: "openai",
      model: "image",
      requestedSize: "1024x1024",
      resultUrl: null,
      qualityScore: null,
      creditCharged: false,
      createdAt: "2026-09-22T12:00:00Z",
    };
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(response)));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    await expect(
      getRender(response.id, controller.signal),
    ).resolves.toMatchObject(response);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/v1/renders/${response.id}`),
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
