import { beforeEach, expect, it, vi } from "vitest";
import { mongoStore } from "./helpers/mongo-store";
const mocks = vi.hoisted(() => ({
  tenant: vi.fn(),
  collections: vi.fn(),
  create: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/mongodb", () => ({
  database: async () => ({}),
  collections: mocks.collections,
}));
vi.mock("../lib/server/auth", async (original) => ({
  ...(await original<object>()),
  tenantForRequest: mocks.tenant,
}));
vi.mock("../lib/server/config", async (original) => {
  const actual = await original<{ serverConfig: object }>();
  return {
    ...actual,
    serverConfig: { ...actual.serverConfig, demoMode: false },
  };
});
vi.mock("../lib/server/rate-limit", () => ({ enforceRateLimit: vi.fn() }));
vi.mock("../lib/server/rendering", async (original) => ({
  ...(await original<object>()),
  createRender: mocks.create,
}));
import { dispatchApi } from "../lib/server/api";
const sourceId = "33333333-3333-4333-8333-333333333333";
const key = `retry:${sourceId}:44444444-4444-4444-8444-444444444444`;
const input = {
  engine: "spatial",
  workflow: "standard",
  mode: "insert",
  outputQuality: "final",
  placement: { sceneId: "scene", productId: "product", rotationDegrees: 45 },
  spatialReference: { lengthCm: 100 },
  userInstructions: "Original instructions",
  idempotencyKey: "first",
};
let renders: ReturnType<typeof mongoStore>;
beforeEach(() => {
  vi.clearAllMocks();
  renders = mongoStore();
  renders.rows.push({
    id: sourceId,
    organizationId: "org",
    engine: "spatial",
    status: "failed",
    requestSnapshot: { version: 1, input: structuredClone(input) },
  });
  mocks.collections.mockReturnValue({ renders, organizations: mongoStore() });
  mocks.tenant.mockResolvedValue({
    organizationId: "org",
    userId: "user",
    role: "owner",
  });
  mocks.create.mockResolvedValue({
    id: "new-render",
    engine: "spatial",
    status: "queued",
  });
});
function retry(body?: unknown) {
  return dispatchApi(
    new Request(`http://test/v1/renders/${sourceId}/retry`, {
      method: "POST",
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: { "Content-Type": "application/json" },
          }),
    }),
    ["renders", sourceId, "retry"],
  );
}
it("uses only the supplied key and the server snapshot across repeated requests", async () => {
  expect((await retry({ idempotencyKey: key })).status).toBe(201);
  expect((await retry({ idempotencyKey: key })).status).toBe(201);
  for (const call of mocks.create.mock.calls)
    expect(call[2]).toEqual({ ...input, idempotencyKey: key });
});
it.each([
  undefined,
  {},
  { idempotencyKey: key, userInstructions: "replace inputs" },
])("refuses incomplete or overridden spatial retry bodies %j", async (body) => {
  expect((await retry(body)).status).toBe(422);
  expect(mocks.create).not.toHaveBeenCalled();
});
it("refuses keys for another source render", async () => {
  expect(
    (await retry({ idempotencyKey: key.replace(sourceId, "other") })).status,
  ).toBe(409);
  expect(mocks.create).not.toHaveBeenCalled();
});
it("refuses an incomplete spatial snapshot rather than changing engines", async () => {
  delete renders.rows[0]!.requestSnapshot;
  expect((await retry({ idempotencyKey: key })).status).toBe(409);
  expect(mocks.create).not.toHaveBeenCalled();
});
it.each([
  { role: "viewer" },
  { role: "guest" },
  { synthetic: true },
  { publicSessionId: "public" },
])("keeps the spatial retry access boundary %j", async (restriction) => {
  mocks.tenant.mockResolvedValue({
    organizationId: "org",
    userId: "user",
    role: "owner",
    ...restriction,
  });
  expect([403, 404]).toContain((await retry({ idempotencyKey: key })).status);
  expect(mocks.create).not.toHaveBeenCalled();
});
it("does not find a render from another organization", async () => {
  mocks.tenant.mockResolvedValue({
    organizationId: "other",
    userId: "user",
    role: "owner",
  });
  expect((await retry({ idempotencyKey: key })).status).toBe(404);
  expect(mocks.create).not.toHaveBeenCalled();
});
it("preserves bodyless legacy retry requests", async () => {
  renders.rows[0]!.engine = "legacy";
  renders.rows[0]!.requestSnapshot = {
    version: 1,
    input: { ...input, engine: "legacy" },
  };
  expect((await retry()).status).toBe(201);
  expect(mocks.create.mock.calls[0]![2]).toMatchObject({
    engine: "legacy",
    idempotencyKey: expect.stringContaining(`retry:${sourceId}:`),
  });
});
