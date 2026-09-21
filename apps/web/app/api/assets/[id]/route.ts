import { requireAdminRequest } from "@/lib/server/admin-auth";
import { resolveAdminOrganization } from "@/lib/server/admin-products";
import { assetAccess } from "@/lib/server/asset-access";
import { readAsset } from "@/lib/server/assets";
import { tenantsForRequest, type Tenant } from "@/lib/server/auth";
import { database } from "@/lib/server/mongodb";
import type { Db } from "mongodb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The back office authenticates with its own cookie, which `tenantsForRequest`
 * does not read. Without this it would see a broken thumbnail for every image
 * the merchant organization owns privately. The identity is granted here and
 * nowhere else: putting it in `tenantsForRequest` would let a back-office token
 * act as a merchant across the whole API, which it was never issued to do.
 */
async function backOfficeTenant(db: Db, request: Request): Promise<Tenant[]> {
  try {
    const session = await requireAdminRequest(request);
    const organization = await resolveAdminOrganization(db);
    return [
      {
        organizationId: organization.id,
        userId: `backoffice:${session.username}`,
        role: "admin",
      },
    ];
  } catch {
    return [];
  }
}

/**
 * Serves one stored image.
 *
 * Readability comes from the asset itself — published catalogue, one visitor
 * session's upload, or the merchant organization — and is decided in
 * `asset-access.ts`. This route used to infer it from the asset *kind*, which
 * made every visitor's own object photo world-readable, and `DEMO_MODE`
 * removed the check entirely for the rest. Neither shortcut exists any more:
 * demo mode still hands out a shared organization identity, but that identity
 * now reads only what the organization owns, never another visitor's upload.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const db = await database();
  // `readAsset` already refuses an expired asset; `assetAccess` re-checks so
  // the rule holds for any future caller that reads the document directly.
  const result = await readAsset(db, id);
  if (!result) return new Response("Not found", { status: 404 });

  // A browser sends every cookie it holds, so one request can carry a merchant
  // account and a guest session at once. The image is served if ANY of those
  // identities may read it; the refusal reported is the strictest one.
  const tenants = [
    ...(await tenantsForRequest(request).catch(() => [])),
    ...(await backOfficeTenant(db, request)),
  ];
  const decisions = (tenants.length ? tenants : [null]).map((tenant) =>
    assetAccess(result.asset, tenant),
  );
  const decision =
    decisions.find((candidate) => candidate.allowed) ?? decisions[0]!;
  if (!decision.allowed) {
    return new Response(decision.status === 404 ? "Not found" : "Forbidden", {
      status: decision.status,
    });
  }

  const body = new Uint8Array(result.buffer.length);
  body.set(result.buffer);
  return new Response(body.buffer, {
    headers: {
      "Content-Type": result.asset.contentType,
      "Content-Length": String(result.buffer.length),
      "Cache-Control": decision.cacheable
        ? "public, max-age=31536000, immutable"
        : "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
