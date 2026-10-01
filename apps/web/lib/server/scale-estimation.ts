import "server-only";

import { createHash } from "node:crypto";

import type { SceneLightingEstimate } from "@lili/ai-router";
import type { SimplePlacementKind, SimpleScaleSource } from "@lili/geometry";
import type { Db } from "mongodb";
import sharp from "sharp";

import { readAsset } from "./assets";
import { serverConfig } from "./config";
import { collections } from "./mongodb";
import type { SceneDocument } from "./types";
import { durableAbortSignal } from "./durable-context";

/**
 * Metric scale and lighting estimation for the simple multi-point workflow.
 *
 * One vision call per (points, kinds) tuple, cached on the scene document.
 * The photo sent to the model carries numbered red rings at the tap points so
 * the answer refers to a visible location, not to abstract coordinates. The
 * marked copy is only ever sent to the vision model, never to `/images/edits`.
 *
 * The raw answer is turned into one `SceneScaleSpan` per point through a
 * deterministic ladder (`resolveSpans`): a confident, cross-checked 10 cm span
 * wins; otherwise a nearby measurement on the same support; otherwise the
 * estimated frame width; otherwise the geometry's assumed-room-width fallback
 * applies downstream.
 */

export interface SceneScaleSpan {
  pixelsPerCm: number | null;
  scaleSource: SimpleScaleSource;
  confidence: "high" | "low" | "none";
  supportKind: string;
  supportMaterial: string;
  supportGlossy: boolean;
  referenceKind: string;
  impliedFrameWidthCm: number | null;
  /** Same physical support plane, identified within this analysis only. */
  supportPlaneId?: number;
}

export interface SceneScaleResult {
  spans: SceneScaleSpan[];
  lighting: SceneLightingEstimate | null;
  cached: boolean;
  /**
   * What the paid vision pass actually did, so the caller can journal it.
   * Absent when no call was made — a cache hit, mock mode, or a missing photo.
   * A13: this pass was the last paid call of the simple pipeline that reached
   * no journal at all.
   */
  call?: {
    outcome: "succeeded" | "failed" | "unknown";
    estimatedCostUsd: number;
    latencyMs: number;
    model: string;
  };
}

export interface SceneScaleEstimate {
  spans: SceneScaleSpan[];
  lighting: SceneLightingEstimate | null;
  call?: SceneScaleResult["call"];
}

/** Server-only opt-in; historical scale estimates retain their original key. */
export const STOREFRONT_SCALE_PROFILE = "storefront-placement-v1";

export interface MarkedPoint {
  x: number;
  y: number;
  /** Number printed above the ring; defaults to the 1-based index. */
  label?: number;
}

/** Raw per-point answer of the `scale_spans_v2` schema. */
export interface RawScaleSpan {
  pointNumber: number;
  supportKind: string;
  supportMaterial: string;
  supportGlossy: boolean;
  tenCmPixels: number;
  confident: boolean;
  frameWidthCm: number;
  referenceKind: string;
  referenceRealCm: number;
  referencePixels: number;
  referenceAxis: string;
  referenceAtSameDepth: boolean;
  supportPlaneId?: number;
}

const SUPPORT_KINDS = [
  "floor",
  "table",
  "shelf",
  "counter",
  "bed",
  "sofa",
  "windowsill",
  "wall",
  "other",
] as const;
const SUPPORT_MATERIALS = [
  "wood",
  "glass",
  "stone",
  "fabric",
  "tile",
  "metal",
  "painted",
  "carpet",
  "other",
] as const;
const REFERENCE_KINDS = [
  "door",
  "door_handle",
  "switch_or_outlet",
  "worktop",
  "table",
  "chair_seat",
  "bed",
  "radiator",
  "tile",
  "shelf_spacing",
  "a4_sheet",
  "book",
  "plate",
  "bottle",
  "mug",
  "laptop",
  "phone",
  "window",
  "other",
  "none",
] as const;
/** Axis the reference was measured along. Never average different axes. */
const REFERENCE_AXES = ["horizontal", "vertical"] as const;
const LIGHT_DIRECTIONS = [
  "left",
  "right",
  "front",
  "behind",
  "top",
  "diffuse",
] as const;
const LIGHT_ELEVATIONS = ["low", "mid", "high"] as const;
const SHADOW_SOFTNESS = ["hard", "soft"] as const;
const COLOUR_TEMPERATURES = ["warm", "neutral", "cool"] as const;
const SHADOW_DIRECTIONS = [
  "left",
  "right",
  "toward_camera",
  "away_from_camera",
  "straight_down",
  "none_visible",
] as const;

/** Real-size windows (cm) a reference of each kind may plausibly report. */
const REFERENCE_RANGES: Record<string, readonly [number, number]> = {
  door: [70, 220],
  door_handle: [90, 110],
  switch_or_outlet: [7, 9],
  worktop: [85, 95],
  table: [70, 80],
  chair_seat: [40, 50],
  bed: [180, 210],
  radiator: [40, 90],
  tile: [20, 80],
  shelf_spacing: [25, 40],
  a4_sheet: [20, 30],
  book: [18, 30],
  plate: [20, 32],
  bottle: [25, 35],
  mug: [8, 13],
  laptop: [28, 40],
  phone: [13, 17],
  window: [60, 200],
  other: [5, 300],
};

/** Accepted 10 cm span, as a fraction of the longest scene side. */
export const MIN_TEN_CM_FRACTION = 0.008;
export const MAX_TEN_CM_FRACTION = 0.2;
/** Beyond this disagreement the span and its reference contradict each other. */
export const REFERENCE_CONSISTENCY_TOLERANCE = 0.4;
/**
 * A reference is compared with a span on another axis, so perspective
 * alone separates them: only a gross disagreement condemns the answer.
 */
export const CROSS_AXIS_CONSISTENCY_TOLERANCE = 1;
/** Frame width window used by the coarse rung. */
/**
 * Two points this close in height sit at practically the same depth, so a
 * verified scale carries over almost exactly.
 */
export const SAME_DEPTH_TOLERANCE = 0.08;
/** Nearby pixels are not evidence of shared depth across an entire room. */
export const MAX_NEIGHBOUR_DISTANCE = 0.25;
/** Distinct point sets kept per scene before the oldest are dropped. */
export const MAX_CACHED_SCALES = 24;
/**
 * One high-detail vision pass over the marked photo. A local constant, like
 * every cost in this codebase: it bounds a runaway render, it does not
 * reconcile an invoice.
 */
export const SCALE_VISION_COST_USD = 0.03;
export const MIN_FRAME_WIDTH_CM = 80;
export const MAX_FRAME_WIDTH_CM = 900;

const NO_SCALE: SceneScaleSpan = {
  pixelsPerCm: null,
  scaleSource: "assumed_room_width",
  confidence: "none",
  supportKind: "other",
  supportMaterial: "other",
  supportGlossy: false,
  referenceKind: "none",
  impliedFrameWidthCm: null,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" &&
    (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/**
 * Whether a reference of `kind` may really measure `realCm`. A model that
 * reports a 50 cm door or a 3 cm mug has misread the scene and its span
 * cannot be trusted. `none` is never plausible: there is no reference.
 */
export function referencePlausible(kind: string, realCm: number): boolean {
  if (!Number.isFinite(realCm) || realCm <= 0) return false;
  const range = REFERENCE_RANGES[kind];
  if (!range) return false;
  return realCm >= range[0] && realCm <= range[1];
}

function assumedSpan(): SceneScaleSpan {
  return { ...NO_SCALE };
}

/**
 * Deterministic ladder turning the raw answer into one span per point:
 *
 * 1. `vision` (high): the model is confident, its 10 cm span lies inside
 *    [0.008, 0.2] of the long side and its measurable size reference is at the
 *    same depth. Same-axis measurements must agree within 40 %; their
 *    geometric mean is used. Cross-axis measurements are never averaged.
 * 2. `vision_coarse` (low): the estimated frame width, clamped to 80–900 cm.
 * 3. `vision_interpolated` (low): a nearby confident point on the same support
 *    plane, at practically the same depth. Pixel y is not a depth coordinate:
 *    no y-ratio extrapolation is allowed without a calibrated horizon.
 * 4. `assumed_room_width` (none): `pixelsPerCm` null; the geometry's own
 *    fallback applies and a warning is logged.
 */
export function resolveSpans(
  raw: readonly RawScaleSpan[] | null | undefined,
  points: ReadonlyArray<{ x: number; y: number }>,
  sceneWidth: number,
  sceneHeight: number,
  kinds: readonly SimplePlacementKind[] = [],
): SceneScaleSpan[] {
  const longSide = Math.max(1, sceneWidth, sceneHeight);
  const minTenCm = MIN_TEN_CM_FRACTION * longSide;
  const maxTenCm = MAX_TEN_CM_FRACTION * longSide;

  type Partial = {
    span: SceneScaleSpan;
    confident: boolean;
    tenCmPixels: number | null;
    frameWidthCm: number | null;
  };
  const partials: Partial[] = points.map((_, index) => {
    const matches = (raw ?? []).filter(
      (candidate) => Number(candidate?.pointNumber) === index + 1,
    );
    // Duplicate point numbers are ambiguous; do not pick one arbitrarily.
    const item = matches.length === 1 ? matches[0] : undefined;
    if (!item) {
      return {
        span: assumedSpan(),
        confident: false,
        tenCmPixels: null,
        frameWidthCm: null,
      };
    }
    const supportKind = oneOf(item.supportKind, SUPPORT_KINDS, "other");
    const supportMaterial = oneOf(
      item.supportMaterial,
      SUPPORT_MATERIALS,
      "other",
    );
    const referenceKind = oneOf(item.referenceKind, REFERENCE_KINDS, "none");
    const frameWidth = Number(item.frameWidthCm);
    const frameWidthCm =
      Number.isFinite(frameWidth) && frameWidth > 0 ? frameWidth : null;

    let tenCm: number | null = Number(item.tenCmPixels);
    if (!Number.isFinite(tenCm) || tenCm < minTenCm || tenCm > maxTenCm) {
      tenCm = null;
    }
    const referenceRealCm = Number(item.referenceRealCm);
    let confident =
      item.confident === true &&
      tenCm !== null &&
      referenceKind !== "none" &&
      referencePlausible(referenceKind, referenceRealCm) &&
      item.referenceAtSameDepth === true;
    const referenceAxis = oneOf(
      item.referenceAxis,
      REFERENCE_AXES,
      "horizontal",
    );
    const referencePixels = Number(item.referencePixels);
    const measurable = Number.isFinite(referencePixels) && referencePixels > 4;
    const targetAxis = kinds[index] === "flat" ? "horizontal" : "vertical";
    if (confident) {
      if (!measurable) {
        // The model claims a verified reference at this depth but gives no
        // usable pixel extent for it: the one answer that cannot be checked
        // is exactly the one not to trust on its word.
        confident = false;
      } else if (tenCm !== null) {
        const implied = (referencePixels / referenceRealCm) * 10;
        const disagreement = Math.max(implied / tenCm, tenCm / implied) - 1;
        if (referenceAxis === targetAxis) {
          // Same axis as the requested 10 cm span: both measure the same
          // thing, so they must agree closely and averaging them is sound.
          if (disagreement > REFERENCE_CONSISTENCY_TOLERANCE + 1e-9) {
            confident = false;
          } else {
            const merged = Math.sqrt(tenCm * implied);
            // The merge can walk out of the acceptance window it was checked
            // against; re-validate rather than report an unchecked number.
            if (merged < minTenCm || merged > maxTenCm) {
              confident = false;
            } else {
              tenCm = merged;
            }
          }
        } else if (disagreement > CROSS_AXIS_CONSISTENCY_TOLERANCE) {
          // Cross-axis perspective differs, but a gross discrepancy is not
          // evidence of a reliable metric estimate. Never average the axes.
          confident = false;
        }
      }
    }
    return {
      span: {
        pixelsPerCm: null,
        scaleSource: "assumed_room_width",
        confidence: "none",
        supportKind,
        supportMaterial,
        supportGlossy: item.supportGlossy === true,
        ...(Number.isInteger(item.supportPlaneId) &&
        (item.supportPlaneId ?? 0) > 0
          ? { supportPlaneId: item.supportPlaneId }
          : {}),
        referenceKind,
        // Reported clamped, so the number shown always matches the one that
        // would drive the scale.
        impliedFrameWidthCm:
          frameWidthCm === null
            ? null
            : clamp(frameWidthCm, MIN_FRAME_WIDTH_CM, MAX_FRAME_WIDTH_CM),
      },
      confident,
      tenCmPixels: tenCm,
      frameWidthCm,
    };
  });

  const confidentPoints = partials
    .map((partial, index) => ({ partial, index }))
    .filter(({ partial }) => partial.confident && partial.tenCmPixels !== null);

  return partials.map((partial, index) => {
    const point = points[index] ?? { x: 0.5, y: 0.5 };
    if (partial.confident && partial.tenCmPixels !== null) {
      return {
        ...partial.span,
        pixelsPerCm: partial.tenCmPixels / 10,
        scaleSource: "vision",
        confidence: "high",
      };
    }
    const nearest = nearestConfidentPoint(
      confidentPoints.filter(
        ({ partial: candidate, index: candidateIndex }) => {
          const reference = points[candidateIndex];
          if (
            !reference ||
            Math.abs(reference.y - point.y) > SAME_DEPTH_TOLERANCE
          )
            return false;
          if (
            (kinds[candidateIndex] ?? "standing") !==
            (kinds[index] ?? "standing")
          )
            return false;
          if (
            partial.span.supportKind === "other" ||
            candidate.span.supportKind !== partial.span.supportKind
          )
            return false;
          if (
            partial.span.supportPlaneId !== undefined ||
            candidate.span.supportPlaneId !== undefined
          ) {
            return (
              partial.span.supportPlaneId !== undefined &&
              partial.span.supportPlaneId === candidate.span.supportPlaneId
            );
          }
          return (
            candidate.span.supportMaterial === partial.span.supportMaterial
          );
        },
      ),
      points,
      point,
      sceneWidth,
      sceneHeight,
    );
    const interpolate = () => {
      if (!nearest) return null;
      const perCm = (nearest.partial.tenCmPixels as number) / 10;
      return {
        ...partial.span,
        pixelsPerCm: perCm,
        scaleSource: "vision_interpolated" as const,
        confidence: "low" as const,
      };
    };

    // A verified neighbour sitting at practically the same depth is a
    // measurement, not a guess: it outranks the model's own coarse estimate
    // of how wide the frame is here. Without this the frame-width rung, which
    // the prompt asks the model to always fill in, would swallow every
    // remaining point and the interpolation rung would be dead code.
    const interpolated = interpolate();
    if (interpolated) return interpolated;
    if (partial.frameWidthCm !== null) {
      const frame = clamp(
        partial.frameWidthCm,
        MIN_FRAME_WIDTH_CM,
        MAX_FRAME_WIDTH_CM,
      );
      return {
        ...partial.span,
        pixelsPerCm: sceneWidth / frame,
        scaleSource: "vision_coarse",
        confidence: "low",
      };
    }
    console.warn(
      `Scale estimation: no usable scale for point ${index + 1}; the assumed room width applies.`,
    );
    return { ...partial.span, pixelsPerCm: null };
  });
}

interface ConfidentPoint {
  partial: { tenCmPixels: number | null };
  index: number;
}

/** The confident point closest in the frame, or null when there is none. */
function nearestConfidentPoint<T extends ConfidentPoint>(
  candidates: readonly T[],
  points: ReadonlyArray<{ x: number; y: number }>,
  point: { x: number; y: number },
  sceneWidth: number,
  sceneHeight: number,
): T | null {
  let nearest: T | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const reference = points[candidate.index] ?? { x: 0.5, y: 0.5 };
    const distance = Math.hypot(
      (reference.x - point.x) * sceneWidth,
      (reference.y - point.y) * sceneHeight,
    );
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = candidate;
    }
  }
  return nearestDistance <=
    MAX_NEIGHBOUR_DISTANCE * Math.max(sceneWidth, sceneHeight)
    ? nearest
    : null;
}

function sanitizeLighting(value: unknown): SceneLightingEstimate | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return {
    lightDirection: oneOf(record.lightDirection, LIGHT_DIRECTIONS, "diffuse"),
    lightElevation: oneOf(record.lightElevation, LIGHT_ELEVATIONS, "mid"),
    shadowSoftness: oneOf(record.shadowSoftness, SHADOW_SOFTNESS, "soft"),
    colourTemperature: oneOf(
      record.colourTemperature,
      COLOUR_TEMPERATURES,
      "neutral",
    ),
    shadowDirection: oneOf(
      record.shadowDirection,
      SHADOW_DIRECTIONS,
      "none_visible",
    ),
  };
}

function ringRadius(sceneWidth: number, sceneHeight: number): number {
  return Math.max(10, Math.round(0.012 * Math.max(sceneWidth, sceneHeight)));
}

/**
 * Draws a numbered red ring at every point. One sharp pipeline: the SVG is
 * composited over the (already oriented) scene and encoded as webp. The
 * result is a vision-model input only.
 */
export async function markPoints(
  sceneWebp: Buffer,
  points: readonly MarkedPoint[],
  sceneWidth: number,
  sceneHeight: number,
): Promise<Buffer> {
  const radius = ringRadius(sceneWidth, sceneHeight);
  const stroke = Math.max(3, Math.round(radius * 0.3));
  const discRadius = Math.max(9, Math.round(radius * 0.85));
  const fontSize = Math.round(discRadius * 1.3);
  const shapes = points
    .map((point, index) => {
      const label = point.label ?? index + 1;
      const cx = Math.round(clamp(point.x, 0, 1) * sceneWidth);
      const cy = Math.round(clamp(point.y, 0, 1) * sceneHeight);
      const labelOffset = radius + stroke + discRadius + 4;
      const discY = clamp(
        cy - labelOffset < discRadius + 2 ? cy + labelOffset : cy - labelOffset,
        discRadius + 2,
        sceneHeight - discRadius - 2,
      );
      const discX = clamp(cx, discRadius + 2, sceneWidth - discRadius - 2);
      return [
        `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="#ffffff" stroke-width="${stroke + 6}"/>`,
        `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="#e5232b" stroke-width="${stroke}"/>`,
        `<circle cx="${discX}" cy="${discY}" r="${discRadius + 2}" fill="#e5232b"/>`,
        `<circle cx="${discX}" cy="${discY}" r="${discRadius}" fill="#ffffff"/>`,
        `<text x="${discX}" y="${discY}" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="bold" fill="#e5232b" text-anchor="middle" dominant-baseline="central">${label}</text>`,
      ].join("");
    })
    .join("");
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sceneWidth}" height="${sceneHeight}">${shapes}</svg>`,
  );
  return sharp(sceneWebp)
    .composite([{ input: svg, blend: "over" }])
    .webp({ quality: 90 })
    .toBuffer();
}

function supportExpectation(kind: SimplePlacementKind): string {
  if (kind === "wall") return "a vertical wall";
  if (kind === "flat") return "the floor";
  return "a horizontal surface — shelf, table top, counter or floor";
}

function buildScalePrompt(
  points: ReadonlyArray<{ x: number; y: number }>,
  kinds: readonly SimplePlacementKind[],
  sceneWidth: number,
  sceneHeight: number,
): string {
  const radius = ringRadius(sceneWidth, sceneHeight);
  const pointLines = points.map((point, index) => {
    const px = Math.round(point.x * sceneWidth);
    const py = Math.round(point.y * sceneHeight);
    const kind = kinds[index] ?? "standing";
    const measurement =
      kind === "flat"
        ? "a 10 cm horizontal segment on the support plane"
        : "the screen height of a 10 cm upright vertical segment at this depth";
    return `Point ${index + 1}: ring centre at pixel x=${px}, y=${py} (normalized x=${point.x.toFixed(4)}, y=${point.y.toFixed(4)}). Expected support: ${supportExpectation(kind)}. Measure tenCmPixels as ${measurement}.`;
  });
  return [
    `Metric scale and lighting estimation for one interior photograph of ${sceneWidth}x${sceneHeight} pixels.`,
    `Markers: ${points.length === 1 ? "one red ring" : `${points.length} red rings`} (radius about ${radius} px, white outline, a numbered white disc above each) have been drawn onto the photograph by software. They are annotations only: ignore them when judging size and lighting, never treat a ring as an obstacle, and never use a ring as a size reference.`,
    ...pointLines,
    "Coordinates: pixel x grows to the right from the left edge, pixel y grows downward from the top edge; normalized values are the pixel values divided by the image width and height.",
    "For each point:",
    "1. Identify the surface directly under the ring centre (floor, table, shelf, counter, bed, sofa, windowsill, wall or other), its material, whether it is glossy, and how deep in the room it lies. Assign supportPlaneId as a positive integer: use the same id only for points on the SAME physical plane (not merely two tables or shelves of the same material). Use 0 if the plane is ambiguous.",
    "2. Choose the single most reliable size reference visible at a comparable depth to that surface. Typical real sizes: door 200 cm tall and 80 cm wide; door handle 100 cm above the floor; light switch or outlet plate 8 cm; kitchen worktop 90 cm high; dining table 75 cm high; chair seat 45 cm high; bed 200 cm long; radiator 60 cm high; floor tile 30-60 cm; shelf spacing 30-35 cm; A4 sheet 21 x 30 cm; hardcover book 24 cm tall; dinner plate 27 cm across; wine bottle 30 cm tall; mug 10 cm tall; laptop 33 cm wide; phone 15 cm tall; window 60-200 cm wide.",
    "3. tenCmPixels: follow the measurement axis specified separately for each point. Upright objects are sized by their vertical height, NOT by a foreshortened segment running along a table or floor. Flat objects use horizontal support width. Do not estimate depth by dividing image y coordinates: the horizon is not the top image edge.",
    "4. Report the reference you used: referenceKind, the real size you assumed in centimetres (referenceRealCm), its measurable complete extent in pixels (referencePixels), the axis of that extent (referenceAxis), and whether it sits at the same depth as the ring centre (referenceAtSameDepth). Prefer the requested measurement axis. Do not invent a reference hidden by furniture, outside the frame or behind the camera.",
    "5. confident is true only when a measurable reference at the SAME depth exists and you expect tenCmPixels to be within about 25 % of the truth. Otherwise set confident to false and still give your best estimate; use referenceKind none when no real reference is visible. A single photograph cannot prove metric scale without a known reference.",
    "6. frameWidthCm: the real width in centimetres of the scene spanned by the full image width at the depth of the ring centre. Always fill it in.",
    "Lighting of the whole photograph: lightDirection is where the main light comes from (left, right, front = from behind the camera, behind = from the back of the room, top, or diffuse when no direction dominates); lightElevation is how high that light sits (low, mid, high); shadowSoftness is hard for crisp shadow edges and soft for blurred ones; colourTemperature is warm, neutral or cool; shadowDirection is where the existing shadows fall (left, right, toward_camera, away_from_camera, straight_down, or none_visible).",
    "Answer with the JSON object only.",
  ].join("\n");
}

const SCALE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    spans: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          pointNumber: { type: "integer" },
          supportKind: { type: "string", enum: [...SUPPORT_KINDS] },
          supportMaterial: { type: "string", enum: [...SUPPORT_MATERIALS] },
          supportGlossy: { type: "boolean" },
          supportPlaneId: { type: "integer" },
          tenCmPixels: { type: "number" },
          confident: { type: "boolean" },
          frameWidthCm: { type: "number" },
          referenceKind: { type: "string", enum: [...REFERENCE_KINDS] },
          referenceRealCm: { type: "number" },
          referencePixels: { type: "number" },
          referenceAxis: { type: "string", enum: ["horizontal", "vertical"] },
          referenceAtSameDepth: { type: "boolean" },
        },
        required: [
          "pointNumber",
          "supportKind",
          "supportMaterial",
          "supportGlossy",
          "supportPlaneId",
          "tenCmPixels",
          "confident",
          "frameWidthCm",
          "referenceKind",
          "referenceRealCm",
          "referencePixels",
          "referenceAxis",
          "referenceAtSameDepth",
        ],
      },
    },
    lighting: {
      type: "object",
      additionalProperties: false,
      properties: {
        lightDirection: { type: "string", enum: [...LIGHT_DIRECTIONS] },
        lightElevation: { type: "string", enum: [...LIGHT_ELEVATIONS] },
        shadowSoftness: { type: "string", enum: [...SHADOW_SOFTNESS] },
        colourTemperature: { type: "string", enum: [...COLOUR_TEMPERATURES] },
        shadowDirection: { type: "string", enum: [...SHADOW_DIRECTIONS] },
      },
      required: [
        "lightDirection",
        "lightElevation",
        "shadowSoftness",
        "colourTemperature",
        "shadowDirection",
      ],
    },
  },
  required: ["spans", "lighting"],
} as const;

function fallbackEstimate(count: number): SceneScaleEstimate {
  return {
    spans: Array.from({ length: count }, () => assumedSpan()),
    lighting: null,
  };
}

export const SCALE_ESTIMATION_TIMEOUT_MS = 90_000;

export interface ScaleEstimationOptions {
  /** Absolute remaining render deadline, including any downstream reserve. */
  deadlineMs?: number;
  profile?: typeof STOREFRONT_SCALE_PROFILE;
}

/**
 * One `/v1/responses` call for every point. Best effort: any transport,
 * schema or truncation problem yields the assumed-room-width fallback.
 */
export async function estimateSceneScale(
  sceneWebp: Buffer,
  points: ReadonlyArray<{ x: number; y: number }>,
  kinds: readonly SimplePlacementKind[],
  sceneWidth: number,
  sceneHeight: number,
  options: ScaleEstimationOptions = {},
): Promise<SceneScaleEstimate> {
  if (points.length === 0) return { spans: [], lighting: null };
  if (serverConfig.aiMockMode || !serverConfig.openaiApiKey) {
    return fallbackEstimate(points.length);
  }
  const startedAt = Date.now();
  const deadline = Math.min(
    startedAt + (options.profile === STOREFRONT_SCALE_PROFILE ? 70_000 : SCALE_ESTIMATION_TIMEOUT_MS),
    options.deadlineMs ?? Infinity,
  );
  if (deadline <= startedAt) return fallbackEstimate(points.length);
  const call = (outcome: "succeeded" | "failed" | "unknown") => ({
    outcome,
    estimatedCostUsd: outcome === "failed" ? 0 : SCALE_VISION_COST_USD,
    latencyMs: Date.now() - startedAt,
    model: serverConfig.openaiVisionModel,
  });
  try {
    const marked = await markPoints(sceneWebp, points, sceneWidth, sceneHeight);
    const remaining = Math.floor(deadline - Date.now());
    // Preparing the image consumes the same step budget. Do not start a
    // billable request after the parent render's remaining time has elapsed.
    if (remaining <= 0) return fallbackEstimate(points.length);
    const response = await fetchOpenAIResponse(
      {
        model: serverConfig.openaiVisionModel,
        store: false,
        service_tier: serverConfig.openaiServiceTier,
        reasoning: { effort: options.profile === STOREFRONT_SCALE_PROFILE ? "medium" : serverConfig.openaiVisionReasoning ?? "high" },
        max_output_tokens: 8_000,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: buildScalePrompt(points, kinds, sceneWidth, sceneHeight),
              },
              {
                type: "input_image",
                image_url: `data:image/webp;base64,${marked.toString("base64")}`,
                detail: "high",
              },
            ],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "scale_spans_v3",
            strict: true,
            schema: SCALE_SCHEMA,
          },
        },
      },
      remaining,
    );
    if (!response.ok) {
      console.error(
        `Scale estimation failed with HTTP ${response.status}; falling back.`,
      );
      // Refused before generation: known, and not billed.
      return { ...fallbackEstimate(points.length), call: call("failed") };
    }
    const output = await openAIResponseOutput(response);
    if (output.status === "incomplete" || !output.text) {
      console.error(
        `Scale estimation returned status ${output.status ?? "unknown"} (${output.incompleteReason ?? "no output text"}); falling back.`,
      );
      // HTTP 200 truncated or empty: the model ran, and the call is billed.
      return { ...fallbackEstimate(points.length), call: call("succeeded") };
    }
    const parsed = JSON.parse(output.text) as {
      spans?: RawScaleSpan[];
      lighting?: unknown;
    };
    return {
      spans: resolveSpans(
        Array.isArray(parsed.spans) ? parsed.spans : [],
        points,
        sceneWidth,
        sceneHeight,
        kinds,
      ),
      lighting: sanitizeLighting(parsed.lighting),
      call: call("succeeded"),
    };
  } catch (reason) {
    console.error("Scale estimation failed; falling back.", reason);
    // A thrown call may have reached the model: its outcome is unknown.
    return { ...fallbackEstimate(points.length), call: call("unknown") };
  }
}

/**
 * Algorithm version of the estimation: the prompt, its JSON schema and the
 * `resolveSpans` ladder together. Bump it whenever any of the three changes,
 * so scenes stop serving an estimate the current code would not produce.
 */
export const SCALE_ESTIMATION_VERSION = "scale-v3";

/**
 * Cache key: the estimator's identity (algorithm version and vision model)
 * plus the points at the input contract's 4-decimal precision and their kinds.
 * A former 1 % rounding merged opposite sides of shelf edges into one entry.
 */
export function sceneScaleCacheKey(
  points: ReadonlyArray<{ x: number; y: number }>,
  kinds: readonly SimplePlacementKind[],
  profile?: typeof STOREFRONT_SCALE_PROFILE,
): string {
  const payload = JSON.stringify({
    ...(profile ? { profile } : {}),
    reasoning: profile === STOREFRONT_SCALE_PROFILE ? "medium" : serverConfig.openaiVisionReasoning ?? "high",
    version: SCALE_ESTIMATION_VERSION,
    model: serverConfig.openaiVisionModel,
    points: points.map((point) => [
      Math.round(point.x * 10_000) / 10_000,
      Math.round(point.y * 10_000) / 10_000,
    ]),
    kinds,
  });
  return createHash("sha1").update(payload, "utf8").digest("hex");
}

interface CachedSceneScale {
  spans: SceneScaleSpan[];
  lighting: SceneLightingEstimate | null;
  createdAt: Date;
}

function cachedEstimate(
  scene: SceneDocument,
  key: string,
  count: number,
): SceneScaleEstimate | null {
  const store = scene.analysis?.simpleScale;
  if (!store || typeof store !== "object") return null;
  const entry = (store as Record<string, unknown>)[key] as
    CachedSceneScale | undefined;
  if (!entry || !Array.isArray(entry.spans) || entry.spans.length !== count) {
    return null;
  }
  return { spans: entry.spans, lighting: sanitizeLighting(entry.lighting) };
}

/**
 * Cached scale estimation for a scene. Mock mode and a missing key return the
 * assumed-room-width fallback for every point with no network and no cache.
 */
export async function getOrEstimateSceneScale(
  db: Db,
  scene: SceneDocument,
  points: ReadonlyArray<{ x: number; y: number }>,
  kinds: readonly SimplePlacementKind[],
  options: ScaleEstimationOptions = {},
): Promise<SceneScaleResult> {
  const normalizedKinds = points.map((_, index) => kinds[index] ?? "standing");
  if (serverConfig.aiMockMode || !serverConfig.openaiApiKey) {
    return { ...fallbackEstimate(points.length), cached: false };
  }
  const key = sceneScaleCacheKey(points, normalizedKinds, options.profile);
  const cached = cachedEstimate(scene, key, points.length);
  if (cached) return { ...cached, cached: true };

  // Durable renders retain the scene as it was at admission. The browser's
  // scale request can finish afterwards, so consult only this exact cache
  // entry without replacing the immutable source/placement snapshot.
  const refreshed = await collections(db).scenes.findOne(
    {
      id: scene.id,
      organizationId: scene.organizationId,
      assetId: scene.assetId,
      status: { $ne: "deleted" },
      expiresAt: { $gt: new Date() },
      ...(scene.publicSessionId
        ? { publicSessionId: scene.publicSessionId }
        : {}),
    },
    { projection: { _id: 0, [`analysis.simpleScale.${key}`]: 1 } },
  );
  const refreshedCache = refreshed
    ? cachedEstimate(refreshed, key, points.length)
    : null;
  if (refreshedCache) return { ...refreshedCache, cached: true };

  const asset = await readAsset(db, scene.assetId);
  if (!asset) return { ...fallbackEstimate(points.length), cached: false };
  const { data: sceneWebp, info } = await prepareSceneForScale(asset.buffer);
  const sceneWidth = info.width;
  const sceneHeight = info.height;
  const estimate = await estimateSceneScale(
    sceneWebp,
    points,
    normalizedKinds,
    sceneWidth,
    sceneHeight,
    options,
  );
  // A timeout or unusable answer must be retryable on the next request.
  if (!estimate.spans.some((span) => span.pixelsPerCm !== null)) {
    return { ...estimate, cached: false };
  }
  const entry: CachedSceneScale = { ...estimate, createdAt: new Date() };
  // One entry per distinct set of points, inside the scene document. Left
  // unbounded it grows with every re-tap and, under abuse, until Mongo's 16 MB
  // document ceiling makes the scene unusable. Oldest entries go first.
  const store = (scene.analysis?.simpleScale ?? {}) as Record<
    string,
    CachedSceneScale
  >;
  const update: Record<string, unknown> = {
    [`analysis.simpleScale.${key}`]: entry,
  };
  const unset: Record<string, ""> = {};
  const existing = Object.entries(store).filter(([name]) => name !== key);
  if (existing.length + 1 > MAX_CACHED_SCALES) {
    existing
      .sort(
        (a, b) =>
          new Date(a[1]?.createdAt ?? 0).getTime() -
          new Date(b[1]?.createdAt ?? 0).getTime(),
      )
      .slice(0, existing.length + 1 - MAX_CACHED_SCALES)
      .forEach(([name]) => {
        unset[`analysis.simpleScale.${name}`] = "";
      });
  }
  await collections(db).scenes.updateOne(
    { id: scene.id },
    Object.keys(unset).length > 0
      ? { $set: update, $unset: unset }
      : { $set: update },
  );
  return { ...estimate, cached: false };
}

/** Dimensions must come from encoded pixels, after EXIF auto-orientation. */
export async function prepareSceneForScale(buffer: Buffer) {
  return sharp(buffer)
    .rotate()
    .webp({ quality: 92 })
    .toBuffer({ resolveWithObject: true });
}

/** Parsed `/v1/responses` payload: the first output_text plus the status. */
export interface OpenAIResponseOutput {
  text: string | null;
  status: string | null;
  incompleteReason: string | null;
}

export async function openAIResponseOutput(
  response: Response,
): Promise<OpenAIResponseOutput> {
  const payload = (await response.json()) as {
    status?: string;
    incomplete_details?: { reason?: string };
    output?: Array<{
      content?: Array<{ type?: string; text?: string }>;
    }>;
  };
  const text = payload.output
    ?.flatMap((item) => item.content ?? [])
    .find((item) => item.type === "output_text")?.text;
  return {
    text: text ?? null,
    status: payload.status ?? null,
    incompleteReason: payload.incomplete_details?.reason ?? null,
  };
}

/**
 * POST `/v1/responses` with the configured service tier, retrying once
 * without it when the account does not have access to that tier.
 */
export async function fetchOpenAIResponse(
  requestBody: Record<string, unknown>,
  timeoutMs: number,
): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  const send = (body: Record<string, unknown>) => {
    const remaining = Math.floor(deadline - Date.now());
    if (remaining <= 0)
      throw new DOMException("OpenAI response deadline expired", "TimeoutError");
    return fetch(`${serverConfig.openaiBaseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serverConfig.openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      // The optional service-tier fallback shares the same total budget.
      signal: durableAbortSignal(AbortSignal.timeout(remaining)),
    });
  };

  const response = await send(requestBody);
  if (
    !response.ok &&
    requestBody.service_tier &&
    (response.status === 400 || response.status === 403)
  ) {
    const errorBody = await response.text();
    if (/service.?tier|fast|priority/i.test(errorBody)) {
      const fallbackBody = { ...requestBody };
      delete fallbackBody.service_tier;
      console.warn(
        "OpenAI Fast mode unavailable; retrying with standard processing",
      );
      return send(fallbackBody);
    }
    return new Response(errorBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  return response;
}
