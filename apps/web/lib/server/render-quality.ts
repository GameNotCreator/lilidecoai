import { z } from "zod";
import type { QualityDecision } from "@lili/types";

export const QUALITY_VERSION = "quality-v1";
export const MINIMUM_QUALITY_SCORE = 0.72;

/** No coercion: strings, missing flags and non-finite scores are not evidence. */
export const qualityReviewSchema = z.object({
  accepted: z.boolean(),
  score: z.number().finite().min(0).max(1),
  replacementComplete: z.boolean(),
  scaleAndPerspectivePlausible: z.boolean(),
  scaleCorrectionFactor: z.number().finite().min(0.65).max(1.5),
  photorealistic: z.boolean(),
  duplicateProduct: z.boolean(),
  artifactsPresent: z.boolean(),
  productIdentityPreserved: z.boolean(),
  backgroundPreserved: z.boolean(),
  allProductsPresent: z.boolean(),
  feedback: z.string().max(300),
  checks: z
    .array(
      z.object({
        name: z.string(),
        score: z.number().finite().min(0).max(1),
        reason: z.string(),
      }),
    )
    .optional(),
});
export type QualityReview = z.infer<typeof qualityReviewSchema> & {
  unavailable?: boolean;
};

export function unavailableQualityReview(): QualityReview {
  return {
    unavailable: true,
    accepted: false,
    score: 0,
    replacementComplete: false,
    scaleAndPerspectivePlausible: false,
    scaleCorrectionFactor: 1,
    photorealistic: false,
    duplicateProduct: false,
    artifactsPresent: false,
    productIdentityPreserved: false,
    backgroundPreserved: false,
    allProductsPresent: false,
    feedback:
      "Le contrôle qualité est indisponible. L’aperçu est conservé, aucun rendu final n’est validé.",
    checks: [],
  };
}

export function qualityDecision(
  review: QualityReview,
  replacement: boolean,
): QualityDecision {
  const parsed = qualityReviewSchema.safeParse(review);
  if (review.unavailable || !parsed.success) {
    return {
      version: QUALITY_VERSION,
      status: "unavailable",
      score: null,
      feedback: unavailableQualityReview().feedback,
      checks: [],
    };
  }
  const r = parsed.data;
  const accepted =
    r.accepted &&
    r.score >= MINIMUM_QUALITY_SCORE &&
    r.scaleAndPerspectivePlausible &&
    r.photorealistic &&
    !r.duplicateProduct &&
    !r.artifactsPresent &&
    r.productIdentityPreserved &&
    r.backgroundPreserved &&
    r.allProductsPresent &&
    (!replacement || r.replacementComplete);
  return {
    version: QUALITY_VERSION,
    status: accepted ? "accepted" : "rejected",
    score: r.score,
    feedback: r.feedback,
    checks: r.checks ?? [],
  };
}

export function simulatedQualityDecision(): QualityDecision {
  return {
    version: QUALITY_VERSION,
    status: "simulated",
    score: null,
    feedback: "Simulation technique : fidélité photographique non évaluée.",
    checks: [],
  };
}

export function preferQualityReview(
  candidate: QualityReview,
  current: QualityReview,
  replacement: boolean,
): boolean {
  const rank = (review: QualityReview) => {
    const status = qualityDecision(review, replacement).status;
    return status === "accepted" ? 2 : status === "rejected" ? 1 : 0;
  };
  const candidateRank = rank(candidate);
  const currentRank = rank(current);
  return (
    candidateRank > currentRank ||
    (candidateRank > 0 &&
      candidateRank === currentRank &&
      candidate.score >= current.score)
  );
}

const googleCheckNames = [
  "product_present",
  "no_duplicate",
  "old_target_removed",
  "background_preserved",
  "product_similarity",
  "aspect_ratio_plausible",
  "surface_contact",
  "perspective_consistent",
  "shadows_consistent",
  "no_melted_or_cut_parts",
  "calibration_respected",
];

export function googleQualityReview(payload: unknown): QualityReview {
  const parsed = z
    .object({
      accepted: z.boolean(),
      overallScore: z.number().finite().min(0).max(1),
      scaleCorrectionFactor: z.number().finite().min(0.65).max(1.5),
      feedback: z.string(),
      checks: z.array(
        z.object({
          name: z.string(),
          score: z.number().finite().min(0).max(1),
          reason: z.string(),
        }),
      ),
    })
    .safeParse(payload);
  if (!parsed.success) return unavailableQualityReview();
  const r = parsed.data;
  if (
    r.checks.length !== googleCheckNames.length ||
    googleCheckNames.some(
      (name) => r.checks.filter((c) => c.name === name).length !== 1,
    )
  ) {
    return unavailableQualityReview();
  }
  const check = (name: string) => r.checks.find((c) => c.name === name)!.score;
  return {
    accepted: r.accepted,
    score: r.overallScore,
    replacementComplete: check("old_target_removed") >= 0.7,
    scaleAndPerspectivePlausible:
      check("aspect_ratio_plausible") >= 0.7 &&
      check("perspective_consistent") >= 0.7 &&
      check("calibration_respected") >= 0.7,
    scaleCorrectionFactor: r.scaleCorrectionFactor,
    photorealistic:
      check("surface_contact") >= 0.68 && check("shadows_consistent") >= 0.65,
    duplicateProduct: check("no_duplicate") < 0.7,
    artifactsPresent: check("no_melted_or_cut_parts") < 0.68,
    productIdentityPreserved: check("product_similarity") >= 0.7,
    backgroundPreserved: check("background_preserved") >= 0.7,
    allProductsPresent: check("product_present") >= 0.7,
    feedback: r.feedback.slice(0, 300),
    checks: r.checks,
  };
}

export class RenderQualityError extends Error {
  readonly status = 422;
  constructor(readonly decision: QualityDecision) {
    super(
      decision.status === "unavailable"
        ? decision.feedback
        : "Le rendu n’a pas passé le contrôle qualité. L’aperçu est conservé et aucun crédit n’est débité.",
    );
  }
}

export function requireAcceptedQuality(
  decision: QualityDecision,
  mockMode = false,
): void {
  if (
    decision.status !== "accepted" &&
    !(mockMode && decision.status === "simulated")
  ) {
    throw new RenderQualityError(decision);
  }
}
