import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  assetAccess,
  isExpired,
  isPublished,
  sessionScope,
} from "../lib/server/asset-access";
import type { Tenant } from "../lib/server/auth";
import type { AssetDocument } from "../lib/server/types";

const ORG = "org-a";
const OTHER_ORG = "org-b";

function asset(overrides: Partial<AssetDocument> = {}): AssetDocument {
  return {
    id: "asset-1",
    organizationId: ORG,
    kind: "product",
    visibility: "private",
    contentType: "image/webp",
    size: 10,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    ...overrides,
  };
}

function merchant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    organizationId: ORG,
    userId: "user-1",
    role: "owner",
    ...overrides,
  };
}

function visitor(sessionId: string, organizationId = ORG): Tenant {
  return {
    organizationId,
    userId: sessionId,
    role: "guest",
    publicSessionId: sessionId,
  };
}

const NOW = new Date("2026-09-06T12:00:00Z");

describe("asset visibility", () => {
  it("treats an asset written before the field as private, not published", () => {
    const legacy = asset({ visibility: undefined });
    expect(isPublished(legacy)).toBe(false);
    expect(assetAccess(legacy, null, NOW)).toEqual({
      allowed: false,
      status: 403,
    });
  });

  it("serves a published catalogue image to an anonymous reader", () => {
    expect(assetAccess(asset({ visibility: "published" }), null, NOW)).toEqual({
      allowed: true,
      cacheable: true,
    });
  });

  it("never caches a private image publicly", () => {
    expect(assetAccess(asset(), merchant(), NOW)).toEqual({
      allowed: true,
      cacheable: false,
    });
  });
});

describe("cross-session isolation", () => {
  // A16 of the audit: a visitor's own object photo was served to anyone who
  // knew the URL, because `product` and `cutout` were public by kind.
  it("refuses one visitor's upload to another visitor of the same organization", () => {
    const upload = asset({ ownerSessionId: "guest:aaa" });
    expect(assetAccess(upload, visitor("guest:aaa"), NOW)).toEqual({
      allowed: true,
      cacheable: false,
    });
    expect(assetAccess(upload, visitor("guest:bbb"), NOW)).toEqual({
      allowed: false,
      status: 403,
    });
  });

  it("refuses everything private to the synthetic demo identity", () => {
    // Demo mode hands a cookieless request an organization-owner identity so
    // the demo works without a login. Nobody proved they own anything, so it
    // reads published catalogue images and nothing else.
    const demo = merchant({ synthetic: true });
    expect(
      assetAccess(asset({ ownerSessionId: "guest:aaa" }), demo, NOW),
    ).toEqual({ allowed: false, status: 403 });
    expect(assetAccess(asset(), demo, NOW)).toEqual({
      allowed: false,
      status: 403,
    });
    expect(assetAccess(asset({ visibility: "published" }), demo, NOW)).toEqual({
      allowed: true,
      cacheable: true,
    });
  });

  it("lets a real member of the organization read a visitor upload made to it", () => {
    // The merchant whose storefront produced the render already lists it in
    // their history; refusing the image would only show them a broken one.
    // The synthetic demo identity is deliberately not such a member.
    expect(
      assetAccess(asset({ ownerSessionId: "guest:aaa" }), merchant(), NOW),
    ).toEqual({ allowed: true, cacheable: false });
    expect(
      assetAccess(
        asset({ ownerSessionId: "guest:aaa" }),
        merchant({ role: "viewer" }),
        NOW,
      ),
    ).toEqual({ allowed: false, status: 403 });
    expect(
      assetAccess(
        asset({ ownerSessionId: "guest:aaa" }),
        merchant({ organizationId: OTHER_ORG }),
        NOW,
      ),
    ).toEqual({ allowed: false, status: 403 });
  });

  // A widget session's id is a bare uuid, a guest editor's is `guest:<uuid>`.
  // Nothing may key on the shape of that string.
  it("scopes a widget session by its bare identifier", () => {
    const widget = {
      organizationId: ORG,
      userId: "public:2f1c",
      role: "viewer" as const,
      publicSessionId: "2f1c",
    };
    expect(assetAccess(asset({ ownerSessionId: "2f1c" }), widget, NOW)).toEqual(
      { allowed: true, cacheable: false },
    );
    expect(
      assetAccess(asset({ ownerSessionId: "2f1c" }), visitor("guest:2f1c"), NOW),
    ).toEqual({ allowed: false, status: 403 });
  });

  it("refuses an organization-private image to a visitor session", () => {
    expect(assetAccess(asset(), visitor("guest:aaa"), NOW)).toEqual({
      allowed: false,
      status: 403,
    });
  });

  it("refuses every private image across organizations", () => {
    expect(
      assetAccess(asset(), merchant({ organizationId: OTHER_ORG }), NOW),
    ).toEqual({ allowed: false, status: 403 });
    expect(
      assetAccess(
        asset({ ownerSessionId: "guest:aaa" }),
        visitor("guest:aaa", OTHER_ORG),
        NOW,
      ),
    ).toEqual({ allowed: false, status: 403 });
  });

  it("refuses an organization-private image to a read-only role", () => {
    expect(assetAccess(asset(), merchant({ role: "viewer" }), NOW)).toEqual({
      allowed: false,
      status: 403,
    });
  });

  it("reads the session scope from a guest and a public visualizer session", () => {
    expect(sessionScope(visitor("guest:aaa"))).toBe("guest:aaa");
    expect(
      sessionScope({
        organizationId: ORG,
        userId: "public:xyz",
        role: "viewer",
        publicSessionId: "public:xyz",
        publicProductId: "product-1",
      }),
    ).toBe("public:xyz");
    expect(sessionScope(merchant())).toBeUndefined();
  });
});

describe("expiry", () => {
  // A17: expiry used to be enforced only by the daily purge.
  it("refuses an expired image as missing, whoever asks", () => {
    const gone = asset({
      visibility: "published",
      expiresAt: new Date("2026-09-06T11:59:59Z"),
    });
    expect(isExpired(gone, NOW)).toBe(true);
    expect(assetAccess(gone, null, NOW)).toEqual({
      allowed: false,
      status: 404,
    });
    expect(assetAccess(gone, merchant(), NOW)).toEqual({
      allowed: false,
      status: 404,
    });
  });

  it("still serves an image whose expiry has not been reached", () => {
    const live = asset({
      visibility: "published",
      expiresAt: new Date("2026-09-06T12:00:01Z"),
    });
    expect(isExpired(live, NOW)).toBe(false);
    expect(assetAccess(live, null, NOW)).toEqual({
      allowed: true,
      cacheable: true,
    });
  });
});

/**
 * A browser sends every cookie it holds. Found by the adversarial review of
 * this change set: a signed-in merchant browsing the public demo resolves to
 * their own organization, so every `<img>` request for the guest session's
 * images was refused.
 */
describe("a request carrying several identities", () => {
  const upload = () => asset({ ownerSessionId: "guest:aaa" });

  it("serves the image when any identity may read it", () => {
    const carried = [
      merchant({ organizationId: OTHER_ORG }),
      visitor("guest:aaa"),
    ];
    const decisions = carried.map((tenant) => assetAccess(upload(), tenant, NOW));
    expect(decisions.some((decision) => decision.allowed)).toBe(true);
  });

  it("refuses when no identity may read it", () => {
    const carried = [
      merchant({ organizationId: OTHER_ORG }),
      visitor("guest:bbb"),
    ];
    const decisions = carried.map((tenant) => assetAccess(upload(), tenant, NOW));
    expect(decisions.every((decision) => !decision.allowed)).toBe(true);
  });
});
