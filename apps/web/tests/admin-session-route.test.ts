import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ database: vi.fn(), limit: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/config", () => ({ serverConfig: {
  sessionSecret: "private-admin-route-session-test-secret-2026", adminSessionHours: 12,
} }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/server/admin-auth", async () => import("../lib/server/admin-auth"));
vi.mock("@/lib/server/mongodb", () => ({ database: mocks.database }));
vi.mock("@/lib/server/rate-limit", () => ({ enforceRateLimit: mocks.limit }));
vi.mock("@/lib/server/admin-route", () => ({
  jsonBody: (request: Request) => request.json(),
  clientIdentifier: () => "test-client",
  detail: (detail: string, status: number) => Response.json({ detail }, { status }),
  adminErrorResponse: (reason: { message: string; status?: number }) => Response.json({ detail: reason.message }, { status: reason.status ?? 500 }),
}));

import { GET, POST, DELETE } from "../app/api/admin/session/route";

beforeEach(() => {
  vi.stubEnv("ADMIN_CREDENTIALS_MODE", "fixed");
  mocks.database.mockReset().mockResolvedValue({ testDb: true });
  mocks.limit.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

const request = (method: string, password = "LiliDeco2026", origin: string | null = "https://example.test") =>
  new Request("https://example.test/api/admin/session", {
    method,
    headers: { ...(origin ? { origin } : {}), "content-type": "application/json" },
    ...(method === "POST" ? { body: JSON.stringify({ username: "LiliDeco", password }) } : {}),
  });

describe("admin session route", () => {
  it("limits the real login by client and globally before returning a protected session", async () => {
    const response = await POST(request("POST"));
    expect(response.status).toBe(201);
    expect(mocks.limit.mock.calls.map(args => args.slice(1))).toEqual([
      ["backoffice:test-client", "admin-login", 8, 600_000],
      ["backoffice:all", "admin-login", 60, 600_000],
    ]);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
    expect(await response.json()).toEqual({ authenticated: true, username: "LiliDeco" });
  });

  it("returns a generic refusal for a wrong password without echoing it", async () => {
    const response = await POST(request("POST", "private-invalid-input"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ detail: "Identifiants invalides" });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("rejects cross-site or missing-origin login and logout before opening the database", async () => {
    for (const origin of [null, "https://foreign.test"]) {
      expect((await POST(request("POST", "ignored", origin))).status).toBe(403);
      expect((await DELETE(request("DELETE", "ignored", origin))).status).toBe(403);
    }
    expect(mocks.database).not.toHaveBeenCalled();
    expect(mocks.limit).not.toHaveBeenCalled();
  });

  it("honors a rate-limit refusal and never issues a session", async () => {
    mocks.limit.mockRejectedValue(Object.assign(new Error("Trop de tentatives"), { status: 429 }));
    const response = await POST(request("POST"));
    expect(response.status).toBe(429);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(mocks.limit).toHaveBeenCalledTimes(1);
  });

  it("keeps the public session response free of credential material and clears logout cookie", async () => {
    const response = await GET(request("GET"));
    expect(await response.json()).toEqual({ configured: true, reason: null, detected: null, authenticated: false, username: null });
    const logout = await DELETE(request("DELETE"));
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict; Max-Age=0");
  });
});
