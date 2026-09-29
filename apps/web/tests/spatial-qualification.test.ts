import { describe, it, expect } from "vitest";
import {
  qualifySpatialCorpus,
  qualificationImages,
  spatialQualificationV2Schema,
} from "../lib/spatial-qualification";
const cases = () =>
  Array.from({ length: 30 }, (_, i) => ({
    id: String(i),
    family: String(i % 5),
    holdout: i > 20,
    human: {
      acceptable: true,
      majorDesignDefect: false,
      majorBackgroundDefect: false,
    },
    calibrated: i < 10,
    reference: i < 10 ? `measured-scene-${i}` : null,
    projectedDimensionError: i < 10 ? 0.08 : null,
    outcome: "delivered",
    durationMs: 1000 + i,
  }));
describe("spatial qualification", () => {
  it("requires human and metric evidence even for attractive candidates", () => {
    const incomplete = cases()
      .slice(0, 8)
      .map((item) => ({
        ...item,
        human: null,
        calibrated: false,
        reference: null,
        projectedDimensionError: null,
      }));
    expect(
      qualifySpatialCorpus({ version: 1, cases: incomplete }).qualified,
    ).toBe(false);
  });
  it("implements the launch thresholds and preserves the full denominator", () => {
    const legacy = qualifySpatialCorpus({ version: 1, cases: cases() });
    expect(legacy.qualified).toBe(false);
    expect(legacy.blockers).toEqual([
      "Format v1 : provenance des images et du moteur non vérifiable",
    ]);
    const bad = cases();
    bad[0]!.projectedDimensionError = 0.21;
    expect(qualifySpatialCorpus({ version: 1, cases: bad }).qualified).toBe(
      false,
    );
    bad[0]!.projectedDimensionError = 0.08;
    bad[0]!.human.majorBackgroundDefect = true;
    expect(qualifySpatialCorpus({ version: 1, cases: bad }).qualified).toBe(
      false,
    );
  });
  it("rejects duplicate evidence", () => {
    const duplicate = cases();
    duplicate[1]!.id = duplicate[0]!.id;
    expect(() =>
      qualifySpatialCorpus({ version: 1, cases: duplicate }),
    ).toThrow(/Duplicate/);
  });
});

const campaign = () =>
  spatialQualificationV2Schema.parse({
    version: 2,
    campaign: "regression-fixture",
    engineVersion: "spatial-v7",
    cases: cases().map((item, i) => ({
      id: item.id,
      family: item.family,
      outcome: item.outcome,
      holdout: item.holdout,
      durationMs: item.durationMs,
      evidence: {
        renderId: `render-${i}`,
        sceneId: `scene-${i}`,
        engineVersion: "spatial-v7",
        source: "real-photo",
        execution: "provider",
        room: {
          path: `room-${i}.png`,
          sha256: (i + 1).toString(16).padStart(64, "0"),
        },
        product: { path: "product.png", sha256: "c".repeat(64) },
        candidate: {
          path: `result-${i}.png`,
          sha256: (i + 100).toString(16).padStart(64, "0"),
        },
      },
      human: {
        ...item.human,
        reviewer: "test-reviewer",
        reviewedAt: "2026-09-26T10:00:00Z",
        blind: true,
        checks: {
          design: true,
          perspective: true,
          scale: true,
          contactLighting: true,
          background: true,
        },
        notes: "Synthetic unit-test declaration, not qualification evidence",
      },
      measurement:
        i < 10
          ? {
              reference: `physical record ${i}`,
              referenceLengthCm: 100,
              expectedPx: 100,
              observedPx: 108,
            }
          : null,
    })),
  });
const evaluate = (input = campaign()) =>
  qualifySpatialCorpus(input, {
    verified: qualificationImages(input),
    errors: [],
  });
describe("traceable qualification v2", () => {
  it("requires file verification even when every supplied annotation passes", () => {
    expect(qualifySpatialCorpus(campaign()).qualified).toBe(false);
    const result = evaluate();
    expect(result.qualified).toBe(true);
    expect(result.measuredScenes).toBe(10);
    expect(result.medianProjectedDimensionError).toBe(0.08);
    expect(result).toMatchObject({
      evidenceVersion: 2,
      holdout: { total: 9, acceptance: 1 },
    });
  });
  it.each(["rejected", "unavailable", "clarification"] as const)(
    "never counts an annotated %s as successful delivery",
    (outcome) => {
      const data = campaign();
      data.cases.forEach((item) => {
        item.outcome = outcome;
      });
      const result = evaluate(data);
      expect(result.acceptance).toBe(0);
      expect(result.qualified).toBe(false);
    },
  );
  it("deduplicates physical scenes and photos independently", () => {
    const sameScene = campaign(),
      samePhoto = campaign();
    for (let i = 0; i < 10; i++) {
      sameScene.cases[i]!.evidence!.sceneId = "same-scene";
      samePhoto.cases[i]!.evidence!.room = samePhoto.cases[0]!.evidence!.room;
    }
    expect(evaluate(sameScene)).toMatchObject({
      qualified: false,
      measuredScenes: 1,
    });
    expect(evaluate(samePhoto)).toMatchObject({
      qualified: false,
      measuredPhotos: 1,
    });
  });
  it("exposes a failing holdout hidden by the aggregate acceptance", () => {
    const data = campaign();
    data.cases[29]!.human!.acceptable = false;
    const result = evaluate(data);
    expect(result.acceptance).toBeGreaterThan(0.9);
    expect(result.qualified).toBe(false);
    expect(result.blockers).toContain(
      "Acceptabilité de la réserve inférieure à 90 %",
    );
  });
  it.each([
    "synthetic",
    "unverified",
    "mock",
    "version",
    "duplicate-output",
    "duplicate-run",
    "leaked-holdout",
    "not-blind",
    "no-candidate",
    "dimension",
  ])("blocks %s evidence", (kind) => {
    const data = campaign(),
      first = data.cases[0]!;
    if (kind === "synthetic") first.evidence!.source = "synthetic";
    if (kind === "unverified") first.evidence!.source = "unverified";
    if (kind === "mock") first.evidence!.execution = "mock";
    if (kind === "version") first.evidence!.engineVersion = "spatial-v6";
    if (kind === "duplicate-output")
      data.cases[1]!.evidence!.candidate = first.evidence!.candidate;
    if (kind === "duplicate-run")
      data.cases[1]!.evidence!.renderId = first.evidence!.renderId;
    if (kind === "leaked-holdout")
      data.cases[29]!.evidence!.room = first.evidence!.room;
    if (kind === "not-blind") first.human!.blind = false;
    if (kind === "no-candidate") first.evidence!.candidate = null;
    if (kind === "dimension") first.measurement!.observedPx = 121;
    expect(evaluate(data).qualified).toBe(false);
  });
  it("reports disagreements and family denominators using detailed checks", () => {
    const data = campaign();
    data.cases[0]!.human!.checks.design = false;
    const result = evaluate(data);
    expect(result.falseAgreements).toBe(1);
    expect(result).toMatchObject({
      byFamily: { "0": { total: 6, acceptance: 5 / 6 } },
    });
  });
});
