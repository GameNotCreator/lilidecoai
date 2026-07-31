export type ImageQuality = "low" | "medium" | "high";
export type ImageSize = "1024x1024" | "1536x1024" | "1024x1536";

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
}

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

export interface ImageGenerationProvider {
  readonly name: string;
  readonly model: string;
  isAvailable(): boolean;
  generate(request: ImageGenerationRequest): Promise<ImageGenerationResult>;
}

export function selectProvider(
  production: ImageGenerationProvider,
  mock: ImageGenerationProvider,
): ImageGenerationProvider {
  return production.isAvailable() ? production : mock;
}
