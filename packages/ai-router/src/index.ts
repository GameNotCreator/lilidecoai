export type ImageQuality = "low" | "medium" | "high";
export type ImageSize = "1024x1024" | "1536x1024" | "1024x1536";
export type RenderMode = "insert" | "replace";
export type OutputQuality = "preview" | "final";
export type SurfaceType =
  | "tabletop"
  | "shelf"
  | "niche"
  | "wall"
  | "floor"
  | "rug_zone"
  | "ceiling"
  | "existing_object";

export type ProductViewType =
  "front" | "three_quarter" | "side" | "back" | "detail";

export type PipelineState =
  | "uploaded"
  | "analyzing_scene"
  | "segmenting_target"
  | "awaiting_mask_confirmation"
  | "computing_geometry"
  | "removing_target"
  | "building_prompt"
  | "generating_preview"
  | "generating_final"
  | "quality_check"
  | "retrying"
  | "completed"
  | "failed"
  | "refunded";

export interface NormalizedPoint {
  x: number;
  y: number;
}

export interface ImageReference {
  data: Uint8Array;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  role:
    | "room_original"
    | "product_front"
    | "product_three_quarter"
    | "product_side"
    | "product_back"
    | "product_detail"
    | "composition"
    | "target_mask"
    | "intermediate";
}

export interface ProviderImage {
  data: Uint8Array;
  mimeType: string;
  width?: number;
  height?: number;
}

export interface NormalizedProviderError {
  code: string;
  message: string;
  retryable: boolean;
  httpStatus?: number;
}

export interface SafetyMetadata {
  blocked: boolean;
  reason?: string;
  categories?: string[];
  raw?: Record<string, unknown>;
}

export interface ProviderAttemptResult {
  provider: "google" | "openai" | "mock" | string;
  model: string;
  requestId: string;
  status: "succeeded" | "failed";
  durationMs: number;
  estimatedCostUsd: number;
  images: ProviderImage[];
  error?: NormalizedProviderError;
  safety: SafetyMetadata;
  attemptCount: number;
  usage?: Record<string, unknown>;
  degradedMode?: boolean;
}

export interface ImageGenerationRequest {
  scene: Uint8Array;
  productCutout: Uint8Array;
  composition: Uint8Array;
  protectionMask: Uint8Array;
  prompt: string;
  quality: ImageQuality;
  size: ImageSize;
  lighting: {
    direction: string;
    temperature: "warm" | "neutral" | "cool";
    hardness: "soft" | "balanced" | "hard";
  };
  placement: Record<string, number | string>;
  idempotencyKey: string;
  references?: ImageReference[];
  mode?: RenderMode;
  outputQuality?: OutputQuality;
}

export interface ImageEditingRequest extends ImageGenerationRequest {
  mode: RenderMode;
  targetMask?: ImageReference;
  preserveBackground: boolean;
}

/** @deprecated Prefer ProviderAttemptResult for all new provider code. */
export interface ImageGenerationResult {
  provider: string;
  model: string;
  status: "succeeded" | "failed";
  output?: Uint8Array;
  durationMs: number;
  estimatedCostUsd: number;
  usage?: Record<string, unknown>;
  error?: string;
}

export interface SceneAnalysisRequest {
  room: ImageReference;
  placementPoint: NormalizedPoint;
  surfaceType: SurfaceType;
  productDimensionsCm: {
    width: number;
    height: number;
    depth: number;
  };
  calibration?: Record<string, unknown>;
}

export interface SceneAnalysisResult {
  roomType: string;
  clarityScore: number;
  depth: "close" | "medium" | "far";
  horizonY: number;
  vanishingPoints: NormalizedPoint[];
  surfaces: Array<{
    type: SurfaceType;
    confidence: number;
    polygon: NormalizedPoint[];
  }>;
  lighting: {
    direction: string;
    intensity: number;
    colorTemperature: "warm" | "neutral" | "cool";
    softness: number;
    timeOfDay: string;
  };
  obstacles: Array<{
    label: string;
    confidence: number;
    box: { xMin: number; yMin: number; xMax: number; yMax: number };
  }>;
  scale: {
    status: "calibrated" | "estimated";
    pixelsPerCentimeter?: number;
    confidence: number;
  };
  providerResult: ProviderAttemptResult;
}

export interface SegmentationRequest {
  room: ImageReference;
  point: NormalizedPoint;
  positivePoints?: NormalizedPoint[];
  negativePoints?: NormalizedPoint[];
}

export interface SegmentationResult {
  mask: ProviderImage;
  confidence: number;
  label: string;
  box: { xMin: number; yMin: number; xMax: number; yMax: number };
  providerResult: ProviderAttemptResult;
}

export interface ImageGenerationProvider {
  readonly name: string;
  readonly model: string;
  isAvailable(): boolean;
  generate(request: ImageGenerationRequest): Promise<ProviderAttemptResult>;
}

export interface ImageEditingProvider {
  readonly name: string;
  readonly model: string;
  isAvailable(): boolean;
  edit(request: ImageEditingRequest): Promise<ProviderAttemptResult>;
}

export interface SegmentationProvider {
  readonly name: string;
  isAvailable(): boolean;
  segment(request: SegmentationRequest): Promise<SegmentationResult>;
}

export interface SceneAnalysisProvider {
  readonly name: string;
  readonly model: string;
  isAvailable(): boolean;
  analyze(request: SceneAnalysisRequest): Promise<SceneAnalysisResult>;
}

export interface ProviderRoutingConfig {
  mockMode: boolean;
  googleAvailable: boolean;
  openAIAvailable: boolean;
  openAIEnabled: boolean;
}

export interface ProviderRoute {
  provider: "google" | "openai" | "mock";
  modelRole: "preview" | "final" | "fallback" | "mock";
  degradedMode: boolean;
  reason: string;
}

export function routeImageProvider(
  request: { mode: RenderMode; outputQuality: OutputQuality },
  config: ProviderRoutingConfig,
): ProviderRoute {
  if (config.mockMode) {
    return {
      provider: "mock",
      modelRole: "mock",
      degradedMode: false,
      reason: "AI_MOCK_MODE is enabled",
    };
  }
  if (config.googleAvailable) {
    return {
      provider: "google",
      modelRole: request.outputQuality === "preview" ? "preview" : "final",
      degradedMode: false,
      reason:
        request.outputQuality === "preview"
          ? "Google Flash is the configured preview provider"
          : request.mode === "replace"
            ? "Google Pro handles confirmed replacement masks"
            : "Google Pro is the configured premium provider",
    };
  }
  if (config.openAIEnabled && config.openAIAvailable) {
    return {
      provider: "openai",
      modelRole: "fallback",
      degradedMode: true,
      reason: "Google is unavailable; explicit OpenAI fallback is enabled",
    };
  }
  return {
    provider: "mock",
    modelRole: "mock",
    degradedMode: true,
    reason: "No paid provider is available",
  };
}

export function normalizePoint(point: NormalizedPoint): NormalizedPoint {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error("Coordinates must be finite numbers");
  }
  return {
    x: Math.max(0, Math.min(1, point.x)),
    y: Math.max(0, Math.min(1, point.y)),
  };
}

const allowedTransitions: Record<PipelineState, PipelineState[]> = {
  uploaded: ["analyzing_scene", "failed"],
  analyzing_scene: [
    "segmenting_target",
    "removing_target",
    "computing_geometry",
    "failed",
  ],
  segmenting_target: ["awaiting_mask_confirmation", "failed"],
  awaiting_mask_confirmation: ["computing_geometry", "failed", "refunded"],
  computing_geometry: ["removing_target", "building_prompt", "failed"],
  removing_target: ["building_prompt", "failed"],
  building_prompt: ["generating_preview", "generating_final", "failed"],
  generating_preview: ["quality_check", "failed"],
  generating_final: ["quality_check", "failed"],
  quality_check: ["retrying", "completed", "failed"],
  retrying: [
    "building_prompt",
    "generating_preview",
    "generating_final",
    "failed",
  ],
  completed: [],
  failed: ["refunded", "retrying"],
  refunded: [],
};

export function canTransitionPipeline(
  current: PipelineState,
  next: PipelineState,
): boolean {
  return current === next || allowedTransitions[current].includes(next);
}

export function shouldRetryAttempt(
  result: ProviderAttemptResult,
  maximumAttempts = 2,
): boolean {
  return (
    result.status === "failed" &&
    Boolean(result.error?.retryable) &&
    result.attemptCount < maximumAttempts
  );
}

export function selectProvider(
  production: ImageGenerationProvider,
  mock: ImageGenerationProvider,
): ImageGenerationProvider {
  return production.isAvailable() ? production : mock;
}

export * from "./prompt-builder";
