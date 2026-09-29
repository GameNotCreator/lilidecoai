import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  prepareSpatialVolumeNumericRepair,
  SPATIAL_VOLUME_NUMERIC_REPAIR_POLICY as policy,
  type VolumeReviewObservations,
} from "../lib/server/spatial-volume-repair";
import { planVolumeCrop } from "../lib/server/spatial-volume-geometry";

function input() {
  const expectedBox = {
    xMin: 1372.5433749768536 / 1920,
    yMin: 928.9871663541072 / 1280,
    xMax: 1531.0735853383503 / 1920,
    yMax: 1112.8197756345057 / 1280,
  };
  const expectedContact = { x: 1450 / 1920, y: 1070 / 1280 };
  const observations: VolumeReviewObservations = {
    policy,
    source: "validated-visual-review",
    coordinateSpace: "normalized-original-room",
    reviewConfidence: 0.92,
    products: [
      {
        productId: "basket",
        confidence: 0.92,
        foregroundOccluded: false,
        expectedBox,
        expectedContact,
        observedBox: { xMin: 0.71, yMin: 0.718, xMax: 0.799, yMax: 0.874 },
        observedContact: { x: 0.755, y: 0.841 },
      },
    ],
  };
  return {
    observations,
    productId: "basket",
    expectedBox,
    expectedContact,
    dimensions: { widthCm: 32, heightCm: 32, depthCm: 33 },
    yawDegrees: -54,
    candidateSha256: "a".repeat(64),
    transform: {
      version: 1 as const,
      frame: { width: 1920, height: 1280 },
      model: { width: 1024, height: 1024 },
      window: { left: 1096, top: 579, width: 701, height: 701 },
      intersection: { left: 1096, top: 579, width: 701, height: 701 },
      padding: { left: 0, top: 0, right: 0, bottom: 0 },
      scale: 1024 / 701,
      contextMarginPx: 92,
    },
  };
}
it("converts the first rejected basket edges into the frozen crop without changing target, contact or catalogue", () => {
  const source = input(),
    before = structuredClone(source),
    result = prepareSpatialVolumeNumericRepair(source);
  expect(source).toEqual(before);
  expect(result.status).toBe("ready");
  if (result.status !== "ready") throw new Error("Missing numeric diagnosis");
  expect(result.feedbackData.target.left).toBeCloseTo(403.9663566, 7);
  expect(result.feedbackData.target.top).toBeCloseTo(511.2508678, 7);
  expect(result.feedbackData.target.right).toBeCloseTo(635.542584, 7);
  expect(result.feedbackData.target.bottom).toBeCloseTo(779.7880888, 7);
  expect(result.feedbackData.observedMinusTargetEdges.left).toBeCloseTo(
    -13.64852493,
    7,
  );
  expect(result.feedbackData.observedMinusTargetEdges.top).toBeCloseTo(
    -14.53052546,
    7,
  );
  expect(result.feedbackData.excessBeyondUnchangedQaTolerance.left).toBeCloseTo(
    (3.0021665624 * 1024) / 701,
    7,
  );
  expect(result.feedbackData.excessBeyondUnchangedQaTolerance.top).toBeCloseTo(
    (2.5938619829 * 1024) / 701,
    7,
  );
  expect(result.feedbackData.excessBeyondUnchangedQaTolerance.right).toBe(0);
  expect(result.feedbackData.excessBeyondUnchangedQaTolerance.bottom).toBe(0);
  expect(result.feedbackData.targetContact.x).toBeCloseTo(517.1126961484, 7);
  expect(result.feedbackData.targetContact.y).toBeCloseTo(717.2382310984, 7);
  expect(result.feedbackData.dimensionsCm).toEqual(source.dimensions);
  expect(result.feedbackData.yawDegreesAlreadyApplied).toBe(-54);
  expect(result.prompt).toContain("No previous image is supplied");
  expect(result.prompt).toContain("not physical measurements");
  expect(result.prompt).toContain("fit the silhouette after generation");
  expect(JSON.parse(JSON.stringify(result))).toEqual(result);
});
it("reports the second basket's left and bottom overshoot using unchanged existing tolerances", () => {
  const source = input();
  source.observations.products[0]!.observedBox = {
    xMin: 0.7115,
    yMin: 0.723,
    xMax: 0.7984,
    yMax: 0.8773,
  };
  const result = prepareSpatialVolumeNumericRepair(source);
  if (result.status !== "ready") throw new Error("Missing numeric diagnosis");
  expect(result.feedbackData.excessBeyondUnchangedQaTolerance.left).toBeCloseTo(
    (0.1221665624 * 1024) / 701,
    7,
  );
  expect(
    result.feedbackData.excessBeyondUnchangedQaTolerance.bottom,
  ).toBeCloseTo((2.7709199943 * 1024) / 701, 7);
  expect(result.feedbackData.excessBeyondUnchangedQaTolerance.top).toBe(0);
  expect(result.feedbackData.excessBeyondUnchangedQaTolerance.right).toBe(0);
  expect(result.feedbackData.qaTolerance.x).toBeCloseTo(9.2630490962, 7);
  expect(result.feedbackData.qaTolerance.y).toBeCloseTo(10.741488839, 7);
});
it("maps padded crops using their original origin and preserves signed contact deltas", () => {
  const source = input();
  source.transform = planVolumeCrop(
    300,
    200,
    { left: 95, top: 70, right: 205, bottom: 180 },
    { left: 100, top: 75, right: 200, bottom: 175 },
  );
  source.expectedBox = source.observations.products[0]!.expectedBox = {
    xMin: 1 / 3,
    xMax: 2 / 3,
    yMin: 0.375,
    yMax: 0.875,
  };
  source.expectedContact = source.observations.products[0]!.expectedContact = {
    x: 0.5,
    y: 0.75,
  };
  source.observations.products[0]!.observedContact = { x: 0.49, y: 0.76 };
  const result = prepareSpatialVolumeNumericRepair(source);
  if (result.status !== "ready")
    throw new Error("Missing padded numeric diagnosis");
  expect(result.feedbackData.target).toEqual({
    left: 412,
    top: 462,
    right: 612,
    bottom: 662,
  });
  expect(result.feedbackData.targetContact).toEqual({ x: 512, y: 612 });
  expect(result.feedbackData.observedMinusTargetContact).toEqual({
    x: -6,
    y: 4,
  });
});
it.each([
  "missing",
  "policy",
  "coordinates",
  "product",
  "contract-box",
  "contract-contact",
  "review-confidence",
  "product-confidence",
  "occlusion",
  "no-box",
  "no-contact",
  "invalid-box",
  "candidate-hash",
])("cannot authorize numeric repair from %s observations", (kind) => {
  const source = input();
  const observed = source.observations.products[0]!;
  if (kind === "missing")
    (source as { observations?: VolumeReviewObservations }).observations =
      undefined;
  if (kind === "policy")
    (source.observations as unknown as { policy: string }).policy =
      "future-policy";
  if (kind === "coordinates")
    (
      source.observations as unknown as { coordinateSpace: string }
    ).coordinateSpace = "model-crop-pixels";
  if (kind === "product") observed.productId = "another-placement";
  if (kind === "contract-box")
    source.expectedBox = { ...source.expectedBox, xMin: 0.5 };
  if (kind === "contract-contact") source.expectedContact = { x: 0.5, y: 0.6 };
  if (kind === "review-confidence") source.observations.reviewConfidence = 0.89;
  if (kind === "product-confidence") observed.confidence = 0.89;
  if (kind === "occlusion") observed.foregroundOccluded = true;
  if (kind === "no-box") observed.observedBox = null;
  if (kind === "no-contact") observed.observedContact = null;
  if (kind === "invalid-box") observed.observedBox!.xMin = 1;
  if (kind === "candidate-hash") source.candidateSha256 = "invalid";
  expect(prepareSpatialVolumeNumericRepair(source)).toMatchObject({
    status: "unavailable",
    policy,
  });
});
