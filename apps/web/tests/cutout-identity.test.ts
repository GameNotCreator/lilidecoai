import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  CutoutUnusableError,
  cutoutTrust,
  cutoutVerdict,
} from "../lib/server/cutout-identity";
import type { CutoutQualityFlags } from "../lib/server/assets";

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    widthPx: 32,
    heightPx: 64,
    baseRowFraction: 1,
    source: "heuristic" as const,
    synthetic: false,
    shadowRemoved: false,
    warnings: [],
    cutoutVersion: "cutout-v1",
    ...overrides,
  };
}

function flags(
  overrides: Partial<CutoutQualityFlags> = {},
): CutoutQualityFlags {
  return {
    opaque: false,
    ragged: false,
    hollowed: false,
    enclosedBackground: false,
    shadowBand: false,
    busyBackground: false,
    vanished: false,
    ...overrides,
  };
}

/**
 * A03 / PRO-008. The cutout is re-stamped over the model's output as the last
 * operation before encoding, so it is not a preview — it is what the customer
 * is shown as their product.
 */
describe("who may be the identity reference", () => {
  it("trusts a matte made from the customer's own photo", () => {
    expect(cutoutTrust(metadata())).toEqual({ trusted: true });
    expect(cutoutTrust(metadata({ source: "matting" }))).toEqual({
      trusted: true,
    });
  });

  it("refuses a recorded unusable matte even when its pixels are authentic", () => {
    expect(
      cutoutTrust(
        metadata({
          verdict: {
            usable: false,
            code: "background_not_removable",
            detail: "Fond non retiré.",
          },
        }),
      ),
    ).toMatchObject({
      trusted: false,
      reason: "cutout_unusable",
      message: "Fond non retiré.",
    });
  });

  it("refuses corrupted geometry before it can drive scale and anchor", () => {
    for (const dimensions of [
      { widthPx: 0 },
      { heightPx: NaN },
      { baseRowFraction: Infinity },
      { baseRowFraction: 0 },
    ]) {
      expect(cutoutTrust(metadata(dimensions))).toMatchObject({
        trusted: false,
        reason: "cutout_invalid_geometry",
      });
    }
  });

  it("refuses a cutout a model re-rendered", () => {
    const trust = cutoutTrust(metadata({ synthetic: true, source: "model" }));
    expect(trust.trusted).toBe(false);
    expect(trust).toMatchObject({ reason: "cutout_synthetic" });
  });

  // The gate is an allowlist on purpose: written as a denylist over
  // `synthetic`, "no metadata at all" would read as trustworthy.
  it("refuses a cutout with no provenance rather than assuming it is fine", () => {
    expect(cutoutTrust(undefined)).toMatchObject({
      trusted: false,
      reason: "cutout_unknown_provenance",
    });
  });

  it("refuses an unversioned cutout, and any unknown source", () => {
    expect(cutoutTrust(metadata({ cutoutVersion: undefined }))).toMatchObject({
      trusted: false,
      reason: "cutout_unversioned",
    });
    expect(
      cutoutTrust(metadata({ source: "model", synthetic: false })),
    ).toMatchObject({ trusted: false, reason: "cutout_synthetic" });
  });

  it("tells the customer what to do, not just that it refused", () => {
    for (const bad of [undefined, metadata({ synthetic: true })]) {
      const trust = cutoutTrust(bad as never);
      expect(trust.trusted).toBe(false);
      if (!trust.trusted) expect(trust.message).toMatch(/préparation/i);
    }
  });
});

/**
 * Only two outcomes are genuinely unusable, and neither is a policy choice.
 * Every softer doubt is recorded and still shipped: its frequency on real
 * photos has never been measured, and refusing on a guess would turn away
 * customers whose photo works.
 */
describe("the matte's verdict on a photo", () => {
  it("refuses when nothing was removed: the background would be pasted in", () => {
    const verdict = cutoutVerdict(flags({ opaque: true }));
    expect(verdict.usable).toBe(false);
    expect(verdict.code).toBe("background_not_removable");
    expect(verdict.detail).toMatch(/fond uni/i);
  });

  it("refuses when nothing survived: there is no product left", () => {
    const verdict = cutoutVerdict(flags({ vanished: true }));
    expect(verdict.usable).toBe(false);
    expect(verdict.code).toBe("product_not_separable");
  });

  it("records every softer doubt without refusing it", () => {
    for (const [flag, code] of [
      ["busyBackground", "background_busy"],
      ["enclosedBackground", "background_trapped_inside"],
      ["shadowBand", "contact_shadow_retained"],
      ["hollowed", "silhouette_eaten"],
      ["ragged", "edge_soft"],
    ] as const) {
      const verdict = cutoutVerdict(flags({ [flag]: true }));
      expect(verdict.usable).toBe(true);
      expect(verdict.code).toBe(code);
    }
  });

  it("reports a clean matte as such", () => {
    expect(cutoutVerdict(flags())).toEqual({
      usable: true,
      code: "ok",
      detail: "",
    });
  });

  it("lets an unusable verdict reach the customer as a 422", () => {
    const verdict = cutoutVerdict(flags({ vanished: true }));
    const error = new CutoutUnusableError(verdict);
    expect(error.status).toBe(422);
    expect(error.message).toBe(verdict.detail);
  });
});
