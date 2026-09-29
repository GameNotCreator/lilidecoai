import "server-only";
import { createHash } from "node:crypto";

/** Offline research policy. A luminance residual is not a physical shadow pass. */
export const SPATIAL_CONTACT_SHADOW_POLICY = Object.freeze({
  version: "spatial-contact-shadow-v1" as const,
  maxPixels: 4_000_000,
  minimumLuminance: 16,
  minimumReferencePixels: 128,
  referenceInnerPx: 8,
  referenceOuterPx: 64,
  maximumReferenceLogMad: Math.log(1.08),
  minimumExposureGain: 0.5,
  maximumExposureGain: 2,
  objectGuardPx: 2,
  filterRadiusPx: 8,
  featherPx: 8,
  contactRadiusPx: 48,
  noiseFloor: 0.02,
  minimumGain: 0.65,
});

/** Capped Manhattan distances. An image edge is outside for inward feathering. */
function distanceToZero(
  mask: Uint8Array,
  width: number,
  height: number,
  cap: number,
  frameOutside = false,
) {
  const distance = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      distance[i] = Math.min(
        cap,
        x ? distance[i - 1]! + 1 : frameOutside ? 1 : cap,
        y ? distance[i - width]! + 1 : frameOutside ? 1 : cap,
      );
    }
  for (let y = height - 1; y >= 0; y--)
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (!mask[i]) continue;
      distance[i] = Math.min(
        distance[i]!,
        x + 1 < width ? distance[i + 1]! + 1 : frameOutside ? 1 : cap,
        y + 1 < height ? distance[i + width]! + 1 : frameOutside ? 1 : cap,
      );
    }
  return distance;
}

function boxSum(
  values: Float32Array,
  width: number,
  height: number,
  radius: number,
) {
  const horizontal = new Float32Array(values.length),
    result = new Float32Array(values.length);
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = 0; x <= Math.min(radius, width - 1); x++)
      sum += values[y * width + x]!;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      horizontal[i] = sum;
      if (x - radius >= 0) sum -= values[i - radius]!;
      if (x + radius + 1 < width) sum += values[i + radius + 1]!;
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = 0; y <= Math.min(radius, height - 1); y++)
      sum += horizontal[y * width + x]!;
    for (let y = 0; y < height; y++) {
      const i = y * width + x;
      result[i] = sum;
      if (y - radius >= 0) sum -= horizontal[i - radius * width]!;
      if (y + radius + 1 < height) sum += horizontal[i + (radius + 1) * width]!;
    }
  }
  return result;
}

export function transferSpatialContactShadow(input: {
  original: Buffer; // Aligned sRGB; every modified support colour comes from here.
  generated: Buffer; // Only scalar luminance contributes to the shadow field.
  objectAlpha: Uint8Array; // Full-size, already constrained to the authorized envelope.
  authorization: Uint8Array; // Frozen object + contact union, binary.
  freeSupport: Uint8Array; // Binary visible support, with holes/obstacles excluded.
  width: number;
  height: number;
}) {
  const {
    original,
    generated,
    objectAlpha,
    authorization,
    freeSupport,
    width,
    height,
  } = input;
  const policy = SPATIAL_CONTACT_SHADOW_POLICY,
    length = width * height;
  if (
    ![width, height].every(Number.isSafeInteger) ||
    width < 1 ||
    height < 1 ||
    length > policy.maxPixels ||
    original.length !== length * 3 ||
    generated.length !== original.length ||
    [objectAlpha, authorization, freeSupport].some(
      (mask) => mask.length !== length,
    ) ||
    [authorization, freeSupport].some((mask) =>
      mask.some((value) => value !== 0 && value !== 255),
    ) ||
    objectAlpha.some((value, i) => value > 0 && !authorization[i])
  )
    throw new Error("Invalid shadow grid, support or authorization mask");
  const hash = (data: Uint8Array) =>
    createHash("sha256").update(data).digest("hex");
  const candidate = Buffer.from(original),
    gain = new Float32Array(length).fill(1);
  const domain = new Uint8Array(length),
    nonObject = new Uint8Array(length),
    outsideAuthorization = new Uint8Array(length);
  let objectPixels = 0;
  for (let i = 0; i < length; i++) {
    const a = objectAlpha[i]!;
    if (a) {
      objectPixels++;
      for (let c = 0; c < 3; c++)
        candidate[i * 3 + c] = Math.round(
          (generated[i * 3 + c]! * a + original[i * 3 + c]! * (255 - a)) / 255,
        );
    }
    nonObject[i] = a ? 0 : 1;
    outsideAuthorization[i] = authorization[i] ? 0 : 1;
    domain[i] = authorization[i] && freeSupport[i] ? 1 : 0;
  }
  const base = {
    version: policy.version,
    qualification: "not-qualified" as const,
    policy,
    fingerprints: {
      original: hash(original),
      generated: hash(generated),
      alpha: hash(objectAlpha),
      authorization: hash(authorization),
      freeSupport: hash(freeSupport),
    },
    limitations: [
      "Résidu de luminance sRGB, sans reconstruction physique des ombres.",
      "Un déplacement de texture ou un décor généré différent peut imiter une ombre.",
      "Le masque et le support sont estimés ; aucune approbation de fidélité ni de réalisme.",
      "Objet et contours alpha conservés ; leur éventuelle contamination de fond reste présente.",
    ],
  };
  const luminance = (data: Buffer, i: number) =>
    0.2126 * data[i * 3]! +
    0.7152 * data[i * 3 + 1]! +
    0.0722 * data[i * 3 + 2]!;
  const median = (values: number[]) => {
    values.sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    return values.length % 2
      ? values[mid]!
      : (values[mid - 1]! + values[mid]!) / 2;
  };
  const referenceDistance = distanceToZero(
    outsideAuthorization,
    width,
    height,
    policy.referenceOuterPx + 1,
  );
  const references: number[] = [];
  for (let i = 0; i < length; i++) {
    if (
      !freeSupport[i] ||
      objectAlpha[i] ||
      referenceDistance[i]! < policy.referenceInnerPx ||
      referenceDistance[i]! > policy.referenceOuterPx
    )
      continue;
    const a = luminance(original, i),
      b = luminance(generated, i);
    if (a >= policy.minimumLuminance && b >= policy.minimumLuminance)
      references.push(Math.log(b / a));
  }
  const logExposure = references.length ? median(references) : null;
  const logMad =
    logExposure === null
      ? null
      : median(references.map((value) => Math.abs(value - logExposure)));
  const exposureGain = logExposure === null ? null : Math.exp(logExposure);
  const calibration = {
    referencePixels: references.length,
    exposureGain,
    referenceLogMad: logMad,
  };
  if (
    !objectPixels ||
    references.length < policy.minimumReferencePixels ||
    logMad === null ||
    logMad > policy.maximumReferenceLogMad ||
    exposureGain === null ||
    exposureGain < policy.minimumExposureGain ||
    exposureGain > policy.maximumExposureGain
  )
    return {
      candidate,
      gain,
      evidence: {
        ...base,
        ...calibration,
        status: "insufficient-evidence" as const,
        reason: !objectPixels
          ? "missing-object"
          : "unreliable-exposure-reference",
        modifiedPixels: 0,
      },
    };
  const objectDistance = distanceToZero(
    nonObject,
    width,
    height,
    policy.contactRadiusPx + 1,
  );
  const boundaryDistance = distanceToZero(
    domain,
    width,
    height,
    policy.featherPx + 1,
    true,
  );
  const values = new Float32Array(length),
    weights = new Float32Array(length);
  let sampledPixels = 0;
  for (let i = 0; i < length; i++) {
    if (
      !domain[i] ||
      objectDistance[i]! <= policy.objectGuardPx ||
      objectDistance[i]! > policy.contactRadiusPx
    )
      continue;
    const a = luminance(original, i),
      b = luminance(generated, i);
    if (a < policy.minimumLuminance || b < policy.minimumLuminance) continue;
    // Average signed residuals before clipping: dark texture differences must
    // not all become shadows while their brighter neighbours are discarded.
    values[i] = Math.log(Math.max(0.25, Math.min(4, b / (a * exposureGain))));
    weights[i] = 1;
    sampledPixels++;
  }
  if (sampledPixels < 16)
    return {
      candidate,
      gain,
      evidence: {
        ...base,
        ...calibration,
        status: "insufficient-evidence" as const,
        reason: "insufficient-shadow-samples",
        sampledPixels,
        modifiedPixels: 0,
      },
    };
  const sums = boxSum(values, width, height, policy.filterRadiusPx),
    counts = boxSum(weights, width, height, policy.filterRadiusPx);
  let modifiedPixels = 0,
    minimumAppliedGain = 1;
  const ease = (x: number) => {
    const t = Math.max(0, Math.min(1, x));
    return t * t * (3 - 2 * t);
  };
  for (let i = 0; i < length; i++) {
    if (
      !domain[i] ||
      objectAlpha[i] ||
      counts[i]! < 16 ||
      objectDistance[i]! >= policy.contactRadiusPx
    )
      continue;
    const ratio = Math.exp(sums[i]! / counts[i]!);
    const darkness = Math.min(
      1 - policy.minimumGain,
      Math.max(0, 1 - ratio - policy.noiseFloor),
    );
    const opacity =
      ease((boundaryDistance[i]! - 1) / policy.featherPx) *
      ease((policy.contactRadiusPx - objectDistance[i]!) / policy.featherPx);
    const factor = 1 - darkness * opacity;
    gain[i] = factor;
    minimumAppliedGain = Math.min(minimumAppliedGain, factor);
    let changed = false;
    for (let c = 0; c < 3; c++) {
      const value = Math.round(original[i * 3 + c]! * factor);
      changed ||= value !== original[i * 3 + c];
      candidate[i * 3 + c] = value;
    }
    if (changed) modifiedPixels++;
  }
  return {
    candidate,
    gain,
    evidence: {
      ...base,
      ...calibration,
      status: "experimental" as const,
      reason: "review-required",
      sampledPixels,
      modifiedPixels,
      minimumAppliedGain,
    },
  };
}
