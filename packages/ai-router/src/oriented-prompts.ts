import type { ImageReference } from "./index";

export const PREPARED_VIEW_PROMPT_VERSION = "prepared-view-v2.0.0";
export const ORIENTED_HARMONIZATION_PROMPT_VERSION =
  "oriented-harmonization-v1.0.0";

/** Requested camera angles, never measured output orientation or approved coverage. */
export interface RequestedViewOrientation {
  /** Zero is the source front; positive values move the camera to product left. */
  azimuthDeg: number;
  /** Zero is eye level; +90 looks down vertically. */
  elevationDeg: number;
  /** Clockwise camera roll in the image plane. */
  rollDeg: number;
}

export interface PreparedViewGenerationRequest {
  productImage: ImageReference;
  /** An authenticated catalogue reference resolved by the caller, never a scene. */
  referenceImage?: ImageReference;
  requestedOrientation: RequestedViewOrientation;
  instructions?: string;
  deadlineMs?: number;
  /** Persist a known paid response before attempting its download. Never publicize the URL. */
  onProviderResponse?: (
    observation: ImageProviderResponseObservation,
  ) => Promise<void>;
}

export interface ImageProviderResponseObservation {
  requestId: string;
  estimatedCostUsd: number;
  outcome: "succeeded";
  /** Private, expiring provider output reference; not an idempotency token. */
  outputReference: string;
}

export interface OrientedHarmonizationRequest {
  /** The selected view is already placed in this image. No product photo fallback. */
  composition: ImageReference;
  instructions?: string;
  /** Overall render deadline; the adapter reserves time for independent review. */
  deadlineMs?: number;
  onProviderResponse?: (
    observation: ImageProviderResponseObservation,
  ) => Promise<void>;
}

export function validRequestedViewOrientation(
  value: RequestedViewOrientation,
): boolean {
  return (
    Boolean(value) &&
    Number.isFinite(value.azimuthDeg) &&
    Math.abs(value.azimuthDeg) <= 180 &&
    Number.isFinite(value.elevationDeg) &&
    value.elevationDeg >= 0 &&
    value.elevationDeg <= 90 &&
    Number.isFinite(value.rollDeg) &&
    Math.abs(value.rollDeg) <= 180
  );
}

export function buildPreparedViewPrompt(
  orientation: RequestedViewOrientation,
  hasReferenceImage = false,
  instructions?: string,
): string {
  if (!validRequestedViewOrientation(orientation))
    throw new Error("invalid_requested_orientation");
  return [
    `PROMPT_VERSION: ${PREPARED_VIEW_PROMPT_VERSION}`,
    "Operation: prepare a private candidate view of exactly one catalogue product. This is not a room render or an approved product photograph.",
    "Image 1 is the original catalogue product. Keep its shape, silhouette, colors, visible patterns, material and distinctive parts.",
    ...(hasReferenceImage
      ? [
          "Image 2 is an additional authentic catalogue reference of this same product. Use it only to preserve identity; do not create a second object.",
        ]
      : []),
    `Requested camera orientation: azimuth ${orientation.azimuthDeg} degrees (0 = source front; positive = camera moves to product left), elevation ${orientation.elevationDeg} degrees (0 = eye level; 90 = vertical top-down), clockwise image-plane roll ${orientation.rollDeg} degrees.`,
    "Keep the entire object in frame with margin, on a uniform neutral background. No room, support furniture, decoration, label, watermark or cast studio shadow. Keep the input aspect ratio.",
    "Do not invent distinctive decoration on unseen surfaces. Hidden faces remain estimated and require separate review against authentic sources. Do not treat the requested angle as a measurement of the output.",
    ...(instructions?.trim()
      ? [
          `Additional constraints (only when compatible with the rules above): ${instructions.trim()}`,
        ]
      : []),
  ].join("\n");
}

export function buildOrientedHarmonizationPrompt(
  instructions?: string,
): string {
  return [
    `PROMPT_VERSION: ${ORIENTED_HARMONIZATION_PROMPT_VERSION}`,
    "Operation: harmonize the existing precomposed room image. The only input image already contains the selected product view, at its final position, orientation, silhouette and scale.",
    "Modify only local illumination on that existing product and its soft contact/cast shadow. Preserve its visible patterns, colors, distinctive parts and all contours. Do not rotate, reshape, resize, replace or duplicate it.",
    "Preserve the room camera, crop, aspect ratio, support texture, furniture, exposure and white balance. Do not change any background pixel outside the product and its local shadow region. No rectangular lighting patch, black base, halo or floating contact.",
    "There is no additional product reference. Do not reconstruct a frontal view or add an object. Return the complete room image at the same aspect ratio.",
    ...(instructions?.trim()
      ? [
          `Additional local lighting constraints (only when compatible with the rules above): ${instructions.trim()}`,
        ]
      : []),
  ].join("\n");
}
