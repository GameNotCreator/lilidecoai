import "server-only";
import { createHash } from "node:crypto";
import {
  selectSpatialForeground,
  SPATIAL_FOREGROUND_SELECTION_POLICY,
} from "./spatial-foreground-selection";
import { spatialExtractionInteractionBlockers } from "./spatial-generated-layer";

export interface SpatialConservativeRefinementInput {
  alpha: Uint8Array;
  /** SHA-256 of the raw alpha bytes, not of their PNG encoding. */
  alphaFingerprint: string;
  projectedRegion: Uint8Array;
  authorization: Uint8Array;
  width: number;
  height: number;
  sourceInteractionBlockers?: readonly string[];
  refinement?: {
    alpha: Uint8Array;
    sourceAlphaFingerprint: string;
    method: "grabcut" | "sam";
  };
}

/** Experimental routing only. An existing topological selection wins verbatim.
 * Refinement never repairs an authorization or proves object completeness; when
 * topology refuses, expose its supplied mask only through diagnosticAlpha.
 * This policy must remain outside rendering and interaction delivery paths.
 */
export function selectSpatialConservativeRefinement(
  input: SpatialConservativeRefinementInput,
) {
  if (
    [input.alpha, input.projectedRegion, input.authorization].some(
      (mask) => !(mask instanceof Uint8Array),
    )
  )
    throw new Error("Expected Uint8Array conservative-refinement masks");

  // Existing selection validates the source fingerprint, binary regions and
  // grid before any refinement can participate in routing.
  const selection = selectSpatialForeground(input);
  const inherited =
    input.sourceInteractionBlockers === undefined
      ? []
      : input.sourceInteractionBlockers;
  if (
    !Array.isArray(inherited) ||
    inherited.some((value) => typeof value !== "string" || !value.trim())
  )
    throw new Error("Invalid source interaction blockers");

  const hash = (bytes: Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex");
  const refinement = input.refinement;
  if (refinement !== undefined) {
    if (
      !refinement ||
      !(refinement.alpha instanceof Uint8Array) ||
      refinement.alpha.length !== input.alpha.length ||
      !["grabcut", "sam"].includes(refinement.method) ||
      refinement.sourceAlphaFingerprint !== selection.evidence.fingerprints.alpha
    )
      throw new Error("Invalid refinement grid, method or source fingerprint");
    if (
      refinement.alpha.some(
        (value, index) => value !== 0 && value !== input.alpha[index],
      )
    )
      throw new Error("Refinement invents or modifies source alpha");
    if (!refinement.alpha.some((value) => value > 0))
      throw new Error("Refinement retains no source alpha");
  }

  // Inspect ALL source pixels. A disconnected neighbour, or a refinement which
  // hides a bad boundary, cannot erase evidence present before this policy.
  let cropEdgePixels = 0;
  let clippedOpaquePixels = 0;
  for (let index = 0; index < input.alpha.length; index++) {
    const value = input.alpha[index]!;
    if (!value) continue;
    const x = index % input.width;
    const y = Math.floor(index / input.width);
    if (!x || !y || x === input.width - 1 || y === input.height - 1)
      cropEdgePixels++;
    if (
      !input.authorization[index] &&
      value >= SPATIAL_FOREGROUND_SELECTION_POLICY.opaqueAlpha
    )
      clippedOpaquePixels++;
  }
  const sourceBoundaryEvidence = { cropEdgePixels, clippedOpaquePixels };
  const sourceBlockers = spatialExtractionInteractionBlockers({
    ...sourceBoundaryEvidence,
    interactionBlockers: inherited,
  });
  const alpha = selection.alpha;
  const diagnosticAlpha =
    alpha === null && refinement ? Uint8Array.from(refinement.alpha) : null;
  const status = alpha
    ? ("selected" as const)
    : diagnosticAlpha
      ? ("diagnostic-proposal" as const)
      : ("blocked" as const);

  return {
    alpha,
    diagnosticAlpha,
    evidence: {
      version: "spatial-conservative-refinement-v1" as const,
      status,
      qualification: "not-qualified" as const,
      interactionsAllowed: false as const,
      interactionBlockers: [
        ...new Set([
          "unreviewed-conservative-refinement",
          ...sourceBlockers,
          ...selection.evidence.interactionBlockers,
          ...selection.evidence.reasons,
        ]),
      ],
      reasons: [...selection.evidence.reasons],
      sourceBoundaryEvidence,
      sourceInteractionBlockers: [...inherited],
      selectionEvidence: selection.evidence,
      fingerprints: {
        sourceAlpha: selection.evidence.fingerprints.alpha,
        projectedRegion: selection.evidence.fingerprints.projectedRegion,
        authorization: selection.evidence.fingerprints.authorization,
        selectedAlpha: alpha ? hash(alpha) : null,
        diagnosticAlpha: diagnosticAlpha ? hash(diagnosticAlpha) : null,
      },
      refinement: refinement
        ? {
            method: refinement.method,
            sourceAlphaFingerprint: refinement.sourceAlphaFingerprint,
            alphaFingerprint: hash(refinement.alpha),
            disposition: alpha
              ? ("ignored-selection-preserved" as const)
              : ("diagnostic-only" as const),
          }
        : null,
      limitations: [
        "Topology can preserve connected neighbours or discard legitimate detached product parts.",
        "An autonomous refinement may truncate handles, feet, wires or soft alpha; it is never preferred to an existing selection.",
        "Diagnostic proposals retain source refusal reasons and cannot authorize interactions or delivery.",
      ],
    },
  };
}
