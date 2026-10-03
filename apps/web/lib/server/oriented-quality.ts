import "server-only";
import type { OrientedPlacementPlan } from "./oriented-selection";
import type {
  OrientedRestorationReport,
  RenderLayerSet,
} from "./oriented-composite";

export const ORIENTED_QUALITY_POLICY = Object.freeze({
  version: "oriented-quality-v1" as const,
  minProductPixels: 400,
  minProductShortSidePx: 16,
  maxContactDistanceRatio: 0.04,
  maxRepairAttempts: 1,
  qualification: "development_thresholds_not_pilot_qualified" as const,
});

export type OrientedCriterion =
  "identity" | "angle" | "geometry" | "contact" | "shadow" | "background";
export type OrientedCriterionResult = {
  status: "pass" | "fail" | "indeterminate";
  observations: string[];
};
export type OrientedVisualReview = {
  availability: "available" | "unavailable";
  kind: "human" | "automated" | "agent";
  /** Stable reviewer/model identity, never interpreted as a human signature. */
  reviewer: string;
  criteria: Record<OrientedCriterion, OrientedCriterionResult>;
  evidence: {
    originalAssetIds: string[];
    preparedImageSha256: string;
    planFingerprint: string;
    resultSha256: string;
    /** The un-restored provider output must be checked for duplication/cropping. */
    providerOutputReviewed: boolean;
  };
};

export type OrientedQualityDecision = {
  policyVersion: typeof ORIENTED_QUALITY_POLICY.version;
  decision: "accepted" | "rejected" | "indeterminate";
  criteria: Record<OrientedCriterion, OrientedCriterionResult>;
  reasons: string[];
  reviewKind: OrientedVisualReview["kind"] | null;
  reviewer: string | null;
  repair: "contact_shadow_from_initial_composition" | null;
  metricVerified: false;
  pilotQualified: false;
};

const criterionNames: OrientedCriterion[] = [
  "identity",
  "angle",
  "geometry",
  "contact",
  "shadow",
  "background",
];

/** No aggregate score: identity, contact and the original room always veto.
 * An independent review receives originals as well as the prepared rendition. */
export function decideOrientedQuality(input: {
  plan: OrientedPlacementPlan;
  layers: RenderLayerSet["evidence"];
  restoration: OrientedRestorationReport;
  review: OrientedVisualReview | null;
  /** Rechecked from the catalog before delivery; a snapshot is not revocation proof. */
  identityRevoked: boolean;
  repairAttempts?: number;
  repairBudgetAvailable?: boolean;
  repairDeadlineAvailable?: boolean;
}): OrientedQualityDecision {
  const { plan, restoration, layers, review } = input;
  const criteria = Object.fromEntries(
    criterionNames.map((name) => [
      name,
      {
        status:
          review?.availability === "available"
            ? review.criteria[name].status
            : "indeterminate",
        observations:
          review?.availability === "available"
            ? review.criteria[name].observations.slice()
            : ["Revue indépendante indisponible."],
      },
    ]),
  ) as Record<OrientedCriterion, OrientedCriterionResult>;
  const mark = (
    criterion: OrientedCriterion,
    status: "fail" | "indeterminate",
    observation: string,
  ) => {
    if (criteria[criterion].status !== "fail")
      criteria[criterion].status = status;
    criteria[criterion].observations.push(observation);
  };
  if (input.identityRevoked)
    mark(
      "identity",
      "fail",
      "Vue révoquée pour un incident d’identité avant livraison.",
    );
  if (
    restoration.viewId !== plan.view.id ||
    restoration.imageSha256 !== plan.view.image?.sha256 ||
    restoration.alphaSha256 !== plan.view.alpha?.sha256
  )
    mark(
      "identity",
      "fail",
      "La restitution ne provient pas de la vue admise.",
    );
  if (
    restoration.backgroundChangedPixels !== 0 ||
    restoration.protectedChangedPixels !== 0 ||
    restoration.outputEncoding !== "png"
  )
    mark(
      "background",
      "fail",
      "Des pixels protégés ont changé ou la preuve n’est pas sans perte.",
    );
  if (!plan.spatial.fits || !plan.spatial.supportFits || !layers.ratioPreserved)
    mark(
      "geometry",
      "fail",
      "La pose ne respecte pas le cadre, le support ou le ratio approuvé.",
    );
  if (
    !Number.isFinite(layers.contactDistanceRatio) ||
    layers.contactDistanceRatio >
      ORIENTED_QUALITY_POLICY.maxContactDistanceRatio
  )
    mark(
      "contact",
      "fail",
      "La silhouette est trop éloignée de son appui prévu.",
    );
  if (
    !Number.isFinite(layers.productPixels) ||
    !Number.isFinite(layers.productShortSidePx) ||
    layers.productPixels < ORIENTED_QUALITY_POLICY.minProductPixels ||
    layers.productShortSidePx < ORIENTED_QUALITY_POLICY.minProductShortSidePx
  )
    mark(
      "identity",
      "indeterminate",
      "Le produit est trop petit dans le résultat pour vérifier ses détails distinctifs.",
    );
  if (
    !Number.isFinite(restoration.productExposure) ||
    restoration.productExposure < 0.9 ||
    restoration.productExposure > 1.1
  )
    mark(
      "identity",
      "fail",
      "La correction de lumière du produit dépasse les bornes admises.",
    );
  if (
    !Number.isFinite(restoration.maxShadowDarkening) ||
    restoration.maxShadowDarkening > 0.18 + 1e-6
  )
    mark(
      "shadow",
      "fail",
      "L’obscurcissement dépasse la limite locale autorisée.",
    );
  if (review?.availability === "available") {
    const evidence = review.evidence;
    const allOriginalsSeen = plan.view.sources.every((source) =>
      evidence.originalAssetIds.includes(source.assetId),
    );
    if (
      !allOriginalsSeen ||
      evidence.preparedImageSha256 !== plan.view.image?.sha256 ||
      evidence.planFingerprint !== plan.planFingerprint ||
      evidence.resultSha256 !== restoration.outputSha256 ||
      !evidence.providerOutputReviewed
    )
      for (const criterion of criterionNames)
        mark(
          criterion,
          "indeterminate",
          "La revue ne couvre pas toutes les sources et sorties requises de ce rendu.",
        );
  }
  const failures = criterionNames.filter(
    (name) => criteria[name].status === "fail",
  );
  const unknown = criterionNames.filter(
    (name) => criteria[name].status === "indeterminate",
  );
  const decision = failures.length
    ? "rejected"
    : unknown.length
      ? "indeterminate"
      : "accepted";
  const canRepairShadow =
    failures.length === 1 &&
    failures[0] === "shadow" &&
    unknown.length === 0 &&
    (input.repairAttempts ?? 0) < ORIENTED_QUALITY_POLICY.maxRepairAttempts &&
    input.repairBudgetAvailable === true &&
    input.repairDeadlineAvailable === true;
  return {
    policyVersion: ORIENTED_QUALITY_POLICY.version,
    decision,
    criteria,
    reasons: criterionNames
      .filter((name) => criteria[name].status !== "pass")
      .flatMap((name) =>
        criteria[name].observations.map(
          (observation) => `${name}: ${observation}`,
        ),
      ),
    reviewKind: review?.kind ?? null,
    reviewer: review?.reviewer ?? null,
    repair: canRepairShadow ? "contact_shadow_from_initial_composition" : null,
    metricVerified: false,
    pilotQualified: false,
  };
}
