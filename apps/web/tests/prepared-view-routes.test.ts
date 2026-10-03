import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), database: vi.fn(), organization: vi.fn(),
  list: vi.fn(), queue: vi.fn(), review: vi.fn(), revoke: vi.fn(), tasks: vi.fn(), retryMatte: vi.fn(), matteAvailability: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/config", () => ({ serverConfig: {} }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("../lib/server/admin-auth", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/server/admin-auth")>(), requireAdminRequest: mocks.authenticate,
}));
vi.mock("../lib/server/admin-products", () => ({
  AdminProductError: class extends Error { constructor(message: string, readonly status = 422) { super(message); } },
  resolveAdminOrganization: mocks.organization,
}));
vi.mock("../lib/server/assets", () => ({ ApiInputError: class extends Error {} }));
vi.mock("../lib/server/mongodb", () => ({ database: mocks.database }));
vi.mock("../lib/server/rate-limit", () => ({ RateLimitError: class extends Error {} }));
vi.mock("@/lib/server/admin-route", async () => import("../lib/server/admin-route"));
vi.mock("@/lib/server/prepared-views", () => ({
  listPreparedViews: mocks.list, reviewPreparedView: mocks.review, revokePreparedView: mocks.revoke,
  preparedCollections: () => ({ tasks: { find: (filter: unknown) => {
    mocks.tasks(filter);
    const cursor = { sort: () => cursor, limit: () => cursor, toArray: async () => [{ id: "task", viewId: "view", state: "unknown",
      provider: { state: "unknown", costUsd: 0.03, observation: { outputReference: "https://private.example/token" } }, failure: "Issue inconnue" }] };
    return cursor;
  } } }),
}));
vi.mock("@/lib/server/prepared-view-tasks", () => ({ queuePreparedView: mocks.queue,
  retryPreparedViewMatte: mocks.retryMatte, preparedMatteRetryAvailability: mocks.matteAvailability }));

import { AdminAuthError } from "../lib/server/admin-auth";
import { GET, POST } from "../app/api/admin/products/[id]/prepared-views/route";
import { POST as REVIEW } from "../app/api/admin/products/[id]/prepared-views/[viewId]/review/route";
import { POST as REVOKE } from "../app/api/admin/products/[id]/prepared-views/[viewId]/revoke/route";
import { POST as RETRY_MATTE } from "../app/api/admin/products/[id]/prepared-views/[viewId]/retry-matte/route";
const context = { params: Promise.resolve({ id: "product", viewId: "view" }) };
const url = "https://shop.example.test/api/admin/products/product/prepared-views";
const post = (body: unknown = {}, origin = "https://shop.example.test") => new Request(url, {
  method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticate.mockResolvedValue({ username: "Alice", issuedAt: 0 });
  mocks.database.mockResolvedValue({ database: true });
  mocks.organization.mockResolvedValue({ id: "org-owned" });
  mocks.list.mockResolvedValue([{ id: "view", state: "failed" }]);
  mocks.queue.mockResolvedValue({ preparationId: "task", viewId: "view", state: "queued", reused: false });
  mocks.review.mockResolvedValue({ id: "view", state: "approved" });
  mocks.revoke.mockResolvedValue({ id: "view", state: "revoked" });
  mocks.retryMatte.mockResolvedValue({ preparationId: "task", viewId: "view", state: "queued", reused: false, providerOutcome: "succeeded" });
  mocks.matteAvailability.mockResolvedValue({ eligible: false, reason: "Issue fournisseur inconnue" });
});
describe("prepared view administrator HTTP boundary", () => {
  it("refuses unauthenticated reads and writes before resolving any private view", async () => {
    mocks.authenticate.mockRejectedValue(new AdminAuthError("Authentification requise", 401));
    expect((await GET(new Request(url), context)).status).toBe(401);
    expect((await POST(post(), context)).status).toBe(401);
    expect((await RETRY_MATTE(post(), context)).status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.queue).not.toHaveBeenCalled();
    expect(mocks.retryMatte).not.toHaveBeenCalled();
  });
  it("refuses foreign origin before review or revocation", async () => {
    expect((await REVIEW(post({}, "https://other.example.test"), context)).status).toBe(403);
    expect((await REVOKE(post({}, "https://other.example.test"), context)).status).toBe(403);
    expect((await RETRY_MATTE(post({}, "https://other.example.test"), context)).status).toBe(403);
    expect(mocks.review).not.toHaveBeenCalled();
    expect(mocks.revoke).not.toHaveBeenCalled();
    expect(mocks.retryMatte).not.toHaveBeenCalled();
  });
  it("scopes reads to the server organization and strips provider output references", async () => {
    const response = await GET(new Request(`${url}?organizationId=other`), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.list).toHaveBeenCalledWith({ database: true }, "org-owned", "product");
    expect(mocks.tasks).toHaveBeenCalledWith({ organizationId: "org-owned", productId: "product" });
    const body = await response.json();
    expect(body.tasks[0].providerOutcome).toBe("unknown");
    expect(body.tasks[0].matteRetry).toEqual({ eligible: false, reason: "Issue fournisseur inconnue" });
    expect(JSON.stringify(body)).not.toContain("private.example");
    expect(JSON.stringify(body)).not.toContain("outputReference");
  });
  it("queues persistently with 202 and stamps review identity from the authenticated session", async () => {
    expect((await POST(post({ idempotencyKey: "key-12345" }), context)).status).toBe(202);
    await REVIEW(post({ expectedRevision: 2 }), context);
    expect(mocks.review).toHaveBeenCalledWith({ database: true }, "org-owned", "product", "view", "admin:Alice", { expectedRevision: 2 }, "human");
    await REVOKE(post({ reason: "Identity mismatch" }), context);
    expect(mocks.revoke).toHaveBeenCalledWith({ database: true }, "org-owned", "product", "view", "admin:Alice", { reason: "Identity mismatch" });
  });
  it("queues matte recovery with administrator identity and no-store response", async () => {
    const request = { idempotencyKey: "retry-key-1", expectedRevision: 2, expectedProductRevision: "2026-10-03T00:00:00.000Z" };
    const response = await RETRY_MATTE(post(request), context);
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.retryMatte).toHaveBeenCalledWith({ database: true }, "org-owned", "product", "view", "admin:Alice", request);
  });
});
