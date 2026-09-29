import "server-only";
import { createHash } from "node:crypto";

export interface SpatialExtractionCrop {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A clean boundary is necessary, never sufficient, for interaction experiments.
 * Refuse clipped opaque foreground and a foreground touching the crop: either
 * can represent a truncated product or unrelated furniture captured by matting.
 * No amount of agreement between two models clears these blockers.
 */
export function spatialExtractionInteractionBlockers(evidence: {
  clippedOpaquePixels: number;
  cropEdgePixels: number;
  interactionBlockers?: unknown;
}): string[] {
  if (
    ![evidence.clippedOpaquePixels, evidence.cropEdgePixels].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
  )
    return ["invalid-extraction-evidence"];
  if (
    evidence.interactionBlockers !== undefined &&
    (!Array.isArray(evidence.interactionBlockers) ||
      evidence.interactionBlockers.some(
        (value) => typeof value !== "string" || !value.trim(),
      ))
  )
    return ["invalid-extraction-evidence"];
  const blockers: string[] = [
    ...((evidence.interactionBlockers as string[] | undefined) ?? []),
  ];
  if (evidence.clippedOpaquePixels > 0)
    blockers.push("opaque-foreground-outside-authorization");
  if (evidence.cropEdgePixels > 0)
    blockers.push("foreground-touches-crop-edge");
  return [...new Set(blockers)];
}

/** Research compositor only: an alpha map is NOT evidence of a complete object.
 * Keep this out of the delivery pipeline until extraction and interactions are
 * qualified. The generated viewpoint supplies RGB; catalogue pixels never do.
 */
export function extractSpatialGeneratedLayer(input: {
  original: Buffer; // RGB, aligned original-room grid.
  generated: Buffer; // RGB, aligned original-room grid.
  envelope: Uint8Array; // Binary object authorization; no contact region.
  width: number;
  height: number;
  mask: {
    data: Uint8Array; // One alpha byte per crop pixel, no resizing allowed.
    crop: SpatialExtractionCrop;
    generatedFingerprint: string; // SHA-256 of aligned generated RGB.
  };
}) {
  const { original, generated, envelope, width, height, mask } = input;
  const crop = mask.crop;
  if (
    ![width, height, crop.left, crop.top, crop.width, crop.height].every(
      Number.isSafeInteger,
    ) ||
    width < 1 ||
    height < 1 ||
    width * height > 16_000_000 ||
    crop.left < 0 ||
    crop.top < 0 ||
    crop.width < 1 ||
    crop.height < 1 ||
    crop.left + crop.width > width ||
    crop.top + crop.height > height ||
    original.length !== width * height * 3 ||
    generated.length !== original.length ||
    envelope.length !== width * height ||
    mask.data.length !== crop.width * crop.height ||
    envelope.some((value) => value !== 0 && value !== 255)
  )
    throw new Error("Invalid spatial extraction grid or authorization mask");
  if (
    createHash("sha256").update(generated).digest("hex") !==
    mask.generatedFingerprint
  )
    throw new Error("The extraction mask belongs to another generated image");
  const candidate = Buffer.from(original);
  const layer = Buffer.alloc(width * height * 4);
  const alpha = Buffer.alloc(width * height);
  let retainedPixels = 0,
    opaquePixels = 0,
    nearlyOpaquePixels = 0,
    softPixels = 0,
    clippedPixels = 0,
    clippedOpaquePixels = 0,
    maximumClippedAlpha = 0,
    cropEdgePixels = 0;
  for (let y = 0; y < crop.height; y++)
    for (let x = 0; x < crop.width; x++) {
      const opacity = mask.data[y * crop.width + x]!;
      if (!opacity) continue;
      if (!x || !y || x === crop.width - 1 || y === crop.height - 1)
        cropEdgePixels++;
      const i = (y + crop.top) * width + x + crop.left;
      if (!envelope[i]) {
        clippedPixels++;
        maximumClippedAlpha = Math.max(maximumClippedAlpha, opacity);
        if (opacity >= 250) clippedOpaquePixels++;
        continue;
      }
      retainedPixels++;
      if (opacity >= 250) nearlyOpaquePixels++;
      if (opacity === 255) opaquePixels++;
      else softPixels++;
      alpha[i] = opacity;
      layer[i * 4 + 3] = opacity;
      for (let c = 0; c < 3; c++) {
        layer[i * 4 + c] = generated[i * 3 + c]!;
        candidate[i * 3 + c] = Math.round(
          (generated[i * 3 + c]! * opacity +
            original[i * 3 + c]! * (255 - opacity)) /
            255,
        );
      }
    }
  if (!retainedPixels)
    throw new Error("The extraction mask retains no authorized object pixels");
  return {
    candidate,
    layer,
    alpha,
    evidence: {
      version: "spatial-generated-layer-v1" as const,
      qualification: "not-qualified" as const,
      generatedFingerprint: mask.generatedFingerprint,
      originalFingerprint: createHash("sha256").update(original).digest("hex"),
      maskFingerprint: createHash("sha256").update(mask.data).digest("hex"),
      envelopeFingerprint: createHash("sha256").update(envelope).digest("hex"),
      crop,
      retainedPixels,
      opaquePixels,
      nearlyOpaquePixels,
      softPixels,
      clippedPixels,
      clippedOpaquePixels,
      maximumClippedAlpha,
      cropEdgePixels,
      limitations: [
        "Un masque plausible ne prouve ni l’identité ni l’intégrité des parties fines.",
        "Les débordements sont exclus du diagnostic recomposé et restent signalés ; ils ne sont pas validés.",
        "Les pixels partiellement transparents peuvent contenir du fond généré et former un halo.",
        "Ombres, reflets, transparence physique et occultations ne sont pas reconstruits.",
        "Aucune livraison autorisée : essai séparé du moteur et de sa revue indépendante.",
      ],
    },
  };
}
