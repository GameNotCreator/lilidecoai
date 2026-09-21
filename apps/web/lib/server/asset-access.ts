import "server-only";

import type { Tenant } from "./auth";
import type { AssetDocument } from "./types";

/**
 * Who may read an image, decided once instead of at each call site.
 *
 * Audit findings A16 and A17: readability used to be inferred from the asset
 * *kind* — every `product` and `cutout` was world-readable, so a visitor's own
 * uploaded object photo was served to anyone holding the URL — and `DEMO_MODE`
 * disabled the check for everything else. Expiry was equally advisory: an
 * asset stayed readable until the daily purge happened to reach it.
 *
 * The kind of an image says what it depicts, never who owns it. Publication is
 * now an explicit property carried by the asset, and everything that is not
 * published belongs to exactly one scope:
 *
 * - `ownerSessionId` set → one visitor session (guest or public visualizer).
 *   That session reads it, and so does a signed-in member of the organization
 *   the upload was made to: the merchant whose storefront produced it already
 *   sees these renders in their history. No other visitor does, which is the
 *   isolation the audit asked for.
 * - `ownerSessionId` absent → the merchant organization. Only a signed-in
 *   member of that organization reads it — never a visitor session, and never
 *   the synthetic identity demo mode grants to a session-less request.
 *
 * This is an authorization contract, not a confidentiality guarantee for the
 * bytes themselves: an image already delivered to a browser, or a public
 * catalogue image, stays out of its reach.
 */

/** Roles that act for the organization itself rather than for one visitor. */
const ORGANIZATION_ROLES = new Set([
  "owner",
  "admin",
  "member",
  "platform_admin",
]);

export type AssetAccessDecision =
  | { allowed: true; cacheable: boolean }
  | { allowed: false; status: 403 | 404 };

/**
 * The visitor session an upload belongs to, or `undefined` for a merchant
 * acting as the organization. Guest and public visualizer sessions both carry
 * `publicSessionId`, so one field scopes both.
 */
export function sessionScope(tenant: Tenant): string | undefined {
  return tenant.publicSessionId;
}

/**
 * Published assets are readable without a session. Absent visibility means an
 * asset written before this field existed: treated as private, so a database
 * that has not run the migration refuses a catalogue image rather than
 * leaking an upload. `scripts/migrate-asset-visibility.mjs` stamps them.
 */
export function isPublished(asset: AssetDocument): boolean {
  return asset.visibility === "published";
}

export function isExpired(asset: AssetDocument, now = new Date()): boolean {
  return Boolean(asset.expiresAt && asset.expiresAt.getTime() <= now.getTime());
}

/**
 * `tenant` is `null` when the request carries no usable identity at all.
 * Expired assets are refused as missing, whatever the caller's rights: the
 * retention promise is what the customer was told, and the purge cron only
 * decides when the bytes physically go.
 */
export function assetAccess(
  asset: AssetDocument,
  tenant: Tenant | null,
  now = new Date(),
): AssetAccessDecision {
  if (isExpired(asset, now)) return { allowed: false, status: 404 };
  if (isPublished(asset)) return { allowed: true, cacheable: true };
  if (!tenant) return { allowed: false, status: 403 };
  if (tenant.organizationId !== asset.organizationId) {
    return { allowed: false, status: 403 };
  }
  const scope = sessionScope(tenant);
  if (asset.ownerSessionId) {
    if (asset.ownerSessionId === scope) {
      return { allowed: true, cacheable: false };
    }
    // A real member of the organization, not the synthetic demo identity and
    // not another visitor. In the shared demo organization nobody is one, so
    // this does not reopen the hole it replaced.
    return !scope && !tenant.synthetic && ORGANIZATION_ROLES.has(tenant.role)
      ? { allowed: true, cacheable: false }
      : { allowed: false, status: 403 };
  }
  // Organization-owned and private: a visitor session never reads it, even
  // inside the same (shared, demo) organization, and neither does the
  // synthetic identity demo mode hands to a request with no session — it was
  // never asked to prove anything.
  if (scope || tenant.synthetic) return { allowed: false, status: 403 };
  return ORGANIZATION_ROLES.has(tenant.role)
    ? { allowed: true, cacheable: false }
    : { allowed: false, status: 403 };
}
