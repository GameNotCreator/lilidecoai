import "server-only";

import type { Db } from "mongodb";

import { collections } from "./mongodb";

export async function enforceRateLimit(
  db: Db,
  organizationId: string,
  action: string,
  limit: number,
  windowMs: number,
): Promise<void> {
  const now = Date.now();
  const windowStartedAt = new Date(Math.floor(now / windowMs) * windowMs);
  const expiresAt = new Date(windowStartedAt.getTime() + windowMs * 2);
  const id = `${organizationId}:${action}:${windowStartedAt.getTime()}`;
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
