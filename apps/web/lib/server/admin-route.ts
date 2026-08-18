import "server-only";

import type { Db } from "mongodb";
import { z } from "zod";

import {
  AdminAuthError,
  requireAdminRequest,
  type AdminSession,
} from "./admin-auth";
import { AdminProductError, resolveAdminOrganization } from "./admin-products";
import { ApiInputError } from "./assets";
import { database } from "./mongodb";
import { RateLimitError } from "./rate-limit";
import type { OrganizationDocument } from "./types";

export interface AdminContext {
  db: Db;
  organization: OrganizationDocument;
  session: AdminSession;
}

/** Authenticates, opens the database and resolves the managed storefront. */
export async function withAdmin(
  request: Request,
  handler: (context: AdminContext) => Promise<Response>,
): Promise<Response> {
  try {
    const session = await requireAdminRequest(request);
    const db = await database();
    const organization = await resolveAdminOrganization(db);
    return await handler({ db, organization, session });
  } catch (reason) {
    return adminErrorResponse(reason);
  }
}

export function adminErrorResponse(reason: unknown): Response {
  if (reason instanceof AdminAuthError) {
    return detail(reason.message, reason.status);
  }
  if (reason instanceof AdminProductError) {
    return detail(reason.message, reason.status);
  }
  if (reason instanceof RateLimitError) {
    return detail(reason.message, reason.status);
  }
  if (reason instanceof ApiInputError) {
    return detail(reason.message, 422);
  }
  if (reason instanceof z.ZodError) {
    const issue = reason.issues[0];
    const field = issue?.path.join(".");
    return detail(
      `${field ? `${field}: ` : ""}${issue?.message ?? "Données invalides"}`,
      422,
    );
  }
  if (
    reason &&
    typeof reason === "object" &&
    "code" in reason &&
    reason.code === 11000
  ) {
    return detail("Cette référence existe déjà", 409);
  }
  console.error("Back office", reason);
  return detail("Erreur interne du back office", 500);
}

export function detail(message: string, status: number): Response {
  return Response.json({ detail: message }, { status });
}

export async function jsonBody(request: Request): Promise<unknown> {
  return request.json().catch(() => {
    throw new ApiInputError("Corps de requête JSON invalide");
  });
}

export function clientIdentifier(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || request.headers.get("x-real-ip") || "inconnu";
}
