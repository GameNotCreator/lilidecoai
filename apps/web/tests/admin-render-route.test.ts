import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findOne: vi.fn(), authenticated: true }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/mongodb", () => ({
  collections: () => ({ renders: { findOne: mocks.findOne } }),
}));
vi.mock("@/lib/server/admin-route", () => ({
  withAdmin: async (
    _request: Request,
    handler: (context: unknown) => Promise<Response>,
  ) => {
    if (!mocks.authenticated) return new Response(null, { status: 401 });
    return handler({ db: {}, organization: { id: "shop" } });
  },
}));

import { GET } from "../app/api/admin/renders/[id]/route";

const id = "6b2cd6f8-3766-478f-8b11-0af4ffba1c81";
const request = new Request(`https://shop.test/api/admin/renders/${id}`);
const context = { params: Promise.resolve({ id }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticated = true;
});

describe("merchant render diagnostics", () => {
  it("requires a back-office session before querying visitors' renders", async () => {
    mocks.authenticated = false;
    expect((await GET(request, context)).status).toBe(401);
    expect(mocks.findOne).not.toHaveBeenCalled();
  });

  it("scopes the lookup to the managed shop and hides unknown or other-shop renders", async () => {
    mocks.findOne.mockResolvedValue(null);
    const response = await GET(request, context);
    expect(mocks.findOne).toHaveBeenCalledWith({ id, organizationId: "shop" });
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns the terminal cause without room photographs, session identities or checkpoints", async () => {
    const now = new Date("2026-09-30T09:24:52Z");
    mocks.findOne.mockResolvedValue({
      id,
      status: "failed",
      error: "Scale refused",
      createdAt: now,
      updatedAt: now,
      sceneAssetId: "private-photo",
      publicSessionId: "private-session",
      resultAssetId: "private-result",
      execution: {
        deadlineAt: now,
        attempts: 1,
        errorCode: "input_rejected",
        steps: { secret: true },
      },
      usageTotals: { estimatedCostUsd: 0.02 },
    });
    const response = await GET(request, context);
    const body = await response.json();
    expect(body).toMatchObject({
      id,
      status: "failed",
      error: "Scale refused",
      estimatedCostUsd: 0.02,
    });
    expect(Object.keys(body).sort()).toEqual([
      "createdAt",
      "error",
      "estimatedCostUsd",
      "execution",
      "id",
      "pipelineState",
      "status",
      "updatedAt",
    ]);
    expect(body.execution).toEqual({
      deadlineAt: now.toISOString(),
      attempts: 1,
      errorCode: "input_rejected",
    });
  });
});
