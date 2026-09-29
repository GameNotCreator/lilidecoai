import { createStorefrontSession, AuthError } from "@/lib/server/auth";
import { database } from "@/lib/server/mongodb";
import { enforceRateLimit, RateLimitError } from "@/lib/server/rate-limit";
import {
  assertStorefrontOrigin,
  storefrontOrganization,
} from "@/lib/server/storefront";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertStorefrontOrigin(request);
    const db = await database();
    const organization = await storefrontOrganization(db);
    if (!organization)
      throw new AuthError("La boutique est en préparation.", 503);
    const client =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip") ||
      "unknown";
    await enforceRateLimit(
      db,
      organization.id,
      "storefront-session",
      30,
      600_000,
      `ip:${client}`,
    );
    await enforceRateLimit(
      db,
      organization.id,
      "storefront-session",
      500,
      600_000,
    );
    const session = await createStorefrontSession(organization.id, request);
    return Response.json(
      { accessToken: session.token },
      {
        status: 201,
        headers: { "Set-Cookie": session.cookie, "Cache-Control": "no-store" },
      },
    );
  } catch (reason) {
    const expected =
      reason instanceof AuthError || reason instanceof RateLimitError;
    return Response.json(
      {
        detail: expected
          ? reason.message
          : "Impossible d’ouvrir la visualisation. Réessayez dans un instant.",
      },
      {
        status: expected ? reason.status : 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
