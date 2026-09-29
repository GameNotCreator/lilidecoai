import { afterEach, expect, it, vi } from "vitest";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
it("uses the merchant cookie without replacing the retained public session", async () => {
  const fetch = vi
    .fn()
    .mockImplementation(async () =>
      Response.json({ accessToken: "public-token" }),
    );
  vi.stubGlobal("fetch", fetch);
  const { api, merchantApi, establishPublicSession } =
    await import("../lib/api");
  await establishPublicSession("shop", "product");
  await merchantApi("/v1/scenes", {
    headers: new Headers({ "X-Test": "kept" }),
  });
  expect(fetch.mock.calls.at(-1)![1].headers).toMatchObject({
    Authorization: "",
    "x-test": "kept",
  });
  await api("/v1/products");
  expect(fetch.mock.calls.at(-1)![1].headers.Authorization).toBe(
    "Bearer public-token",
  );
});
