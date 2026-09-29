import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  database: vi.fn(),
  availability: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  admin: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/mongodb", () => ({ database: mocks.database }));
vi.mock("../lib/server/order-requests", () => ({
  checkoutAvailability: mocks.availability,
  createOrderRequest: mocks.create,
  listOrderRequests: mocks.list,
  OrderRequestError: class extends Error {
    constructor(
      message: string,
      public status: number,
    ) {
      super(message);
    }
  },
}));
vi.mock("../lib/server/admin-route", () => ({ withAdmin: mocks.admin }));
import { GET, POST } from "../app/api/storefront/orders/route";
import { GET as adminGET } from "../app/api/admin/orders/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.availability.mockReturnValue({ available: true });
  mocks.database.mockResolvedValue({ local: true });
  mocks.create.mockResolvedValue({
    recorded: true,
    reference: "BLD-TEST",
    notification: "sent",
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("order request HTTP boundary", () => {
  it("rejects absent and cross-site Origin before database access", async () => {
    for (const origin of [undefined, "https://evil.example.test"]) {
      const response = await POST(
        new Request("https://shop.example.test/api/storefront/orders", {
          method: "POST",
          headers: origin ? { origin } : {},
          body: "{}",
        }),
      );
      expect(response.status).toBe(403);
      expect(response.headers.get("Cache-Control")).toContain("no-store");
    }
    expect(mocks.database).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("advertises only availability and rejects submission when not configured", async () => {
    mocks.availability.mockReturnValue({
      available: false,
      reason: "Indisponible",
    });
    const response = await GET();
    expect(await response.json()).toEqual({
      available: false,
      reason: "Indisponible",
    });
    const post = await POST(
      new Request("https://shop.example.test/api/storefront/orders", {
        method: "POST",
        headers: { origin: "https://shop.example.test" },
      }),
    );
    expect(post.status).toBe(503);
    expect(mocks.database).not.toHaveBeenCalled();
  });
  it("passes only parsed body and source address to the server service", async () => {
    const response = await POST(
      new Request("https://shop.example.test/api/storefront/orders", {
        method: "POST",
        headers: {
          origin: "https://shop.example.test",
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.5, 203.0.113.6",
        },
        body: '{"request":"test"}',
      }),
    );
    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(
      { local: true },
      { request: "test" },
      "203.0.113.5",
    );
    expect(await response.json()).toEqual({
      recorded: true,
      reference: "BLD-TEST",
      notification: "sent",
    });
  });
  it("does not expose unexpected database or provider exception detail", async () => {
    mocks.create.mockRejectedValueOnce(
      new Error("private customer and provider payload"),
    );
    const response = await POST(
      new Request("https://shop.example.test/api/storefront/orders", {
        method: "POST",
        headers: {
          origin: "https://shop.example.test",
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private customer");
  });
  it("requires the administrator wrapper and scopes the private list to its organization", async () => {
    mocks.admin.mockImplementationOnce(async () =>
      Response.json({ detail: "Unauthorized" }, { status: 401 }),
    );
    expect(
      (
        await adminGET(
          new Request("https://shop.example.test/api/admin/orders"),
        )
      ).status,
    ).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
    mocks.admin.mockImplementationOnce(async (_request, handler) =>
      handler({ db: { local: true }, organization: { id: "authorized-org" } }),
    );
    mocks.list.mockResolvedValue([]);
    const response = await adminGET(
      new Request("https://shop.example.test/api/admin/orders"),
    );
    expect(mocks.list).toHaveBeenCalledWith({ local: true }, "authorized-org");
    expect(response.headers.get("Cache-Control")).toContain(
      "private, no-store",
    );
  });
});
