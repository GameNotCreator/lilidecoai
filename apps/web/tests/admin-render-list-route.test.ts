import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), database: vi.fn(), resolve: vi.fn(),
  find: vi.fn(), sort: vi.fn(), limit: vi.fn(), toArray: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/admin-auth", async (original) => ({
  ...await original<object>(), requireAdminRequest: mocks.auth,
}));
vi.mock("../lib/server/mongodb", () => ({
  database: mocks.database,
  collections: () => ({ renders: { find: mocks.find } }),
}));
vi.mock("../lib/server/admin-products", async (original) => ({
  ...await original<object>(), resolveAdminOrganization: mocks.resolve,
}));

import { AdminAuthError } from "../lib/server/admin-auth";
import { GET } from "../app/api/admin/renders/route";

const url = "https://shop.test/api/admin/renders";
const productId = "bd0fbba7-09db-4d05-a1b1-dc15225c4706";
const now = new Date("2026-10-02T05:00:00Z");
const render = {
  id: "11111111-1111-4111-8111-111111111115",
  status: "succeeded", productId, createdAt: now, updatedAt: now,
  usageTotals: { estimatedCostUsd: 0.12 },
  engineVersions: { quality: "storefront-placement-review-v1" },
  placement: { scaleSpans: [{ scaleSource: "vision_coarse", confidence: "low" }] },
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ username: "LiliDeco" });
  mocks.database.mockResolvedValue({});
  mocks.resolve.mockResolvedValue({ id: "managed-shop" });
  mocks.find.mockReturnValue({ sort: mocks.sort });
  mocks.sort.mockReturnValue({ limit: mocks.limit });
  mocks.limit.mockReturnValue({ toArray: mocks.toArray });
  mocks.toArray.mockResolvedValue([render]);
});

describe("merchant render diagnostic list", () => {
  it("authenticates before accessing any render or database", async () => {
    mocks.auth.mockRejectedValue(new AdminAuthError("Connexion requise", 401));
    expect((await GET(new Request(url))).status).toBe(401);
    expect(mocks.database).not.toHaveBeenCalled();
    expect(mocks.find).not.toHaveBeenCalled();
  });

  it("keeps the managed organization scope and bounds newest-first retrieval to twenty", async () => {
    const response = await GET(new Request(url + "?organizationId=other&limit=10000"));
    expect(mocks.find.mock.calls[0]![0]).toEqual({ organizationId: "managed-shop" });
    expect(mocks.sort).toHaveBeenCalledWith({ createdAt: -1, id: -1 });
    expect(mocks.limit).toHaveBeenCalledWith(20);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("filters both the primary product and other basket items within the organization", async () => {
    await GET(new Request(url + "?productId=" + productId));
    expect(mocks.find.mock.calls[0]![0]).toEqual({
      organizationId: "managed-shop",
      $or: [{ productId }, { "requestSnapshot.input.simplePlacements.productId": productId }],
    });
  });

  it.each(["", "not-a-uuid", "{\"$ne\":null}"])("rejects an invalid product filter before querying: %j", async (filter) => {
    expect((await GET(new Request(url + "?productId=" + encodeURIComponent(filter)))).status).toBe(422);
    expect(mocks.find).not.toHaveBeenCalled();
  });

  it("projects only safe diagnostics and does not serialize unrelated private fields", async () => {
    mocks.toArray.mockResolvedValue([{
      ...render,
      publicSessionId: "PRIVATE_SESSION", sceneId: "PRIVATE_PHOTO", resultAssetId: "PRIVATE_RESULT",
      userInstructions: "PRIVATE_PROMPT", requestSnapshot: { secret: "PRIVATE_SNAPSHOT" },
      execution: { steps: { private: "PRIVATE_CHECKPOINT" } },
      placement: {
        imageUrl: "PRIVATE_URL",
        scaleSpans: [{ scaleSource: "vision_coarse", confidence: "low", private: "PRIVATE_METADATA" }],
      },
    }]);
    const response = await GET(new Request(url));
    const text = await response.text();
    expect(text).not.toContain("PRIVATE_");
    expect(JSON.parse(text)).toEqual({ renders: [{
      id: render.id, status: "succeeded", productId,
      createdAt: now.toISOString(), updatedAt: now.toISOString(),
      pipelineState: null, estimatedCostUsd: 0.12,
      qualityVersion: "storefront-placement-review-v1",
      scaleEvidence: [{ scaleSource: "vision_coarse", confidence: "low" }],
    }] });
    expect(mocks.find.mock.calls[0]![1]).toEqual({ projection: {
      _id: 0, id: 1, status: 1, productId: 1, createdAt: 1, updatedAt: 1,
      pipelineState: 1, estimatedCostUsd: 1, "usageTotals.estimatedCostUsd": 1,
      "engineVersions.quality": 1, "placement.scaleSpans.scaleSource": 1,
      "placement.scaleSpans.confidence": 1,
    } });
  });

  it("drops malformed or free-text scale provenance rather than exposing it", async () => {
    mocks.toArray.mockResolvedValue([{
      ...render, usageTotals: undefined, estimatedCostUsd: 0.03, engineVersions: undefined,
      placement: { scaleSpans: [
        { scaleSource: "PRIVATE_PROMPT", confidence: "high" },
        { scaleSource: "vision", confidence: "PRIVATE_METADATA" },
        { scaleSource: "vision", confidence: "high", freeText: "PRIVATE_TEXT" },
        { scaleSource: "user", confidence: "high" },
      ] },
    }]);
    expect(await (await GET(new Request(url))).json()).toEqual({ renders: [{
      id: render.id, status: "succeeded", productId,
      createdAt: now.toISOString(), updatedAt: now.toISOString(),
      pipelineState: null, estimatedCostUsd: 0.03, qualityVersion: null,
      scaleEvidence: [{ scaleSource: "vision", confidence: "high" }],
    }] });
  });

  it("returns an empty list when no managed render matches", async () => {
    mocks.toArray.mockResolvedValue([]);
    expect(await (await GET(new Request(url))).json()).toEqual({ renders: [] });
  });
});
