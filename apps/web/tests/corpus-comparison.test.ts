import { describe, expect, it } from "vitest";
import {
  compareVerdicts,
  eligibleSplit,
  pairReports,
} from "../scripts/corpus-comparison.mjs";

const record = (caseId: string, status = "succeeded") => ({
  caseId,
  stratum: "opaque_simple",
  sourceDigest: `${caseId}-same-input`,
  status,
  engineVersions: { mockMode: false },
  signals: { quality: status === "succeeded" ? "accepted" : "rejected" },
});
const report = (cases = [record("one")]) => ({
  server: { mockMode: false },
  split: "pilot",
  cases,
});
const verdict = (arm: string, usable = true) => ({
  pair: "pair-001",
  arm,
  usable,
  identityCritical: false,
  occlusionCritical: false,
  realism: 4,
});

describe("blind corpus comparisons", () => {
  it("isolates holdout scenes from pilot/tuning", () => {
    expect(eligibleSplit({ split: "holdout" }, "pilot")).toBe(false);
    expect(eligibleSplit({}, "pilot")).toBe(true);
    expect(() => eligibleSplit({}, "all")).toThrow();
  });
  it("refuses synthetic, mismatched and duplicate populations", () => {
    expect(() =>
      pairReports({ ...report(), server: { mockMode: true } }, report()),
    ).toThrow(/réelle/);
    expect(() =>
      pairReports(
        report(),
        report([{ ...record("one"), sourceDigest: "other" }]),
      ),
    ).toThrow(/Sources/);
    expect(() => pairReports(report(), report([record("two")]))).toThrow(
      /Sources/,
    );
    expect(() =>
      pairReports(report([record("one"), record("one")]), report()),
    ).toThrow(/dupliqués/);
  });
  it("keeps rejected inputs in the utility denominator", () => {
    const pairs = pairReports(
      report([record("one"), record("two", "failed")]),
      report([record("one"), record("two", "failed")]),
      () => 0,
    );
    const items = [verdict("A"), verdict("B")];
    const result = compareVerdicts(
      { split: "pilot", pairs },
      { evaluator: "alice", items },
      { evaluator: "bob", items },
    );
    expect(result.totals.supported.candidate.usefulInputRate).toBe(0.5);
    expect(result.totals.supported.candidate.usefulDeliveryRate).toBe(1);
    expect(result.productionValidated).toBe(false);
  });
  it("requires two independent reviews and arbitration of disagreement", () => {
    const key = {
      split: "pilot",
      pairs: pairReports(report(), report(), () => 0),
    };
    const first = { evaluator: "alice", items: [verdict("A"), verdict("B")] };
    expect(() => compareVerdicts(key, first, first)).toThrow(/distincts/);
    const second = {
      evaluator: "bob",
      items: [verdict("A"), verdict("B", false)],
    };
    expect(compareVerdicts(key, first, second).complete).toBe(false);
    const adjudicated = compareVerdicts(key, first, second, {
      evaluator: "carol",
      items: [verdict("B", false)],
    });
    expect(adjudicated.complete).toBe(true);
    expect(adjudicated.totals.supported.candidate.usable).toBe(0);
  });
  it("never compensates critical identity loss with realism", () => {
    const key = {
      split: "pilot",
      pairs: pairReports(report(), report(), () => 0),
    };
    const items = [
      verdict("A"),
      { ...verdict("B"), realism: 5, identityCritical: true },
    ];
    const score = compareVerdicts(
      key,
      { evaluator: "a", items },
      { evaluator: "b", items },
    );
    expect(score.totals.supported.candidate.usable).toBe(0);
    expect(score.totals.supported.candidate.criticalIdentity).toBe(1);
  });
  it("does not count missing judgements or unknown provider outcomes as evidence", () => {
    const pairs = pairReports(
      report([record("one"), record("two", "unknown")]),
      report([record("one"), record("two", "unknown")]),
      () => 0,
    );
    const score = compareVerdicts(
      { split: "pilot", pairs },
      { evaluator: "a", items: [] },
      { evaluator: "b", items: [] },
    );
    expect(score.complete).toBe(false);
    expect(score.totals.supported.candidate.usefulDeliveryRate).toBeNull();
    expect(score.totals.supported.candidate.unknown).toBe(1);
  });
});
