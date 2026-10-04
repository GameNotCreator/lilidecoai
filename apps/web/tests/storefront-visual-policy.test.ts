import { describe, expect, it, vi } from "vitest";
import { renderRequestSchema, type QualityDecision } from "@lili/types";
import { canShowStorefrontAdjustmentPreview } from "../lib/storefront-adjustment-preview";
import { confirmedStorefrontReplacementRegion, resolveStorefrontVisualScale } from "../lib/server/storefront-visual-policy";
import { renderResponse } from "../lib/server/serializers";
import type { RenderDocument } from "../lib/server/types";
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/assets", () => ({ assetUrl: (id?: string) => id ? `/api/assets/${id}` : null }));

const productId = "11111111-1111-4111-8111-111111111111";
const sceneId = "22222222-2222-4222-8222-222222222222";
const placementId = `${productId}:0`;
const region = { xMin: 0.1, yMin: 0.3, xMax: 0.8, yMax: 0.9 };
const object = { productId, placementPoint: { x: 0.4, y: 0.8 },
  dimensionPair: { mode: "height_length" as const, heightCm: 14, lengthCm: 14 }, visualWidthNormalized: 0.15 };
const request = { workflow: "simple_point", placement: { sceneId, productId }, placementPoint: object.placementPoint,
  simplePlacements: [object], idempotencyKey: "visual-1" };
function decision(replacement = false): QualityDecision {
  const names = ["photo_usable", "background_preserved", "no_unrequested_products", "review.confidence",
    ...(replacement ? ["replacement_complete"] : []),
    ...["confidence", "present", "identity", "position", "scale", "perspective", "contact", "edges", "occlusion", "noDuplicate",
      "gravity", "silhouetteComplete", "photographicCoherence", "supportIntegration", "geometry_position"].map(name => `${placementId}.${name}`)];
  return { version: "storefront-room-integration-review-v5", status: "rejected", score: 0.4, feedback: "Taille à ajuster.",
    checks: names.map(name => ({ name, score: name === `${placementId}.scale` ? 0.4 : 0.95, reason: "Contrôlé." })) };
}
describe("visual placement controls", () => {
  it("retains a bounded visual width without inventing a measured reference", () => {
    const parsed = renderRequestSchema.parse(request);
    expect(parsed.simplePlacements?.[0]?.visualWidthNormalized).toBe(0.15);
    expect(parsed.scaleReference).toBeUndefined();
    const visual = resolveStorefrontVisualScale(0.15, 736, 14)!;
    expect(visual).toMatchObject({ scaleSource: "visual_size", metricVerified: false });
    expect(visual.widthPx).toBeCloseTo(110.4, 10);
    expect(visual.pixelsPerCm).toBeCloseTo(110.4 / 14, 10);
    expect(visual.widthPixelsPerCm).toBe(visual.pixelsPerCm);
  });
  it.each([0, 0.019, 0.751, NaN, Infinity, "0.2"])("refuses malformed visual width %s", width => {
    expect(renderRequestSchema.safeParse({ ...request, simplePlacements: [{ ...object, visualWidthNormalized: width }] }).success).toBe(false);
  });
  it("accepts one width per item for the existing public multi-product route", () => {
    expect(renderRequestSchema.parse({ ...request, simplePlacements: [object,
      { ...object, placementPoint: { x: 0.75, y: 0.8 }, visualWidthNormalized: 0.1 }] }).simplePlacements).toHaveLength(2);
  });
  it("accepts a confirmed region larger than the historical .35 limit", () => {
    expect(renderRequestSchema.parse({ ...request, replaceExisting: true, replacementRegion: region }).replacementRegion).toEqual(region);
    expect(confirmedStorefrontReplacementRegion(region, true, [object.placementPoint])).toEqual(region);
  });
  it.each([
    { ...request, replacementRegion: region },
    { ...request, replaceExisting: false, replacementRegion: region },
    { ...request, replaceExisting: true, replacementRegion: { ...region, xMin: 0.5 } },
    { ...request, replaceExisting: true, replacementRegion: { ...region, xMax: 1.1 } },
    { ...request, replaceExisting: true, replacementRegion: { ...region, xMin: 0.8 } },
    { ...request, replaceExisting: true, replacementRegion: { xMin: 0, yMin: 0, xMax: 1, yMax: 1 } },
    { ...request, replaceExisting: true, replacementRegion: { ...region, hidden: "erase everything" } },
    { ...request, replaceExisting: true, replacementRegion: region, simplePlacements: [object, object] },
  ])("rejects unconfirmed, outside, oversized or multi-object erase regions", value => {
    expect(renderRequestSchema.safeParse(value).success).toBe(false);
  });
});
describe("owner-only adjustment candidate", () => {
  it("permits geometric advice while retaining the refused quality status", () => {
    const review = decision();
    expect(canShowStorefrontAdjustmentPreview(review, [placementId])).toBe(true);
    expect(review.status).toBe("rejected");
  });
  it.each(["photo_usable", "background_preserved", "no_unrequested_products", "review.confidence", `${placementId}.confidence`, `${placementId}.present`,
    `${placementId}.identity`, `${placementId}.noDuplicate`, `${placementId}.silhouetteComplete`])(
    "withholds a candidate with failed essential evidence %s", name => {
      const review = decision(); review.checks.find(check => check.name === name)!.score = 0.79;
      expect(canShowStorefrontAdjustmentPreview(review, [placementId])).toBe(false);
    });
  it("requires a complete known review and exactly one copy of each evidence", () => {
    const review = decision();
    expect(canShowStorefrontAdjustmentPreview({ ...review, status: "unavailable" }, [placementId])).toBe(false);
    expect(canShowStorefrontAdjustmentPreview({ ...review, version: "quality-v1" }, [placementId])).toBe(false);
    expect(canShowStorefrontAdjustmentPreview({ ...review, checks: review.checks.slice(0, -1) }, [placementId])).toBe(false);
    expect(canShowStorefrontAdjustmentPreview({ ...review, checks: [...review.checks, review.checks[0]] }, [placementId])).toBe(false);
    expect(canShowStorefrontAdjustmentPreview(review, [`${productId}:1`])).toBe(false);
  });
  it("never labels an incomplete replacement as an adjustment candidate", () => {
    expect(canShowStorefrontAdjustmentPreview(decision(), [placementId], true)).toBe(false);
    const review = decision(true); review.checks.find(check => check.name === "replacement_complete")!.score = 0.79;
    expect(canShowStorefrontAdjustmentPreview(review, [placementId], true)).toBe(false);
    expect(canShowStorefrontAdjustmentPreview(decision(true), [placementId], true)).toBe(true);
  });
  it("serializes a v9 failed candidate privately without publishing a final URL or changing credit", () => {
    const row = { id: "render", status: "failed", publicSessionId: "storefront:owner", createdAt: new Date(),
      engineVersions: { prompt: "storefront-myarchitect-room-v9", mockMode: false }, compositeAssetId: "candidate", creditCharged: false,
      qualityDecision: decision(), requestSnapshot: { version: 1, input: { ...request, workflow: "simple_point" } } } as RenderDocument;
    expect(renderResponse(row)).toMatchObject({ adjustmentPreviewUrl: "/api/assets/candidate", resultUrl: null,
      status: "failed", creditCharged: false, qualityDecision: { status: "rejected" } });
    expect(renderResponse({ ...row, engineVersions: { ...row.engineVersions!, prompt: "storefront-myarchitect-room-v6" } }).adjustmentPreviewUrl).toBeNull();
    expect(renderResponse({ ...row, status: "cancelled" }).adjustmentPreviewUrl).toBeNull();
    expect(renderResponse({ ...row, creditCharged: true }).adjustmentPreviewUrl).toBeNull();
    expect(renderResponse({ ...row, publicSessionId: "guest:other" }).adjustmentPreviewUrl).toBeNull();
  });
});
