import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/config", () => ({
  serverConfig: {
    demoMode: false,
    sessionSecret: "storefront-test-private-session-key-2026",
  },
}));
import {
  createStorefrontSession,
  createSession,
  verifySessionToken,
  tenantsForRequest,
} from "../lib/server/auth";
import { assetAccess } from "../lib/server/asset-access";
import type { AssetDocument } from "../lib/server/types";

it("mints isolated server identities and reuses only the signed storefront cookie", async () => {
  const a = await createStorefrontSession(
    "org",
    new Request("http://test", {
      method: "POST",
      body: JSON.stringify({ sessionId: "stolen" }),
    }),
  );
  const b = await createStorefrontSession("org", new Request("http://test"));
  const first = await verifySessionToken(a.token);
  expect(first?.role).toBe("viewer");
  expect(first?.storefront).toBe(true);
  expect(first?.publicSessionId).not.toBe(
    (await verifySessionToken(b.token))?.publicSessionId,
  );
  const continued = await createStorefrontSession(
    "org",
    new Request("http://test", { headers: { cookie: a.cookie } }),
  );
  expect((await verifySessionToken(continued.token))?.publicSessionId).toBe(
    first?.publicSessionId,
  );
  const moved = await createStorefrontSession(
    "other-org",
    new Request("http://test", { headers: { cookie: a.cookie } }),
  );
  expect((await verifySessionToken(moved.token))?.publicSessionId).not.toBe(
    first?.publicSessionId,
  );
  expect(a.cookie).toContain("HttpOnly; SameSite=Lax");
});
it("reads the visitor's own image even with a merchant cookie, denies other visitors", async () => {
  const visitor = await createStorefrontSession(
    "org",
    new Request("http://test"),
  );
  const tenant = (await verifySessionToken(visitor.token))!;
  const merchant = await createSession({
    organizationId: "other",
    userId: "merchant",
    role: "owner",
  });
  const identities = await tenantsForRequest(
    new Request("http://test", {
      headers: {
        cookie: `${merchant.cookie.split(";")[0]}; ${visitor.cookie.split(";")[0]}`,
      },
    }),
  );
  const asset = {
    id: "photo",
    organizationId: "org",
    kind: "scene",
    visibility: "private",
    ownerSessionId: tenant.publicSessionId,
    createdAt: new Date(),
    contentType: "image/webp",
    size: 1,
  } as AssetDocument;
  expect(
    identities.some((identity) => assetAccess(asset, identity).allowed),
  ).toBe(true);
  const other = (await verifySessionToken(
    (await createStorefrontSession("org", new Request("http://test"))).token,
  ))!;
  expect(assetAccess(asset, other).allowed).toBe(false);
  expect(assetAccess(asset, null).allowed).toBe(false);
});
