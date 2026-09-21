import "server-only";

import type { Db } from "mongodb";

import { collections } from "./mongodb";

/**
 * Fixed-window counter. `scopeKey` narrows the window below the organization
 * (per guest session, for instance): every guest shares the demo organization,
 * so an organization-wide window would let one visitor exhaust everyone's
 * quota.
 */
export async function enforceRateLimit(
  db: Db,
  organizationId: string,
  action: string,
  limit: number,
  windowMs: number,
  scopeKey?: string,
): Promise<void> {
  const now = Date.now();
  const windowStartedAt = new Date(Math.floor(now / windowMs) * windowMs);
  const expiresAt = new Date(windowStartedAt.getTime() + windowMs * 2);
  const scope = scopeKey ? `${organizationId}:${scopeKey}` : organizationId;
  const id = `${scope}:${action}:${windowStartedAt.getTime()}`;
  const result = await collections(db).rateLimits.findOneAndUpdate(
    { id },
    {
      $setOnInsert: {
        id,
        organizationId,
        action,
        windowStartedAt,
        expiresAt,
      },
      $inc: { count: 1 },
    },
    { upsert: true, returnDocument: "after" },
  );
  if ((result?.count ?? 1) > limit) {
    throw new RateLimitError(
      "Trop de demandes rapprochées. Patientez un instant puis réessayez.",
    );
  }
}

export class RateLimitError extends Error {
  readonly status = 429;
}
