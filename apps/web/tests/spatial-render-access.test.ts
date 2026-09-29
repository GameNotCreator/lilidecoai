import { beforeEach, expect, it, vi } from "vitest";
import { mongoStore } from "./helpers/mongo-store";
const mocks = vi.hoisted(() => ({ tenant: vi.fn(), collections: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/mongodb", () => ({
  database: async () => ({}),
  collections: mocks.collections,
}));
vi.mock("../lib/server/auth", async (original) => ({
  ...(await original<object>()),
  tenantForRequest: mocks.tenant,
}));
vi.mock("../lib/server/config", async (original) => ({
  ...(await original<{ serverConfig: object }>()),
  serverConfig: {
    ...(await original<{ serverConfig: object }>()).serverConfig,
    demoMode: false,
  },
}));
import { dispatchApi } from "../lib/server/api";
const owner = { organizationId: "org", userId: "user", role: "owner" };
beforeEach(() => {
  vi.clearAllMocks();
  const renders = mongoStore();
  for (const [id, engine, organizationId, publicSessionId] of [
    ["spatial", "spatial", "org", undefined],
    ["legacy", "legacy", "org", undefined],
    ["public-spatial", "spatial", "org", "session"],
    ["public-legacy", "legacy", "org", "session"],
    ["foreign", "spatial", "other", undefined],
  ])
    renders.rows.push({
      id,
      idempotencyKey: `web-${id}`,
      engine,
      organizationId,
      publicSessionId,
      createdAt: new Date(),
      status: "queued",
      spatialEvidence:
        engine === "spatial" ? { marker: "internal-evidence" } : undefined,
    });
  mocks.collections.mockReturnValue({ renders, organizations: mongoStore() });
  mocks.tenant.mockResolvedValue(owner);
});
it.each([
  { role: "viewer" },
  { role: "guest" },
  { synthetic: true },
  { publicSessionId: "session" },
])(
  "applies the same spatial exclusion to list and detail for %j",
  async (restriction) => {
    mocks.tenant.mockResolvedValue({ ...owner, ...restriction });
    const listed = await dispatchApi(new Request("http://test/v1/renders"), [
      "renders",
    ]);
    expect(listed.status).toBe(200);
    const json = await listed.json();
    expect(json.length).toBeGreaterThan(0);
    expect(json.every((r: { engine: string }) => r.engine !== "spatial")).toBe(
      true,
    );
    expect(JSON.stringify(json)).not.toContain("internal-evidence");
    const id = "publicSessionId" in restriction ? "public-spatial" : "spatial";
    expect(
      (
        await dispatchApi(new Request(`http://test/v1/renders/${id}`), [
          "renders",
          id,
        ])
      ).status,
    ).toBe(403);
    const recovered = await dispatchApi(
      new Request("http://test/v1/renders/by-request/web-spatial"),
      ["renders", "by-request", "web-spatial"],
    );
    expect(recovered.status).toBe(403);
  },
);
it("retains merchant access to admitted jobs even when new admission is disabled, within their organization", async () => {
  const listed = await (
    await dispatchApi(new Request("http://test/v1/renders"), ["renders"])
  ).json();
  expect(listed.some((r: { id: string }) => r.id === "spatial")).toBe(true);
  expect(listed.some((r: { id: string }) => r.id === "foreign")).toBe(false);
  expect(
    (
      await dispatchApi(new Request("http://test/v1/renders/spatial"), [
        "renders",
        "spatial",
      ])
    ).status,
  ).toBe(200);
});
it("looks up only private spatial requests in the current organization, without creating a render", async () => {
  const renders = mocks.collections().renders;
  const initialCount = renders.rows.length;
  for (const key of [
    "web-foreign",
    "web-legacy",
    "web-public-spatial",
    "missing",
  ]) {
    const response = await dispatchApi(
      new Request(`http://test/v1/renders/by-request/${key}`),
      ["renders", "by-request", key],
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
  const response = await dispatchApi(
    new Request("http://test/v1/renders/by-request/web-spatial"),
    ["renders", "by-request", "web-spatial"],
  );
  expect(response.status).toBe(200);
  expect((await response.json()).id).toBe("spatial");
  expect(renders.rows.length).toBe(initialCount);
});
