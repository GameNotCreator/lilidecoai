import { qualityDecisionSchema } from "@lili/types";

/** Geometry advice never turns a refused candidate into an accepted final image. */
export function canShowStorefrontAdjustmentPreview(
  value: unknown,
  productIds: readonly string[],
  replacement = false,
): boolean {
  const parsed = qualityDecisionSchema.safeParse(value);
  if (!parsed.success || !["storefront-room-integration-review-v5", "storefront-manual-integration-review-v6"].includes(parsed.data.version) ||
      parsed.data.status !== "rejected" || parsed.data.score === null ||
      productIds.length < 1 || productIds.length > 3 || new Set(productIds).size !== productIds.length) return false;
  const checks = parsed.data.checks;
  if (new Set(checks.map(check => check.name)).size !== checks.length) return false;
  const required = ["photo_usable", "background_preserved", "no_unrequested_products", "review.confidence",
    ...(replacement ? ["replacement_complete"] : []),
    ...productIds.flatMap(id => ["confidence", "present", "identity", "noDuplicate", "silhouetteComplete"].map(name => `${id}.${name}`))];
  const fullReview = ["photo_usable", "background_preserved", "no_unrequested_products", "review.confidence",
    ...(replacement ? ["replacement_complete"] : []),
    ...productIds.flatMap(id => ["confidence", "present", "identity", "position", "scale", "perspective", "contact",
      "edges", "occlusion", "noDuplicate", "gravity", "silhouetteComplete", "photographicCoherence",
      "supportIntegration"].map(name => `${id}.${name}`))];
  if (!fullReview.every(name => checks.some(check => check.name === name)) ||
      !productIds.every(id => checks.some(check => check.name === `${id}.geometry_position` || check.name === `${id}.geometry`))) return false;
  // The parser preserves failed booleans as scores below .8; no missing or duplicate evidence is accepted.
  return required.every(name => (checks.find(check => check.name === name)?.score ?? 0) >= 0.8);
}
