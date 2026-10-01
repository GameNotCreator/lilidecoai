import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), database: vi.fn(), resolve: vi.fn(), organization: vi.fn(),
  getBudget: vi.fn(), grant: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/admin-auth", async (original) => ({
  ...await original<object>(), requireAdminRequest: mocks.auth,
}));
vi.mock("../lib/server/mongodb", () => ({ database: mocks.database }));
vi.mock("../lib/server/admin-products", async (original) => ({
  ...await original<object>(), resolveAdminOrganization: mocks.resolve,
}));
vi.mock("../lib/server/storefront", () => ({ storefrontOrganization: mocks.organization }));
vi.mock("../lib/server/admin-visualization-budget", async (original) => ({
  ...await original<object>(),
  getVisualizationBudget: mocks.getBudget,
  grantVisualizationCapacity: mocks.grant,
}));

import { AdminAuthError } from "../lib/server/admin-auth";
import { GET, POST } from "../app/api/admin/visualization-budget/route";

const url = "https://shop.test/api/admin/visualization-budget";
const idempotencyKey = "00000000-0000-4000-8000-000000000030";
const budget = { balance: 3, reserved: 1, maxCostPerRenderUsd: 2 };
const db = {};
const post = (body: unknown, origin = "https://shop.test") => new Request(url, {
  method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ username: "LiliDeco" });
  mocks.database.mockResolvedValue(db);
  mocks.resolve.mockResolvedValue({ id: "managed-shop" });
  mocks.organization.mockResolvedValue({ id: "managed-shop" });
  mocks.getBudget.mockResolvedValue(budget);
  mocks.grant.mockResolvedValue(budget);
});

describe("back-office visualization capacity route", () => {
  it.each(["GET", "POST"])("requires an administrator before %s accesses the database", async (method) => {
    mocks.auth.mockRejectedValue(new AdminAuthError("Connexion requise", 401));
    const response = method === "GET"
      ? await GET(new Request(url))
      : await POST(post({ credits: 3, idempotencyKey }));
    expect(response.status).toBe(401);
    expect(mocks.database).not.toHaveBeenCalled();
    expect(mocks.getBudget).not.toHaveBeenCalled();
    expect(mocks.grant).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin grant before authentication or database work", async () => {
    expect((await POST(post({ credits: 3, idempotencyKey }, "https://other.test"))).status).toBe(403);
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.database).not.toHaveBeenCalled();
    expect(mocks.grant).not.toHaveBeenCalled();
  });

  it("reads only the managed shop without creating an organization or granting capacity", async () => {
    const response = await GET(new Request(url + "?organizationId=other"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(budget);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(mocks.getBudget).toHaveBeenCalledWith(db, "managed-shop");
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.grant).not.toHaveBeenCalled();
  });

  it("keeps an empty installation read-only", async () => {
    mocks.organization.mockResolvedValue(null);
    mocks.getBudget.mockResolvedValue({ balance: 0, reserved: 0, maxCostPerRenderUsd: 2 });
    expect(await (await GET(new Request(url))).json()).toEqual({ balance: 0, reserved: 0, maxCostPerRenderUsd: 2 });
    expect(mocks.getBudget).toHaveBeenCalledWith(db, undefined);
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.grant).not.toHaveBeenCalled();
  });

  it("passes an explicit bounded grant to the managed organization and authenticated actor", async () => {
    const response = await POST(post({ credits: 3, idempotencyKey }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(budget);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(mocks.grant).toHaveBeenCalledWith(db, "managed-shop", { credits: 3, idempotencyKey }, "LiliDeco");
  });

  it.each([
    { credits: 0, idempotencyKey },
    { credits: 4, idempotencyKey },
    { credits: 1.5, idempotencyKey },
    { credits: "3", idempotencyKey },
    { credits: 3, idempotencyKey: "not-a-uuid" },
    { credits: 3, idempotencyKey, organizationId: "other" },
  ])("rejects invalid or cross-organization grant input before the service: %j", async (body) => {
    expect((await POST(post(body))).status).toBe(422);
    expect(mocks.grant).not.toHaveBeenCalled();
  });
});
