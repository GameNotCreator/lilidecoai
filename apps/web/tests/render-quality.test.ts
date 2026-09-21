import { describe, expect, it } from "vitest";
import {
  qualityDecision,
  preferQualityReview,
  qualityReviewSchema,
  requireAcceptedQuality,
  simulatedQualityDecision,
  unavailableQualityReview,
  googleQualityReview,
  type QualityReview,
} from "../lib/server/render-quality";

const valid: QualityReview = {
  accepted: true,
  score: 0.94,
  replacementComplete: true,
  scaleAndPerspectivePlausible: true,
  scaleCorrectionFactor: 1,
  photorealistic: true,
  duplicateProduct: false,
  artifactsPresent: false,
  productIdentityPreserved: true,
  backgroundPreserved: true,
  allProductsPresent: true,
  feedback: "Produit conforme, contact et éclairage cohérents.",
};

describe("quality delivery policy", () => {
  it("selects a valid repair over a higher-scored image with a broken product", () => {
    expect(
      preferQualityReview(
        { ...valid, score: 0.8 },
        { ...valid, score: 0.99, productIdentityPreserved: false },
        false,
      ),
    ).toBe(true);
    expect(preferQualityReview(unavailableQualityReview(), valid, false)).toBe(
      false,
    );
  });
  it("never invents a score for an unavailable check", () => {
    const decision = qualityDecision(unavailableQualityReview(), false);
    expect(decision).toMatchObject({
      status: "unavailable",
      score: null,
      checks: [],
    });
    expect(() => requireAcceptedQuality(decision)).toThrow();
  });
  it.each([
    "productIdentityPreserved",
    "backgroundPreserved",
    "allProductsPresent",
    "scaleAndPerspectivePlausible",
    "photorealistic",
  ] as const)("rejects %s even at 99%% confidence", (flag) => {
    expect(
      qualityDecision({ ...valid, score: 0.99, [flag]: false }, false).status,
    ).toBe("rejected");
  });
  it.each(["duplicateProduct", "artifactsPresent"] as const)(
    "rejects %s",
    (flag) => {
      expect(qualityDecision({ ...valid, [flag]: true }, false).status).toBe(
        "rejected",
      );
    },
  );
  it("requires completed removal only for replacement", () => {
    const review = { ...valid, replacementComplete: false };
    expect(qualityDecision(review, true).status).toBe("rejected");
    expect(qualityDecision(review, false).status).toBe("accepted");
  });
  it("rejects malformed provider booleans and non-finite scores", () => {
    expect(
      qualityReviewSchema.safeParse({ ...valid, accepted: "false" }).success,
    ).toBe(false);
    expect(qualityDecision({ ...valid, score: NaN }, false).status).toBe(
      "unavailable",
    );
    expect(qualityDecision({ ...valid, score: Infinity }, false).status).toBe(
      "unavailable",
    );
  });
  it("allows simulated delivery only in explicit mock mode with no quality score", () => {
    const simulated = simulatedQualityDecision();
    expect(simulated.score).toBeNull();
    expect(() => requireAcceptedQuality(simulated)).toThrow();
    expect(() => requireAcceptedQuality(simulated, true)).not.toThrow();
  });
  it("does not synthesize missing Google checks", () => {
    const review = googleQualityReview({
      accepted: true,
      overallScore: 0.99,
      scaleCorrectionFactor: 1,
      feedback: "ok",
      checks: [],
    });
    expect(qualityDecision(review, false).status).toBe("unavailable");
  });
});
