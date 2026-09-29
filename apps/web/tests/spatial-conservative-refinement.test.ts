import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  selectSpatialConservativeRefinement,
  type SpatialConservativeRefinementInput,
} from "../lib/server/spatial-conservative-refinement";
import { selectSpatialForeground } from "../lib/server/spatial-foreground-selection";

const fingerprint = (alpha: Uint8Array) =>
  createHash("sha256").update(alpha).digest("hex");

function fixture(): SpatialConservativeRefinementInput {
  const width = 18;
  const height = 14;
  const alpha = Buffer.alloc(width * height);
  const projectedRegion = Buffer.alloc(alpha.length);
  const authorization = Buffer.alloc(alpha.length, 255);
  for (let y = 4; y <= 9; y++)
    for (let x = 4; x <= 8; x++) {
      alpha[y * width + x] = 254;
      projectedRegion[y * width + x] = 255;
    }
  // Opaque handle connected outside the projected body, with an actual hole.
  for (const [x, y] of [[3, 4], [2, 5], [2, 6], [3, 7]])
    alpha[y! * width + x!] = 255;
  alpha[10 * width + 9] = 1; // Diagonally connected nearly transparent detail.
  alpha[2 * width + 9] = 17; // Detached weak fragment retained by existing policy.
  for (let y = 3; y <= 10; y++)
    for (let x = 13; x <= 16; x++) alpha[y * width + x] = 255;
  return { width, height, alpha, projectedRegion, authorization,
    alphaFingerprint: fingerprint(alpha) };
}

function bindSource(input: SpatialConservativeRefinementInput) {
  input.alphaFingerprint = fingerprint(input.alpha);
  return input;
}

function amputated(input: SpatialConservativeRefinementInput) {
  return Uint8Array.from(input.alpha, (value, index) =>
    input.projectedRegion[index] ? value : 0,
  );
}

describe("experimental conservative refinement routing", () => {
  it.each(["sam", "grabcut"] as const)(
    "preserves exact selected handles and weak details despite an amputated %s proposal",
    (method) => {
      const input = fixture();
      input.refinement = { alpha: amputated(input),
        sourceAlphaFingerprint: input.alphaFingerprint, method };
      const before = structuredClone(input);
      const selected = selectSpatialForeground(input);
      const result = selectSpatialConservativeRefinement(input);
      expect(result.alpha).toEqual(selected.alpha);
      expect(result.diagnosticAlpha).toBeNull();
      expect(result.alpha![5 * input.width + 2]).toBe(255);
      expect(result.alpha![10 * input.width + 9]).toBe(1);
      expect(result.alpha![2 * input.width + 9]).toBe(17);
      expect(result.alpha![5 * input.width + 3]).toBe(0); // Handle hole.
      expect(result.evidence).toMatchObject({ status: "selected",
        qualification: "not-qualified", interactionsAllowed: false,
        refinement: { disposition: "ignored-selection-preserved", method } });
      expect(result.evidence.interactionBlockers).toContain("unreviewed-conservative-refinement");
      expect(structuredClone(input)).toEqual(before);
    },
  );

  it("removes a separated neighbour only according to existing component selection", () => {
    const input = fixture();
    const result = selectSpatialConservativeRefinement(input);
    expect(result.evidence.status).toBe("selected");
    for (let index = 0; index < input.alpha.length; index++)
      expect(result.alpha![index]).toBe(index % input.width >= 13 ? 0 : input.alpha[index]);
    expect(result.evidence.refinement).toBeNull();
    expect(result.evidence.selectionEvidence).toMatchObject({ discardedPixels: 32 });
  });

  it("returns a connected vase refinement only as a diagnostic after source rejection", () => {
    const input = fixture();
    for (let x = 9; x < input.width; x++) input.alpha[6 * input.width + x] = 1;
    input.alpha[6 * input.width + 16] = 255;
    input.authorization[6 * input.width + 16] = 0;
    bindSource(input);
    input.refinement = { alpha: amputated(input), sourceAlphaFingerprint: input.alphaFingerprint, method: "sam" };
    const before = structuredClone(input);
    const result = selectSpatialConservativeRefinement(input);
    expect(result.alpha).toBeNull();
    expect(result.diagnosticAlpha).toEqual(input.refinement.alpha);
    expect(result.diagnosticAlpha).not.toBe(input.refinement.alpha);
    expect(result.evidence).toMatchObject({ status: "diagnostic-proposal",
      qualification: "not-qualified", interactionsAllowed: false,
      refinement: { disposition: "diagnostic-only" },
      sourceBoundaryEvidence: { cropEdgePixels: 1, clippedOpaquePixels: 1 } });
    expect(result.evidence.interactionBlockers).toEqual(expect.arrayContaining([
      "unreviewed-conservative-refinement", "foreground-touches-crop-edge",
      "opaque-foreground-outside-authorization", "retained-foreground-touches-crop-edge",
      "retained-opaque-foreground-outside-authorization",
    ]));
    expect(result.evidence.reasons).toEqual(result.evidence.selectionEvidence.reasons);
    expect(structuredClone(input)).toEqual(before);
  });

  it("stays blocked without a refinement and never substitutes source alpha on refusal", () => {
    const input = fixture();
    input.projectedRegion[5 * input.width + 14] = 255;
    const result = selectSpatialConservativeRefinement(input);
    expect(result).toMatchObject({ alpha: null, diagnosticAlpha: null,
      evidence: { status: "blocked", qualification: "not-qualified", interactionsAllowed: false,
        reasons: ["ambiguous-projected-components"] } });
    expect(result.evidence.interactionBlockers).toContain("ambiguous-projected-components");
  });

  it("retains original vetoes even when selection discards their entire component", () => {
    const input = fixture();
    input.alpha[3 * input.width + 17] = 255;
    input.authorization[3 * input.width + 17] = 0;
    input.sourceInteractionBlockers = ["identity-not-reviewed", "prior-occlusion-veto"];
    bindSource(input);
    const result = selectSpatialConservativeRefinement(input);
    expect(result.evidence.status).toBe("selected");
    expect(result.alpha![3 * input.width + 17]).toBe(0);
    expect(result.evidence.interactionBlockers).toEqual(expect.arrayContaining([
      "identity-not-reviewed", "prior-occlusion-veto", "foreground-touches-crop-edge",
      "opaque-foreground-outside-authorization", "unreviewed-conservative-refinement",
    ]));
    expect(result.evidence.fingerprints.authorization).toBe(fingerprint(input.authorization));
  });

  it.each([false, true])("rejects an empty refinement whether selection is blocked=%s or retained", (blocked) => {
    const input = fixture();
    if (blocked) input.projectedRegion[5 * input.width + 14] = 255;
    input.refinement = { alpha: new Uint8Array(input.alpha.length),
      sourceAlphaFingerprint: input.alphaFingerprint, method: "sam" };
    expect(() => selectSpatialConservativeRefinement(input)).toThrow(/retains no source alpha/);
  });

  it.each(["changed-source", "false-hash", "other-source", "wrong-grid", "added-alpha", "changed-alpha", "method"])(
    "rejects %s even when selection would otherwise be preserved", (scenario) => {
      const input = fixture();
      input.refinement = { alpha: amputated(input), sourceAlphaFingerprint: input.alphaFingerprint, method: "sam" };
      if (scenario === "changed-source") input.alpha[4 * input.width + 4] = 252;
      if (scenario === "false-hash") input.alphaFingerprint = "f".repeat(64);
      if (scenario === "other-source") input.refinement.sourceAlphaFingerprint = "0".repeat(64);
      if (scenario === "wrong-grid") input.refinement.alpha = new Uint8Array(1);
      if (scenario === "added-alpha") input.refinement.alpha[0] = 1;
      if (scenario === "changed-alpha") input.refinement.alpha[4 * input.width + 4] = 253;
      if (scenario === "method") input.refinement.method = "manual" as "sam";
      expect(() => selectSpatialConservativeRefinement(input)).toThrow();
    },
  );

  it.each(["source-type", "soft-region", "soft-authorization", "fractional-grid", "missing-grid-pixel", "malformed-veto", "null-veto"])(
    "rejects %s before producing a diagnostic", (scenario) => {
      const input = fixture();
      if (scenario === "source-type") input.alpha = Array.from(input.alpha) as unknown as Uint8Array;
      if (scenario === "soft-region") input.projectedRegion[0] = 1;
      if (scenario === "soft-authorization") input.authorization[0] = 254;
      if (scenario === "fractional-grid") input.width += 0.5;
      if (scenario === "missing-grid-pixel") input.height += 1;
      if (scenario === "malformed-veto") input.sourceInteractionBlockers = [""];
      if (scenario === "null-veto") input.sourceInteractionBlockers = null as unknown as string[];
      expect(() => selectSpatialConservativeRefinement(input)).toThrow();
    },
  );
});
