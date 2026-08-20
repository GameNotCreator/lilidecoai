import { z } from "zod";

import {
  adminConfiguration,
  adminSessionForRequest,
  clearAdminSessionCookie,
  createAdminSession,
  verifyAdminCredentials,
} from "@/lib/server/admin-auth";
import {
  adminErrorResponse,
  clientIdentifier,
  detail,
  jsonBody,
} from "@/lib/server/admin-route";
import { database } from "@/lib/server/mongodb";
import { enforceRateLimit } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const loginSchema = z.object({
  username: z.string().trim().min(1).max(120),
  password: z.string().min(1).max(200),
});

export async function GET(request: Request): Promise<Response> {
  const status = adminConfiguration();
  const session = await adminSessionForRequest(request);
  return Response.json({
    configured: status.configured,
    reason: status.configured ? null : status.reason,
    // Presence flags only, and only while the panel is already known to be
    // locked: enough to tell "the variable never arrived" from "its value is
    // rejected", without revealing anything about the values themselves.
    detected: status.configured ? null : status.detected,
    authenticated: Boolean(session),
    username: session?.username ?? null,
  });
}

export async function POST(request: Request): Promise<Response> {
  try {
    const status = adminConfiguration();
    if (!status.configured) {
      return detail(`Back office indisponible. ${status.reason}`, 503);
    }
    const body = loginSchema.parse(await jsonBody(request));
    const db = await database();
    // Per-client then global: one address cannot brute force, and a botnet
    // cannot hammer the panel either.
    await enforceRateLimit(
      db,
      `backoffice:${clientIdentifier(request)}`,
      "admin-login",
      8,
      600_000,
    );
    await enforceRateLimit(db, "backoffice:all", "admin-login", 60, 600_000);

    if (!(await verifyAdminCredentials(body.username, body.password))) {
      return detail("Identifiants invalides", 401);
    }
    const session = await createAdminSession(status.credentials.username);
    return Response.json(
      { authenticated: true, username: status.credentials.username },
      { status: 201, headers: { "Set-Cookie": session.cookie } },
    );
  } catch (reason) {
    return adminErrorResponse(reason);
  }
}

export async function DELETE(): Promise<Response> {
  return Response.json(
    { authenticated: false },
    { headers: { "Set-Cookie": clearAdminSessionCookie() } },
  );
}
