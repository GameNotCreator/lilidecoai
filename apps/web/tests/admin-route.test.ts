import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), database: vi.fn(), organization: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/config", () => ({ serverConfig: {} }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("../lib/server/admin-auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/server/admin-auth")>(),
  requireAdminRequest: mocks.authenticate,
}));
vi.mock("../lib/server/admin-products", () => ({
  AdminProductError: class extends Error {}, resolveAdminOrganization: mocks.organization,
}));
vi.mock("../lib/server/assets", () => ({ ApiInputError: class extends Error {} }));
vi.mock("../lib/server/mongodb", () => ({ database: mocks.database }));
vi.mock("../lib/server/rate-limit", () => ({ RateLimitError: class extends Error {} }));

import { withAdmin } from "../lib/server/admin-route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticate.mockResolvedValue({ username: "LiliDeco", issuedAt: 0 });
  mocks.database.mockResolvedValue({ database: true });
  mocks.organization.mockResolvedValue({ id: "storefront" });
});

describe("administrator mutation origin guard", () => {
  it("rejects foreign same-site multipart uploads before authentication, database access or mutation", async () => {
    const handler = vi.fn(async () => Response.json({ changed: true }));
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const body = new FormData();
      body.append("name", "untrusted product");
      const request = new Request("https://shop.example.test/api/admin/products", {
        method, body, headers: { origin: "https://other.example.test", "sec-fetch-site": "same-site" },
      });
      const response = await withAdmin(request, handler);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ detail: "Origine de la requête refusée" });
    }
    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(mocks.database).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses a missing origin for mutation and accepts the exact site", async () => {
    const handler = vi.fn(async context => Response.json({ username: context.session.username }));
    const url = "https://shop.example.test/api/admin/products";
    expect((await withAdmin(new Request(url, { method: "PATCH" }), handler)).status).toBe(403);
    const response = await withAdmin(new Request(url, {
      method: "PATCH", headers: { origin: "https://shop.example.test" },
    }), handler);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ username: "LiliDeco" });
    expect(mocks.authenticate).toHaveBeenCalledTimes(1);
    expect(mocks.database).toHaveBeenCalledTimes(1);
    expect(mocks.organization).toHaveBeenCalledWith({ database: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("still authenticates reads without requiring an Origin header", async () => {
    const handler = vi.fn(async () => Response.json({ products: [] }));
    const response = await withAdmin(new Request("https://shop.example.test/api/admin/products"), handler);
    expect(response.status).toBe(200);
    expect(mocks.authenticate).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
