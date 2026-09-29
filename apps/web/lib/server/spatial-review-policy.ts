import "server-only";

/** Frozen execution limits for spatial-v11. Quality thresholds live separately. */
export const SPATIAL_REVIEW_EXECUTION_POLICY = Object.freeze({
  version: "spatial-review-execution-v1" as const,
  timeoutMs: 90_000,
  minimumTimeoutMs: 30_000,
  deadlineReserveMs: 1_000,
  retry: Object.freeze({ maxAttempts: 2 as const, respectRetryable: true }),
});
