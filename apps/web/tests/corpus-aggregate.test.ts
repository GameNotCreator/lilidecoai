import { describe, expect, it } from "vitest";

// @ts-expect-error — plain ESM helper shared with the corpus scripts.
import { aggregate, FAILURE_CODES, verdictSheet } from "../scripts/corpus-signals.mjs";

/**
 * PRO-007 deliverable "liste des échecs classés". The aggregate must never
 * fold an experimental stratum into a supported rate, and never present a rate
 * without the population it rests on.
 */
describe("aggregating verdicts", () => {
  const verdicts = [
    { stratum: "opaque_simple", usable: true, codes: [] },
    { stratum: "opaque_simple", usable: false, codes: ["harmony_identity_lost"] },
    { stratum: "fine_detail", usable: false, codes: ["source_cutout_amputated", "harmony_identity_lost"] },
    { stratum: "experimental", usable: false, codes: ["harmony_light"] },
  ];

  it("keeps experimental strata out of the supported rate", () => {
    const result = aggregate(verdicts);
    // Three supported cases, one usable — the experimental failure is excluded.
    expect(result.supported).toEqual({ cases: 3, usable: 1, rate: 1 / 3 });
    expect(result.experimental).toHaveLength(1);
    expect(result.experimental[0].stratum).toBe("experimental");
  });

  it("publishes the population alongside the rate", () => {
    const result = aggregate(verdicts);
    expect(result.supported.cases).toBe(3);
    expect(result.byStratum.map((b: { stratum: string }) => b.stratum).sort()).toEqual([
      "experimental",
      "fine_detail",
      "opaque_simple",
    ]);
  });

  it("counts a failure code once per case that carries it", () => {
    const result = aggregate(verdicts);
    const fine = result.byStratum.find((b: { stratum: string }) => b.stratum === "fine_detail");
    expect(fine.codes).toEqual({
      source_cutout_amputated: 1,
      harmony_identity_lost: 1,
    });
  });

  it("reports no rate at all when nothing supported was judged", () => {
    const result = aggregate([{ stratum: "experimental", usable: false, codes: [] }]);
    expect(result.supported).toEqual({ cases: 0, usable: 0, rate: null });
  });
});

describe("the verdict sheet", () => {
  const record = {
    caseId: "vase-01",
    stratum: "opaque_simple",
    expectation: "Le vase repose au sol.",
    engineVersions: { mockMode: false },
    signals: { cutoutSynthetic: false, anchorContractHeld: true },
  };

  it("offers every taxonomy code to tick", () => {
    const sheet = verdictSheet(record);
    for (const [, code] of FAILURE_CODES) {
      expect(sheet).toContain(`\`${code}\``);
    }
  });

  it("warns loudly on a simulated run instead of inviting a judgement", () => {
    const sheet = verdictSheet({
      ...record,
      engineVersions: { mockMode: true },
    });
    expect(sheet).toContain("RUN SIMULÉ");
    expect(sheet).toContain("ne mesurerait rien");
  });

  // A03: a cutout the model invented voids any identity conclusion, so the
  // sheet must say so where the judgement is made, not only in a doc.
  it("flags a synthetic cutout on the sheet itself", () => {
    const sheet = verdictSheet({
      ...record,
      signals: { ...record.signals, cutoutSynthetic: true },
    });
    expect(sheet).toContain("sans valeur");
  });
});
