import { describe, expect, it } from "vitest";

// @ts-expect-error — plain ESM helper shared with the corpus runner script.
import { FLAT_FORESHORTENING, rankFailures, runClaim, stageSignals, validateCase } from "../scripts/corpus-signals.mjs";

/**
 * PRO-007. The harness's own judgement is tested because a harness that reports
 * a signal wrongly is worse than none: it produces confident numbers about the
 * wrong thing.
 */

function validCase() {
  return {
    id: "vase-01",
    stratum: "opaque_simple",
    provenance: { authorisation: "propriétaire, écrit" },
    room: { file: "room.jpg" },
    product: {
      file: "product.jpg",
      name: "Vase",
      dimensionsCm: { width: 24, height: 42, depth: 24 },
    },
    placements: [
      {
        point: { x: 0.5, y: 0.72 },
        dimensionPair: { mode: "height_length", heightCm: 42, lengthCm: 24 },
      },
    ],
  };
}

describe("case validation", () => {
  it("accepts a complete case", () => {
    expect(validateCase(validCase())).toEqual([]);
  });

  // "Sources autorisées" is the first line of the ticket: a case without it
  // must be refused before it ever reaches a provider, not flagged after.
  it("refuses a case with no recorded authorisation", () => {
    const item = validCase();
    item.provenance.authorisation = "";
    expect(validateCase(item)).toContain(
      "champ manquant : provenance.authorisation",
    );
  });

  it("refuses a case with no measured dimensions", () => {
    const item = validCase();
    delete (item.product.dimensionsCm as Record<string, unknown>).height;
    expect(validateCase(item)).toContain(
      "champ manquant : product.dimensionsCm.height",
    );
  });

  it("refuses a case with no placement, or an unusable one", () => {
    const empty = validCase();
    empty.placements = [];
    expect(validateCase(empty)).toContain(
      "placements : au moins un point est requis",
    );

    const broken = validCase();
    broken.placements = [{ point: { x: 0.5 }, dimensionPair: {} }] as never;
    const problems = validateCase(broken);
    expect(problems).toContain("placements[0].point : x et y normalisés requis");
    expect(problems).toContain("placements[0].dimensionPair : mode requis");
  });
});

describe("stage signals", () => {
  const render = {
    placement: {
      sceneWidth: 1000,
      sceneHeight: 800,
      compositePlacements: [
        { objectIndex: 0, baseX: 500, baseY: 576, croppedByFrame: 0 },
      ],
    },
    audit: {
      cutoutSources: ["heuristic"],
      cutoutWarnings: [],
      scaleSources: ["vision"],
      scaleFallbackFired: false,
      obstaclesRemoved: 0,
      obstaclesSkipped: 0,
    },
    qualityDecision: { status: "accepted", score: 0.88 },
    creditCharged: true,
  };

  it("holds the placement contract when the composite anchored where asked", () => {
    const signals = stageSignals(render, validCase());
    expect(signals.anchorErrorPx).toEqual([0]);
    expect(signals.anchorContractHeld).toBe(true);
  });

  it("breaks the contract when the composite anchored elsewhere", () => {
    const moved = structuredClone(render);
    moved.placement.compositePlacements[0]!.baseX = 620;
    const signals = stageSignals(moved, validCase());
    expect(signals.anchorContractHeld).toBe(false);
  });

  // A03 of the audit: a cutout the model invented is not the customer's photo,
  // so no identity conclusion drawn from that case is worth anything.
  it("flags a cutout the model produced", () => {
    const synthetic = structuredClone(render);
    synthetic.audit.cutoutSources = ["model"];
    expect(stageSignals(synthetic, validCase()).cutoutSynthetic).toBe(true);
    expect(stageSignals(render, validCase()).cutoutSynthetic).toBe(false);
  });

  it("reports nothing rather than zero when the render carries no provenance", () => {
    const signals = stageSignals({}, validCase());
    expect(signals.scaleSources).toBeNull();
    expect(signals.obstaclesRemoved).toBeNull();
    expect(signals.quality).toBeNull();
    // No placements: nothing to check, and "held" would read as evidence.
    expect(signals.anchorErrorPx).toEqual([]);
    expect(signals.anchorContractHeld).toBeNull();
  });

  it("cannot compute the anchor guard without the composite frame", () => {
    const frameless = structuredClone(render);
    delete (frameless.placement as Record<string, unknown>).sceneWidth;
    expect(stageSignals(frameless, validCase()).anchorErrorPx).toEqual([null]);
  });
});

describe("what a run is allowed to claim", () => {
  it("claims nothing for an empty corpus", () => {
    expect(runClaim({ mockMode: false, caseCount: 0 })).toMatch(/^AUCUNE/);
  });

  it("claims nothing for a simulated run, however many cases", () => {
    expect(runClaim({ mockMode: true, caseCount: 20 })).toMatch(/^AUCUNE/);
  });

  it("claims stage signals and cost — never photographic quality", () => {
    const claim = runClaim({ mockMode: false, caseCount: 20 });
    expect(claim).not.toMatch(/^AUCUNE/);
    expect(claim).toMatch(/humain/);
  });
});

/**
 * A04 of the audit: a rug declared 200×100 cm against a 2:1 photo came out
 * 400×90 px — an aspect of 4.44 instead of 2. The geometry computed the
 * inconsistency all along; nothing ever surfaced it.
 */
describe("deformation signals", () => {
  function renderWith(placement: Record<string, unknown>) {
    return {
      placement: {
        sceneWidth: 1200,
        sceneHeight: 900,
        compositePlacements: [{ objectIndex: 0, baseX: 600, baseY: 648, ...placement }],
      },
    };
  }
  const flatCase = {
    placements: [
      {
        point: { x: 0.5, y: 0.72 },
        dimensionPair: { mode: "length_width", lengthCm: 200, widthCm: 100 },
      },
    ],
  };

  // Found by the adversarial review of this harness — of my own signal. The
  // geometry shrinks a flat object's far side by FLAT_FORESHORTENING, so a
  // rug whose declared dimensions match its photo reads 1/0.45 = 2.22 RAW.
  // The first version of this test celebrated that value as the audit's
  // deformation; it is the intended perspective approximation. Normalised by
  // pose, 1 means "match" for every kind.
  it("normalises a flat footprint so that 1 means the dimensions match the photo", () => {
    const signals = stageSignals(
      renderWith({
        kind: "flat",
        dimensionConsistency: 1 / FLAT_FORESHORTENING,
        sizeFactor: 0.45,
        clamped: true,
      }),
      flatCase,
    );
    expect(signals.dimensionConsistency[0]).toBeCloseTo(1, 3);
    expect(signals.clamped).toBe(true);
    expect(signals.sizeFactor).toEqual([0.45]);
  });

  it("leaves a standing object's consistency raw: 2.22 there IS a stretch", () => {
    const standing = {
      placements: [
        {
          point: { x: 0.5, y: 0.72 },
          dimensionPair: { mode: "height_length", heightCm: 42, lengthCm: 24 },
        },
      ],
    };
    const signals = stageSignals(
      renderWith({ kind: "standing", dimensionConsistency: 2.222 }),
      standing,
    );
    expect(signals.dimensionConsistency).toEqual([2.222]);
  });

  it("reports a consistency of 1 when the dimensions match the photo", () => {
    const signals = stageSignals(
      renderWith({ dimensionConsistency: 1, sizeFactor: 1, clamped: false }),
      flatCase,
    );
    expect(signals.dimensionConsistency).toEqual([1]);
    expect(signals.clamped).toBe(false);
  });

  it("measures the rendered height against the height asked for", () => {
    const item = {
      placements: [
        {
          point: { x: 0.5, y: 0.72 },
          dimensionPair: { mode: "height_length", heightCm: 42, lengthCm: 24 },
        },
      ],
    };
    expect(
      stageSignals(renderWith({ impliedHeightCm: 42 }), item).heightErrorPct,
    ).toEqual([0]);
    expect(
      stageSignals(renderWith({ impliedHeightCm: 33.6 }), item).heightErrorPct,
    ).toEqual([-20]);
  });

  it("reports nothing rather than zero when the height cannot be compared", () => {
    // A flat object is entered as length+width: there is no declared height.
    expect(
      stageSignals(renderWith({ impliedHeightCm: 90 }), flatCase).heightErrorPct,
    ).toEqual([null]);
  });
});

/**
 * The ranking that says "where to put the next effort" must be built from the
 * supported perimeter only: an out-of-scope category must not steer it.
 */
describe("ranking failures", () => {
  it("keeps experimental strata out of the supported ranking", () => {
    const ranking = rankFailures([
      { stratum: "opaque_simple", codes: ["harmony_identity_lost"] },
      { stratum: "fine_detail", codes: ["harmony_identity_lost", "source_cutout_amputated"] },
      { stratum: "experimental", codes: ["harmony_light", "harmony_light"] },
    ]);
    expect(ranking.supported).toEqual([
      ["harmony_identity_lost", 2],
      ["source_cutout_amputated", 1],
    ]);
    expect(ranking.experimental).toEqual([["harmony_light", 2]]);
  });

  it("ranks by frequency, most frequent first", () => {
    const ranking = rankFailures([
      { stratum: "opaque_simple", codes: ["edge_soft"] },
      { stratum: "opaque_simple", codes: ["scale_wrong", "edge_soft"] },
      { stratum: "opaque_simple", codes: ["scale_wrong", "edge_soft"] },
    ]);
    expect(ranking.supported[0]).toEqual(["edge_soft", 3]);
    expect(ranking.supported[1]).toEqual(["scale_wrong", 2]);
  });
});
