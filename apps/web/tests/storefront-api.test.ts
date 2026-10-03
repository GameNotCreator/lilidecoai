import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

it("renews an expired signed session once for a status GET without generating an image", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(response({ accessToken: "first" }))
    .mockResolvedValueOnce(response({ detail: "Expired" }, 401))
    .mockResolvedValueOnce(response({ accessToken: "renewed" }))
    .mockResolvedValueOnce(
      response({ id: "existing-render", status: "processing" }),
    );
  vi.stubGlobal("fetch", fetch);
  const { storefrontApi } = await import("../lib/storefront-api");
  expect(await storefrontApi("/v1/renders/existing-render")).toMatchObject({
    status: "processing",
  });
  expect(fetch.mock.calls.map((call) => call[0])).toEqual([
    "/api/storefront/session",
    "/v1/renders/existing-render",
    "/api/storefront/session",
    "/v1/renders/existing-render",
  ]);
  expect(fetch.mock.calls[3]?.[1].headers.get("Authorization")).toBe(
    "Bearer renewed",
  );
  expect(fetch.mock.calls[3]?.[1].cache).toBe("no-store");
});

it("does not automatically repeat a paid POST on 401", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(response({ accessToken: "first" }))
    .mockResolvedValueOnce(response({ detail: "Expired" }, 401));
  vi.stubGlobal("fetch", fetch);
  const { storefrontApi } = await import("../lib/storefront-api");
  await expect(
    storefrontApi("/v1/renders/final", { method: "POST", body: "{}" }),
  ).rejects.toMatchObject({ status: 401 });
  expect(fetch).toHaveBeenCalledTimes(2);
});
