import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { PreparedProductView } from "@lili/types";
import { globalRoom } from "./fixtures/spatial-room";
vi.mock("server-only", () => ({}));
import {
  buildOrientedPlacementPlan,
  localCameraOrientation,
  localOrientationBounds,
  selectOrientedView,
  transformOrientedPoint,
} from "../lib/server/oriented-selection";
import {
  composeOrientedView,
  harmonizeOrientedLayers,
} from "../lib/server/oriented-composite";
import {
  decideOrientedQuality,
  type OrientedVisualReview,
} from "../lib/server/oriented-quality";

const fingerprint = "f".repeat(64);
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const fullCoverage = {
  azimuthMinDeg: -100,
  azimuthMaxDeg: 100,
  elevationMinDeg: 0,
  elevationMaxDeg: 85,
};
function preparedView(): PreparedProductView {
  return {
    schemaVersion: 1,
    id: "view",
    organizationId: "org",
    productId: "product",
    variantId: null,
    revision: 1,
    sourceFingerprint: fingerprint,
    geometryFingerprint: fingerprint,
    sources: [{ assetId: "real-photo", sha256: fingerprint, role: "front" }],
    origin: "generated",
    state: "approved",
    image: {
      assetId: "prepared",
      sha256: fingerprint,
      widthPx: 80,
      heightPx: 120,
    },
    alpha: {
      assetId: "alpha",
      sha256: fingerprint,
      widthPx: 80,
      heightPx: 120,
    },
    visibleBounds: { x: 0.25, y: 1 / 6, width: 0.5, height: 2 / 3 },
    anchor: { x: 0.5, y: 5 / 6, confidence: 1 },
    physicalHeightSegment: {
      bottom: { x: 0.5, y: 5 / 6 },
      top: { x: 0.5, y: 1 / 6 },
    },
    orientation: {
      convention: "camera-product-degrees-v1",
      requested: { azimuthDeg: 0, elevationDeg: 40, rollDeg: 0 },
      estimated: { azimuthDeg: 0, elevationDeg: 35, rollDeg: 0 },
      coverage: fullCoverage,
    },
    review: {
      id: "review",
      kind: "human",
      actorId: "reviewer",
      decision: "approved",
      criteria: {
        identity: "pass",
        silhouette: "pass",
        color: "pass",
        pattern: "pass",
        alpha: "pass",
        contact: "pass",
      },
      coverage: fullCoverage,
      allowedUsage: "internal_preview",
      limits: [],
      unknownFaces: ["back"],
      evidenceAssetIds: ["real-photo", "prepared"],
      policyVersion: "prepared-review-v1",
      reviewedAt: "2026-10-03T12:00:00Z",
    },
    versions: {
      preparation: "prepared-view-v1",
      mask: "fixture",
      prompt: "fixture",
      providerConfiguration: "fixture",
    },
    preparation: { taskId: "preparation", costUsd: 0 },
    createdAt: "2026-10-03T12:00:00Z",
    updatedAt: "2026-10-03T12:00:00Z",
  };
}
function planInput(view = preparedView()) {
  return {
    scene: structuredClone(globalRoom),
    fingerprint,
    width: 600,
    height: 400,
    point: { x: 0.5, y: 0.8 },
    kind: "floor" as const,
    size: { widthCm: 24, heightCm: 40, depthCm: 24 },
    views: [view],
    organizationId: "org",
    productId: "product",
    variantId: null,
    sourceFingerprint: fingerprint,
    geometryFingerprint: fingerprint,
  };
}
async function fixture(
  configureInput?: (input: ReturnType<typeof planInput>) => void,
) {
  const view = preparedView(),
    imagePixels = Buffer.alloc(80 * 120 * 3),
    alphaPixels = Buffer.alloc(80 * 120);
  for (let y = 20; y < 100; y++)
    for (let x = 20; x < 60; x++) {
      const i = y * 80 + x;
      alphaPixels[i] = 255;
      imagePixels[3 * i] = (x + y) % 2 ? 150 : 90;
      imagePixels[3 * i + 1] = 65;
      imagePixels[3 * i + 2] = 45;
    }
  const viewImage = await sharp(imagePixels, {
    raw: { width: 80, height: 120, channels: 3 },
  })
    .png()
    .toBuffer();
  const viewAlpha = await sharp(alphaPixels, {
    raw: { width: 80, height: 120, channels: 1 },
  })
    .png()
    .toBuffer();
  view.image!.sha256 = sha(viewImage);
  view.alpha!.sha256 = sha(viewAlpha);
  const input = planInput(view);
  configureInput?.(input);
  const plan = buildOrientedPlacementPlan(input);
  const scene = await sharp({
    create: {
      width: 600,
      height: 400,
      channels: 3,
      background: { r: 180, g: 165, b: 145 },
    },
  })
    .png()
    .toBuffer();
  const layers = await composeOrientedView({
    scene,
    viewImage,
    viewAlpha,
    plan,
  });
  const restored = await harmonizeOrientedLayers({
    layers,
    generated: layers.previewPng,
  });
  const review: OrientedVisualReview = {
    availability: "available",
    kind: "automated",
    reviewer: "fixture-only",
    criteria: {
      identity: { status: "pass", observations: [] },
      angle: { status: "pass", observations: [] },
      geometry: { status: "pass", observations: [] },
      contact: { status: "pass", observations: [] },
      shadow: { status: "pass", observations: [] },
      background: { status: "pass", observations: [] },
    },
    evidence: {
      originalAssetIds: ["real-photo"],
      preparedImageSha256: view.image!.sha256,
      planFingerprint: plan.planFingerprint,
      resultSha256: restored.report.outputSha256,
      providerOutputReviewed: true,
    },
  };
  return { view, plan, scene, viewImage, viewAlpha, layers, restored, review };
}

describe("local orientation and immutable placement", () => {
  it("changes local elevation with depth and azimuth with sideways movement/yaw", () => {
    const camera = {
      width: 600,
      height: 400,
      focalPx: 600,
      pitchDownDegrees: 30,
      heightAboveSupportCm: 150,
    };
    const far = localCameraOrientation(camera, { x: 300, y: 220 }, 40, 0);
    const near = localCameraOrientation(camera, { x: 300, y: 320 }, 40, 0);
    expect(near.elevationDeg).toBeGreaterThan(far.elevationDeg);
    const side = localCameraOrientation(camera, { x: 400, y: 320 }, 40, 0);
    expect(side.azimuthDeg).toBeGreaterThan(0);
    expect(
      localCameraOrientation(camera, { x: 400, y: 320 }, 40, 20).azimuthDeg,
    ).toBeCloseTo(side.azimuthDeg - 20);
    expect(
      localCameraOrientation(
        { ...camera, heightAboveSupportCm: 80 },
        { x: 300, y: 320 },
        40,
        0,
      ).elevationDeg,
    ).toBeLessThan(near.elevationDeg);
  });
  it("tracks crop/resize and EXIF point lineage without changing the full-frame camera", () => {
    expect(
      transformOrientedPoint({ x: 200, y: 160 }, [2, 0, 0, 2, -200, -100]),
    ).toEqual({ x: 200, y: 220 });
    expect(
      transformOrientedPoint({ x: 10, y: 20 }, [0, 1, -1, 0, 400, 0]),
    ).toEqual({ x: 380, y: 10 });
    expect(() =>
      transformOrientedPoint({ x: 0, y: 0 }, [0, 0, 0, 0, 0, 0]),
    ).toThrow(/dégénérée/);
  });
  it("encloses intermediate camera values as well as interval corners", () => {
    const bounds = localOrientationBounds({
      width: 600,
      height: 400,
      anchor: { x: 390, y: 310 },
      productHeightCm: 40,
      yawDegrees: 10,
      focalPx: [540, 660],
      pitchDownDegrees: [25, 35],
      heightAboveSupportCm: [140, 160],
    });
    for (let i = 0; i <= 10; i++)
      for (let j = 0; j <= 10; j++)
        for (let k = 0; k <= 10; k++) {
          const angle = localCameraOrientation(
            {
              width: 600,
              height: 400,
              focalPx: 540 + i * 12,
              pitchDownDegrees: 25 + j,
              heightAboveSupportCm: 140 + k * 2,
            },
            { x: 390, y: 310 },
            40,
            10,
          );
          expect(angle.azimuthDeg).toBeGreaterThanOrEqual(
            bounds.azimuthMinDeg - 1e-9,
          );
          expect(angle.azimuthDeg).toBeLessThanOrEqual(
            bounds.azimuthMaxDeg + 1e-9,
          );
          expect(angle.elevationDeg).toBeGreaterThanOrEqual(
            bounds.elevationMinDeg - 1e-9,
          );
          expect(angle.elevationDeg).toBeLessThanOrEqual(
            bounds.elevationMaxDeg + 1e-9,
          );
        }
  });
  it("requires the complete uncertainty interval and a human-approved current variant", () => {
    const plan = buildOrientedPlacementPlan(planInput());
    const choose = (views: PreparedProductView[]) =>
      selectOrientedView({
        ...planInput(),
        views,
        localOrientation: plan.localOrientation,
        uncertainty: plan.orientationUncertainty,
      });
    const narrow = preparedView();
    narrow.orientation.coverage = {
      ...fullCoverage,
      elevationMinDeg: plan.localOrientation.elevationDeg,
      elevationMaxDeg: plan.localOrientation.elevationDeg,
    };
    expect(() => choose([narrow])).toThrow(/incertitude/);
    for (const mutation of [
      { state: "needs_review" },
      { state: "revoked" },
      { variantId: "other" },
      { organizationId: "other" },
      { geometryFingerprint: "b".repeat(64) },
      { physicalHeightSegment: null },
    ])
      expect(() =>
        choose([{ ...preparedView(), ...mutation } as PreparedProductView]),
      ).toThrow();
    const automated = preparedView();
    automated.review!.kind = "agent";
    expect(() => choose([automated])).toThrow();
    const photo = {
      ...preparedView(),
      id: "real-view",
      origin: "photographed" as const,
    };
    expect(choose([preparedView(), photo]).id).toBe("real-view");
  });
  it("scales from the annotated physical segment instead of the full PNG height", () => {
    const plan = buildOrientedPlacementPlan(planInput());
    expect(plan.transform.scale).toBeCloseTo(
      plan.projectedPhysicalHeightPx / 80,
    );
    expect(plan.transform.scale).not.toBeCloseTo(
      plan.projectedPhysicalHeightPx / 120,
    );
    expect(plan.visibleBounds.width / plan.visibleBounds.height).toBeCloseTo(
      40 / 80,
    );
    const doubledCanvas = preparedView();
    doubledCanvas.image!.heightPx *= 2;
    doubledCanvas.alpha!.heightPx *= 2;
    doubledCanvas.visibleBounds!.y /= 2;
    doubledCanvas.visibleBounds!.height /= 2;
    doubledCanvas.anchor!.y /= 2;
    doubledCanvas.physicalHeightSegment!.top.y /= 2;
    doubledCanvas.physicalHeightSegment!.bottom.y /= 2;
    const same = buildOrientedPlacementPlan(planInput(doubledCanvas));
    expect(same.visibleBounds).toEqual(plan.visibleBounds);
    expect(same.metricVerified).toBe(false);
  });
  it("refuses frame clipping, enclosed holes and impossible prepared envelopes", () => {
    expect(() =>
      buildOrientedPlacementPlan({
        ...planInput(),
        point: { x: 0.01, y: 0.8 },
      }),
    ).toThrow();
    const input = planInput();
    input.scene.surfaces[0]!.holes = [
      [
        { x: 0.48, y: 0.79 },
        { x: 0.49, y: 0.79 },
        { x: 0.49, y: 0.8 },
        { x: 0.48, y: 0.8 },
      ],
    ];
    expect(() => buildOrientedPlacementPlan(input)).toThrow(/support/);
    const wide = preparedView();
    wide.visibleBounds = { x: 0, y: 1 / 6, width: 1, height: 2 / 3 };
    expect(() => buildOrientedPlacementPlan(planInput(wide))).toThrow(
      /enveloppe/,
    );
  });
});

describe("oriented layers", () => {
  it("uses only the selected source and preserves every original pixel outside its silhouette/contact mask", async () => {
    const f = await fixture();
    const malicious = await sharp({
      create: { width: 600, height: 400, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    const result = await harmonizeOrientedLayers({
      layers: f.layers,
      generated: malicious,
    });
    const finalPixels = await sharp(result.png).removeAlpha().raw().toBuffer();
    let backgroundDifferences = 0,
      textureDifferences = 0;
    for (let i = 0; i < 600 * 400; i++) {
      if (
        !f.layers.permittedMask[i] &&
        !finalPixels
          .subarray(i * 3, i * 3 + 3)
          .equals(f.layers.backgroundRgb.subarray(i * 3, i * 3 + 3))
      )
        backgroundDifferences++;
      if (
        f.layers.productAlpha[i] === 255 &&
        finalPixels[i * 3 + 1] !==
          Math.round(f.layers.productRgb[i * 3 + 1]! * 1.1)
      )
        textureDifferences++;
    }
    expect(backgroundDifferences).toBe(0);
    expect(textureDifferences).toBe(0);
    expect(result.report.backgroundChangedPixels).toBe(0);
    expect(result.report.productExposure).toBe(1.1);
    expect(result.report.imageSha256).toBe(f.view.image!.sha256);
    expect(result.report.maxShadowDarkening).toBeLessThanOrEqual(0.18);
    expect(
      f.layers.contactShadow.filter((value) => value > 0).length,
    ).toBeLessThan(f.layers.productAlpha.filter((value) => value > 0).length);
    expect(f.layers.evidence.contactDistanceRatio).toBeLessThan(0.04);
  });
  it("refuses mismatched source hashes and changed provider framing", async () => {
    const f = await fixture();
    await expect(
      composeOrientedView({
        scene: f.scene,
        viewImage: f.viewAlpha,
        viewAlpha: f.viewAlpha,
        plan: f.plan,
      }),
    ).rejects.toThrow(/snapshot/);
    const wrongFrame = await sharp(f.scene).resize(300, 210).png().toBuffer();
    await expect(
      harmonizeOrientedLayers({ layers: f.layers, generated: wrongFrame }),
    ).rejects.toThrow(/cadrage/);
  });
  it("accepts a provider resolution change without changing its frame or evidence", async () => {
    const f = await fixture();
    for (const width of [300, 1200]) {
      const providerOutput = await sharp(f.layers.previewPng)
        .resize({ width })
        .png()
        .toBuffer();
      const originalHash = sha(providerOutput);
      const result = await harmonizeOrientedLayers({
        layers: f.layers,
        generated: providerOutput,
      });
      const metadata = await sharp(result.png).metadata();
      expect([metadata.width, metadata.height]).toEqual([600, 400]);
      expect(result.report.backgroundChangedPixels).toBe(0);
      expect(result.report.imageSha256).toBe(f.view.image!.sha256);
      expect(sha(providerOutput)).toBe(originalHash);
    }
    // This ratio passes the adapter's 2% allowance, but a uniform scale cannot
    // restore its full frame. The layer stage must still refuse it.
    const changedRatio = await sharp(f.layers.previewPng)
      .resize(1200, 808)
      .png()
      .toBuffer();
    await expect(
      harmonizeOrientedLayers({ layers: f.layers, generated: changedRatio }),
    ).rejects.toThrow(/cadrage/);
  });
  it("keeps the entire product above a thin support while clipping only its shadow", async () => {
    const f = await fixture((input) => {
      input.size.depthCm = 1;
      const footprint = buildOrientedPlacementPlan(input).spatial.projection
        .footprint;
      const top = Math.min(...footprint.map((p) => p.y)) / input.height - 0.0001;
      const bottom =
        Math.max(...footprint.map((p) => p.y)) / input.height + 0.0001;
      input.scene.surfaces[0]!.boundary = [
        { x: 0.1, y: top },
        { x: 0.9, y: top },
        { x: 0.9, y: bottom },
        { x: 0.1, y: bottom },
      ];
    });
    expect(f.plan.spatial.fits).toBe(true);
    expect(f.plan.spatial.supportFits).toBe(true);
    const preview = await sharp(f.layers.previewPng).removeAlpha().raw().toBuffer();
    const final = await sharp(f.restored.png).removeAlpha().raw().toBuffer();
    let checked = 0;
    for (let i = 0; i < f.layers.productAlpha.length; i++) {
      const y = Math.floor(i / 600) + 0.5;
      if (
        y >= f.plan.anchor.y - 4 &&
        y < f.plan.anchor.y - 1 &&
        f.layers.productAlpha[i] === 255
      ) {
        checked++;
        expect(f.layers.foregroundProtection[i]).toBe(0);
        const source = f.layers.productRgb.subarray(3 * i, 3 * i + 3);
        expect(preview.subarray(3 * i, 3 * i + 3)).toEqual(source);
        expect(final.subarray(3 * i, 3 * i + 3)).toEqual(source);
        expect(f.layers.contactShadow[i]).toBe(0);
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
  it("rejects foreground overlap and preserves explicit protected pixels", async () => {
    const f = await fixture();
    const input = planInput(f.view);
    input.scene.surfaces[0]!.obstacles = [
      [
        { x: 0.49, y: 0.65 },
        { x: 0.51, y: 0.65 },
        { x: 0.51, y: 0.7 },
        { x: 0.49, y: 0.7 },
      ],
    ];
    const plan = buildOrientedPlacementPlan(input);
    await expect(
      composeOrientedView({
        scene: f.scene,
        viewImage: f.viewImage,
        viewAlpha: f.viewAlpha,
        plan,
      }),
    ).rejects.toThrow(/obstacle/);
    const i = f.layers.productAlpha.findIndex((alpha) => alpha === 255);
    f.layers.foregroundProtection[i] = 255;
    const result = await harmonizeOrientedLayers({
      layers: f.layers,
      generated: f.layers.previewPng,
    });
    const pixels = await sharp(result.png).removeAlpha().raw().toBuffer();
    expect(pixels.subarray(i * 3, i * 3 + 3)).toEqual(
      f.layers.backgroundRgb.subarray(i * 3, i * 3 + 3),
    );
    expect(result.report.protectedChangedPixels).toBe(0);
  });
  it("bounds provider shadow darkness and never transfers scene texture outside contact", async () => {
    const f = await fixture();
    const black = await sharp({
      create: { width: 600, height: 400, channels: 3, background: "black" },
    })
      .png()
      .toBuffer();
    const result = await harmonizeOrientedLayers({
      layers: f.layers,
      generated: black,
      shadowMethod: "provider_luminance",
    });
    expect(result.report.maxShadowDarkening).toBeLessThanOrEqual(0.18 + 1e-6);
    expect(result.report.productExposure).toBe(0.9);
    expect(result.report.backgroundChangedPixels).toBe(0);
  });
});

describe("oriented quality decisions", () => {
  it("requires original references, provider review and independent review before any acceptance", async () => {
    const f = await fixture(),
      input = {
        plan: f.plan,
        layers: f.layers.evidence,
        restoration: f.restored.report,
        review: f.review,
        identityRevoked: false,
      };
    expect(decideOrientedQuality(input).decision).toBe("accepted");
    expect(decideOrientedQuality({ ...input, review: null }).decision).toBe(
      "indeterminate",
    );
    expect(
      decideOrientedQuality({
        ...input,
        review: { ...f.review, availability: "unavailable" },
      }).decision,
    ).toBe("indeterminate");
    for (const evidence of [
      { ...f.review.evidence, originalAssetIds: [] },
      { ...f.review.evidence, providerOutputReviewed: false },
      { ...f.review.evidence, resultSha256: "wrong" },
    ])
      expect(
        decideOrientedQuality({ ...input, review: { ...f.review, evidence } })
          .decision,
      ).toBe("indeterminate");
    expect(
      decideOrientedQuality({
        ...input,
        layers: { ...input.layers, productPixels: 20 },
      }).decision,
    ).toBe("indeterminate");
    expect(decideOrientedQuality(input).reviewKind).toBe("automated");
  });
  it("never averages away identity, contact or background failures", async () => {
    const f = await fixture(),
      input = {
        plan: f.plan,
        layers: f.layers.evidence,
        restoration: f.restored.report,
        review: f.review,
        identityRevoked: false,
      };
    expect(
      decideOrientedQuality({ ...input, identityRevoked: true }).decision,
    ).toBe("rejected");
    expect(
      decideOrientedQuality({
        ...input,
        restoration: { ...input.restoration, backgroundChangedPixels: 1 },
      }).decision,
    ).toBe("rejected");
    expect(
      decideOrientedQuality({
        ...input,
        layers: { ...input.layers, contactDistanceRatio: 0.2 },
      }).decision,
    ).toBe("rejected");
    for (const name of ["identity", "contact", "background"] as const) {
      const review = structuredClone(f.review);
      review.criteria[name].status = "fail";
      expect(decideOrientedQuality({ ...input, review }).decision).toBe(
        "rejected",
      );
    }
  });
  it("offers at most one budgeted shadow-only repair from the initial composition", async () => {
    const f = await fixture();
    f.review.criteria.shadow.status = "fail";
    const input = {
      plan: f.plan,
      layers: f.layers.evidence,
      restoration: f.restored.report,
      review: f.review,
      identityRevoked: false,
      repairBudgetAvailable: true,
      repairDeadlineAvailable: true,
    };
    expect(decideOrientedQuality(input).repair).toBe(
      "contact_shadow_from_initial_composition",
    );
    expect(
      decideOrientedQuality({ ...input, repairAttempts: 1 }).repair,
    ).toBeNull();
    expect(
      decideOrientedQuality({ ...input, repairBudgetAvailable: false }).repair,
    ).toBeNull();
    expect(
      decideOrientedQuality({ ...input, identityRevoked: true }).repair,
    ).toBeNull();
  });
});
