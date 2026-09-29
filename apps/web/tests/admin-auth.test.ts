import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";

const mocks = vi.hoisted(() => ({
  config: {
    adminUsername: undefined as string | undefined,
    adminPassword: undefined as string | undefined,
    adminPasswordHash: undefined as string | undefined,
    sessionSecret: "private-session-secret-for-admin-tests-2026" as string | undefined,
    adminSessionSecret: undefined as string | undefined,
    adminSessionHours: 12,
  },
  cookies: vi.fn(),
  redirect: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/config", () => ({ serverConfig: mocks.config }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import {
  ADMIN_COOKIE_NAME, adminConfiguration, adminSessionForRequest, assertAdminRequestOrigin,
  clearAdminSessionCookie, createAdminSession, currentAdminSession,
  requireAdminRequest, verifyAdminCredentials, verifyAdminToken,
} from "../lib/server/admin-auth";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("ADMIN_CREDENTIALS_MODE", "");
  Object.assign(mocks.config, {
    adminUsername: undefined, adminPassword: undefined, adminPasswordHash: undefined,
    sessionSecret: "private-session-secret-for-admin-tests-2026",
    adminSessionSecret: undefined, adminSessionHours: 12,
  });
  mocks.cookies.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("administrator authentication", () => {
  it("allows same-origin authentication changes and rejects absent or foreign origins", () => {
    const request = (origin?: string, site?: string) => new Request("https://example.test/api/admin/session", {
      method: "POST", headers: { ...(origin ? { origin } : {}), ...(site ? { "sec-fetch-site": site } : {}) },
    });
    expect(() => assertAdminRequestOrigin(request("https://example.test"))).not.toThrow();
    for (const origin of [undefined, "null", "https://other.test", "ftp://example.test", "https://example.test:444"]) {
      expect(() => assertAdminRequestOrigin(request(origin))).toThrow("Origine");
    }
    expect(() => assertAdminRequestOrigin(request("https://example.test", "cross-site"))).toThrow("Origine");
  });

  it("uses the destination Host when Next normalizes its listener URL", () => {
    const request = (origin: string, host = "127.0.0.1:3000") => new Request("http://localhost:3000/api/admin/session", {
      method: "POST", headers: { origin, host, "x-forwarded-host": "untrusted.test" },
    });
    expect(() => assertAdminRequestOrigin(request("http://127.0.0.1:3000"))).not.toThrow();
    expect(() => assertAdminRequestOrigin(request("http://localhost:3000"))).toThrow("Origine");
    expect(() => assertAdminRequestOrigin(request("http://untrusted.test"))).toThrow("Origine");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => assertAdminRequestOrigin(request("https://shop.example.test", "shop.example.test"))).not.toThrow();
    expect(() => assertAdminRequestOrigin(request("http://shop.example.test", "shop.example.test"))).toThrow("Origine");
  });

  it("accepts the requested account and rejects wrong username or password", async () => {
    expect(await verifyAdminCredentials("LiliDeco", "LiliDeco2026")).toBe(true);
    expect(await verifyAdminCredentials("wrong", "LiliDeco2026")).toBe(false);
    expect(await verifyAdminCredentials("LiliDeco", "wrong-password")).toBe(false);
  });

  it.each([undefined, "short", "replace-with-a-long-private-secret-2026"])(
    "does not sign or accept a session without a valid private application secret (%s)",
    async (sessionSecret) => {
      mocks.config.sessionSecret = sessionSecret;
      expect(adminConfiguration().configured).toBe(false);
      expect(await verifyAdminCredentials("LiliDeco", "LiliDeco2026")).toBe(false);
      await expect(createAdminSession("LiliDeco")).rejects.toMatchObject({ status: 503 });
      expect(await verifyAdminToken("anything")).toBeNull();
    },
  );

  it("requires APP_SESSION_SECRET even when a dedicated admin secret exists", () => {
    mocks.config.sessionSecret = undefined;
    mocks.config.adminSessionSecret = "a-dedicated-private-secret-long-enough-2026";
    expect(adminConfiguration().configured).toBe(false);
  });

  it("ignores old login variables in the default mode and exposes no values in diagnostics", async () => {
    mocks.config.adminUsername = "old-user";
    mocks.config.adminPassword = "old-password";
    mocks.config.adminPasswordHash = "invalid-old-hash";
    expect(await verifyAdminCredentials("LiliDeco", "LiliDeco2026")).toBe(true);
    mocks.config.sessionSecret = undefined;
    const diagnostics = JSON.stringify(adminConfiguration());
    expect(diagnostics).not.toContain("old-password");
    expect(diagnostics).not.toContain("invalid-old-hash");
    expect(diagnostics).not.toContain("LiliDeco2026");
  });

  it("rejects incomplete or malformed explicit rotation without falling back", () => {
    vi.stubEnv("ADMIN_CREDENTIALS_MODE", "environment");
    expect(adminConfiguration().configured).toBe(false);
    mocks.config.adminPasswordHash = "broken";
    expect(adminConfiguration().configured).toBe(false);
    vi.stubEnv("ADMIN_CREDENTIALS_MODE", "typo");
    expect(adminConfiguration().configured).toBe(false);
  });

  it("uses protected production cookies and verifies the same token in pages and APIs", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { token, cookie } = await createAdminSession("lilideco");
    expect(cookie).toContain("HttpOnly; SameSite=Strict");
    expect(cookie).toContain("; Secure");
    expect(cookie).toContain("Max-Age=43200");
    expect(clearAdminSessionCookie()).toContain("Max-Age=0; Secure");
    expect(await verifyAdminToken(token)).toMatchObject({ username: "LiliDeco" });
    const request = new Request("https://example.test/api/admin/products", { headers: { cookie: `${ADMIN_COOKIE_NAME}=${token}` } });
    expect(await requireAdminRequest(request)).toMatchObject({ username: "LiliDeco" });
    mocks.cookies.mockResolvedValue({ get: () => ({ value: token }) });
    expect(await currentAdminSession()).toMatchObject({ username: "LiliDeco" });
  });

  it("rejects a modified token and a merchant token", async () => {
    const { token } = await createAdminSession("LiliDeco");
    const [header, payload, signature] = token.split(".");
    const changed = `${signature![0] === "A" ? "B" : "A"}${signature!.slice(1)}`;
    expect(await verifyAdminToken(`${header}.${payload}.${changed}`)).toBeNull();
    const merchant = await new SignJWT({ scope: "merchant" }).setProtectedHeader({ alg: "HS256" })
      .setSubject("LiliDeco").setIssuer("lilidecoai").setAudience("merchant").setExpirationTime("1h")
      .sign(new TextEncoder().encode(mocks.config.sessionSecret!));
    expect(await verifyAdminToken(merchant)).toBeNull();
    expect(await adminSessionForRequest(new Request("https://example.test"))).toBeNull();
  });

  it("revokes sessions on password rotation in both the page and request path", async () => {
    vi.stubEnv("ADMIN_CREDENTIALS_MODE", "environment");
    mocks.config.adminUsername = "owner";
    mocks.config.adminPassword = "first-private-password";
    const { token } = await createAdminSession("owner");
    expect(await verifyAdminToken(token)).toMatchObject({ username: "owner" });
    mocks.config.adminPassword = "second-private-password";
    expect(await verifyAdminToken(token)).toBeNull();
    mocks.cookies.mockResolvedValue({ get: () => ({ value: token }) });
    expect(await currentAdminSession()).toBeNull();
    await expect(requireAdminRequest(new Request("https://example.test", { headers: { cookie: `${ADMIN_COOKIE_NAME}=${token}` } }))).rejects.toMatchObject({ status: 401 });
  });

  it("revokes sessions after username or signing-secret rotation", async () => {
    vi.stubEnv("ADMIN_CREDENTIALS_MODE", "environment");
    mocks.config.adminUsername = "owner";
    mocks.config.adminPassword = "a-private-password";
    const { token } = await createAdminSession("owner");
    mocks.config.adminUsername = "other";
    expect(await verifyAdminToken(token)).toBeNull();
    mocks.config.adminUsername = "owner";
    mocks.config.sessionSecret = "a-different-private-session-secret-2026";
    expect(await verifyAdminToken(token)).toBeNull();
  });

  it("rejects expired sessions", async () => {
    const { token } = await createAdminSession("LiliDeco");
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 13 * 60 * 60 * 1000);
    expect(await verifyAdminToken(token)).toBeNull();
  });
});
