import type { SimplePlacementKind } from "@lili/geometry";
import type { OutputQuality, RenderMode } from "@lili/ai-router";
import type { RenderDocument } from "./types";
import { simplePlacementSchema } from "@lili/types";
import { retryKeyMatchesSource } from "../spatial-retry";

export interface PlacementInput {
  [key: string]: unknown;
  sceneId: string;
  productId: string;
  calibrationId?: string;
  mode?: string;
  surfaceType?: string;
  xNormalized?: number;
  yNormalized?: number;
  scale?: number;
  rotationDegrees?: number;
  lighting?: {
    direction?: string;
    temperature?: string;
    hardness?: string;
  };
  targetPoint?: { x: number; y: number };
  targetMaskAssetId?: string;
}

export interface RenderInput {
  engine?: "legacy" | "spatial" | "oriented";
  orientedVariantId?: string | null;
  orientedYawDegrees?: number;
  orientedPlanFingerprint?: string;
  spatialReference?: import("@lili/types").SpatialReference;
  scaleReference?: import("@lili/types").StorefrontScaleReference;
  replaceExisting?: boolean;
  replacementRegion?: import("@lili/types").StorefrontReplacementRegion;
  workflow?: "standard" | "simple_point";
  placement: PlacementInput;
  idempotencyKey: string;
  quality?: string;
  mode?: RenderMode;
  placementPoint?: { x: number; y: number };
  targetPoint?: { x: number; y: number };
  targetMaskId?: string;
  targetMaskAssetId?: string;
  surfaceType?: string;
  dimensionsCm?: { width: number; height: number; depth: number; unit: "cm" };
  anchorType?: string;
  material?: string;
  lighting?: Record<string, unknown>;
  calibration?: Record<string, unknown>;
  outputQuality?: OutputQuality;
  preserveBackground?: boolean;
  userInstructions?: string;
  dimensionReference?: {
    axis: "width" | "height";
    valueCm: number;
  };
  simplePlacements?: Array<{
    productId: string;
    placementPoint: { x: number; y: number };
    dimensionPair?: SimpleDimensionPair;
    dimensionReference?: {
      axis: "width" | "height";
      valueCm: number;
    };
    placementKind?: SimplePlacementKind;
    pixelsPerCm?: number;
    visualWidthNormalized?: number;
    manualPlacement?: import("@lili/types").ManualPlacement;
  }>;
}

export type SimpleDimensionPair =
  | { mode: "height_length"; heightCm: number; lengthCm: number }
  | { mode: "length_width"; lengthCm: number; widthCm: number };

export interface RenderRequestSnapshot {
  version: 1;
  input: RenderInput;
}

export function snapshotRenderInput(input: RenderInput): RenderRequestSnapshot {
  // Materialize a detached, BSON-safe value before runtime placement mutates.
  return {
    version: 1,
    input: JSON.parse(JSON.stringify(input)) as RenderInput,
  };
}

export class RenderRequestError extends Error {
  readonly status = 409;
}

export function buildRetryInput(
  render: RenderDocument,
  providedKey?: string,
): RenderInput {
  if (
    providedKey !== undefined &&
    !retryKeyMatchesSource(providedKey, render.id)
  )
    throw new RenderRequestError(
      "La clé de reprise ne correspond pas à ce rendu.",
    );
  const idempotencyKey =
    providedKey ?? `retry:${render.id}:${crypto.randomUUID()}`;
  if (render.engine === "oriented") {
    if (render.execution?.errorCode === "provider_unknown" || (render.usageTotals?.unknownOutcomeCalls ?? 0) > 0)
      throw new RenderRequestError("L’issue fournisseur est inconnue. Une vérification de la dépense est nécessaire avant une nouvelle génération.");
    if (render.requestSnapshot?.input.engine !== "oriented")
      throw new RenderRequestError("Les paramètres du rendu orienté sont incomplets.");
  }
  if (
    render.engine === "spatial" &&
    render.requestSnapshot?.input.engine !== "spatial"
  )
    throw new RenderRequestError(
      "Les paramètres spatiaux enregistrés sont incomplets. Recréez le placement.",
    );
  if (render.requestSnapshot) {
    if (render.requestSnapshot.version !== 1) {
      throw new RenderRequestError(
        "Cette version de rendu ne peut pas être rejouée. Recréez le placement.",
      );
    }
    return {
      ...snapshotRenderInput(render.requestSnapshot.input).input,
      idempotencyKey,
    };
  }
  // Historical simple renders kept their objects inside placement. Never
  // silently route those renders through the standard single-product engine.
  const objects = render.placement.simplePlacements;
  const simple =
    objects !== undefined || render.promptVersion?.startsWith("simple-");
  if (
    simple &&
    (!Array.isArray(objects) || objects.length < 1 || objects.length > 3)
  ) {
    throw new RenderRequestError(
      "Les paramètres de ce rendu ancien sont incomplets. Recréez le placement.",
    );
  }
  const placement = {
    ...render.placement,
    sceneId: render.sceneId,
    productId: render.productId,
  };
  if (simple && !simplePlacementSchema.array().safeParse(objects).success) {
    throw new RenderRequestError(
      "Les paramètres de ce rendu ancien sont incomplets. Recréez le placement.",
    );
  }
  return snapshotRenderInput({
    workflow: simple ? "simple_point" : "standard",
    placement,
    ...(simple
      ? { simplePlacements: objects as RenderInput["simplePlacements"] }
      : {}),
    mode: render.mode ?? "insert",
    placementPoint: render.placementPoint ?? {
      x: Number(render.placement.xNormalized ?? 0.5),
      y: Number(render.placement.yNormalized ?? 0.7),
    },
    targetPoint: render.targetPoint,
    targetMaskId: render.targetMaskId,
    targetMaskAssetId: render.targetMaskAssetId,
    surfaceType: render.surfaceType,
    dimensionsCm: render.dimensionsCm,
    calibration: render.calibration,
    lighting: render.lighting,
    outputQuality: render.outputQuality ?? "final",
    preserveBackground: render.preserveBackground ?? true,
    userInstructions: render.userInstructions ?? "",
    idempotencyKey,
    quality: "high",
  }).input;
}
