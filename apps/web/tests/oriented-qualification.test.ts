import { describe, expect, it } from "vitest";
import { orientedQualificationManifestFingerprint, orientedQualificationManifestSchema,
  qualifyOrientedCorpus, type OrientedQualificationManifest } from "../lib/oriented-qualification";

const hash = (n: number) => n.toString(16).padStart(64, "0");
const criteria = () => ({ identity: "pass", angle: "pass", geometry: "pass", alpha: "pass", contact: "pass", shadow: "pass", background: "pass" } as const);
function corpus(): OrientedQualificationManifest {
  const manifest: OrientedQualificationManifest = { schemaVersion: 1, corpusId: "synthetic-software-test-only", status: "frozen",
    frozenAt: "2026-10-01T00:00:00Z", notes: ["Fixtures synthétiques de test logiciel ; aucune image réelle ni qualification pilote."],
    products: Array.from({ length: 3 }, (_, i) => ({ key: `test-product-${i}`, label: `Fixture ${i}`, productId: `fixture-${i}`, variantId: null,
      status: "selected", sourceSha256: [hash(i + 1)], dimensionsVerified: true, variantVerified: true, imageRightsVerified: true })),
    cases: [], results: [] };
  for (let i = 0; i < 54; i++) manifest.cases.push({ id: `case-${i}`, productKey: `test-product-${i % 3}`,
    split: i < 36 ? "development" : "holdout", sceneSha256: hash(100 + i), productSourceSha256: [hash(i % 3 + 1)],
    expectedAdmissible: true, expectedFailure: null, conditions: ["Synthetic fixture only"], repeatsCaseId: null });
  for (let i = 0; i < 12; i++) manifest.cases.push({ ...manifest.cases[i]!, id: `repeat-${i}`, split: "repetition", repeatsCaseId: `case-${i}` });
  return withResults(manifest);
}
function withResults(manifest: OrientedQualificationManifest) {
  const fingerprint = orientedQualificationManifestFingerprint(manifest);
  manifest.results = manifest.cases.map((c, i) => ({ caseId: c.id, manifestFingerprint: fingerprint,
    startedAt: "2026-10-02T00:00:00Z", completedAt: "2026-10-02T00:00:01Z", decision: "accepted",
    criteria: criteria(), manualCorrections: 0, estimatedCostUsd: 0, totalDurationMs: 1000, providerCalls: 0,
    resultSha256: hash(1000 + i), reviews: [{ kind: "human", actorId: "fictional-unit-test-reviewer", reviewedAt: "2026-10-02T00:00:02Z",
      criteria: criteria(), evidenceSha256: [hash(1000 + i)], notes: ["Synthetic test data only"] }], failureDetail: null }));
  return manifest;
}
const codes = (manifest: OrientedQualificationManifest) => qualifyOrientedCorpus(manifest).issues.map(i => i.code);

describe("local oriented corpus qualification", () => {
  it("requires complete human-reviewed 36/18/12 corpus and three products for software policy passage", () => {
    const report = qualifyOrientedCorpus(corpus());
    expect(report.qualified).toBe(true);
    expect(report.splits.map(s => s.defined)).toEqual([36, 18, 12]);
    expect(report.splits.map(s => s.autonomousAcceptanceRate)).toEqual([1, 1, 1]);
    expect(report.reviewCounts).toEqual({ human: 66, agent: 0, automated: 0 });
    expect(report.metricQualified).toBe(false);
    expect(report.productionAuthorized).toBe(false);
  });
  it("rejects the same scene hash in development and holdout even for a different product", () => {
    const input = corpus();
    input.cases[36]!.sceneSha256 = input.cases[0]!.sceneSha256;
    expect(codes(withResults(input))).toContain("holdout_contamination");
  });
  it("distinguishes agent review from required human review", () => {
    const input = corpus();
    for (const result of input.results) result.reviews[0]!.kind = "agent";
    const report = qualifyOrientedCorpus(input);
    expect(report.qualified).toBe(false);
    expect(report.reviewCounts).toEqual({ human: 0, agent: 66, automated: 0 });
    expect(report.issues.map(i => i.code)).toContain("missing_human_review");
    expect(report.splits[0]!.autonomousAcceptanceRate).toBe(0);
  });
  it("cannot qualify a system that refuses every case", () => {
    const input = corpus();
    for (const result of input.results) result.decision = "rejected";
    const report = qualifyOrientedCorpus(input);
    expect(report.qualified).toBe(false);
    expect(report.splits[0]!.refusalRate).toBe(1);
    expect(report.splits[1]!.autonomousAcceptanceRate).toBe(0);
    expect(report.issues.map(i => i.code)).toContain("autonomy_below_threshold");
  });
  it("requires 90 percent independently in development and holdout", () => {
    const input = corpus();
    input.results[36]!.decision = "rejected";
    expect(qualifyOrientedCorpus(input).qualified).toBe(true);
    input.results[37]!.decision = "rejected";
    expect(qualifyOrientedCorpus(input).qualified).toBe(false);
    expect(qualifyOrientedCorpus(input).splits[1]!.autonomousAcceptanceRate).toBeCloseTo(16 / 18);
  });
  it.each(["identity", "background"] as const)("rejects any accepted result with a %s defect even above 90 percent", criterion => {
    const input = corpus();
    input.results[0]!.reviews[0]!.criteria[criterion] = "fail";
    expect(codes(input)).toContain("accepted_critical_defect");
  });
  it("does not count manual corrections as autonomous acceptance", () => {
    const input = corpus();
    for (const result of input.results) result.manualCorrections = 1;
    const report = qualifyOrientedCorpus(input);
    expect(report.qualified).toBe(false);
    expect(report.totals.manualCorrections).toBe(66);
    expect(report.splits[0]!.autonomousAcceptanceRate).toBe(0);
  });
  it("detects changed expectations after execution and missing case results", () => {
    const input = corpus();
    input.cases[1]!.expectedAdmissible = false;
    input.results.pop();
    expect(codes(input)).toContain("manifest_mismatch");
    expect(codes(input)).toContain("false_acceptance");
    expect(codes(input)).toContain("missing_result");
  });
  it("rejects cherry-picked duplicate results and invalid repetition lineage", () => {
    const input = corpus();
    input.results.push(input.results[0]!);
    expect(codes(input)).toContain("duplicate_result");
    input.cases[54]!.sceneSha256 = hash(999);
    expect(codes(input)).toContain("invalid_repetition");
  });
  it("keeps incomplete draft templates readable but explicitly unqualified", () => {
    const input: OrientedQualificationManifest = { schemaVersion: 1, corpusId: "pending", status: "draft", frozenAt: null, products: [], cases: [], results: [], notes: [] };
    const report = qualifyOrientedCorpus(input);
    expect(report.qualified).toBe(false);
    expect(report.totals.providerCalls).toBe(0);
    expect(report.issues.map(i => i.code)).toContain("insufficient_cases");
    expect(orientedQualificationManifestSchema.safeParse({ ...input, schemaVersion: 2 }).success).toBe(false);
  });
  it("measures cost, median, percentile 95 and missing evidence separately", () => {
    const input = corpus();
    input.results[0]!.estimatedCostUsd = 0.07;
    input.results[0]!.totalDurationMs = 2000;
    input.results[0]!.reviews[0]!.evidenceSha256 = [hash(9999)];
    const report = qualifyOrientedCorpus(input);
    expect(report.totals.estimatedCostUsd).toBe(0.07);
    expect(report.splits[0]!.medianDurationMs).toBe(1000);
    expect(report.splits[0]!.p95DurationMs).toBe(1000);
    expect(report.issues.map(i => i.code)).toContain("review_evidence_mismatch");
  });
});
