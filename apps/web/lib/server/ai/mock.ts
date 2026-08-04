import "server-only";

import type {
  ImageEditingProvider,
  ImageEditingRequest,
  ImageGenerationProvider,
  ImageGenerationRequest,
  ProviderAttemptResult,
  SceneAnalysisProvider,
  SceneAnalysisRequest,
  SceneAnalysisResult,
  SegmentationProvider,
  SegmentationRequest,
  SegmentationResult,
} from "@lili/ai-router";
import sharp from "sharp";

export class MockImageProvider
  implements ImageEditingProvider, ImageGenerationProvider
{
  readonly name = "mock";
  readonly model = "deterministic-compositor-v2";

  isAvailable(): boolean {
    return true;
  }

  async generate(
    request: ImageGenerationRequest,
  ): Promise<ProviderAttemptResult> {
    return this.result(request);
  }

  async edit(request: ImageEditingRequest): Promise<ProviderAttemptResult> {
    return this.result(request);
  }

  private async result(
    request: ImageGenerationRequest,
  ): Promise<ProviderAttemptResult> {
    return {
      provider: "mock",
      model: this.model,
      requestId: `mock-${request.idempotencyKey}`,
      status: "succeeded",
      durationMs: 1,
      estimatedCostUsd: 0,
      images: [
        {
          data: request.composition,
          mimeType: "image/webp",
        },
      ],
      safety: { blocked: false },
      attemptCount: 1,
    };
  }
}

export class MockSceneAnalysisProvider implements SceneAnalysisProvider {
  readonly name = "mock";
  readonly model = "deterministic-scene-analysis-v2";

  isAvailable(): boolean {
    return true;
  }

  async analyze(request: SceneAnalysisRequest): Promise<SceneAnalysisResult> {
    return {
      roomType: "interior",
      clarityScore: 0.92,
      depth: "medium",
      horizonY: 0.44,
      vanishingPoints: [{ x: 0.5, y: 0.44 }],
      surfaces: [
        {
          type: request.surfaceType,
          confidence: 0.82,
          polygon: [
            { x: 0.08, y: 0.5 },
            { x: 0.92, y: 0.5 },
            { x: 0.92, y: 0.96 },
            { x: 0.08, y: 0.96 },
          ],
        },
      ],
      lighting: {
        direction: "front-left",
        intensity: 0.62,
        colorTemperature: "neutral",
        softness: 0.75,
        timeOfDay: "day",
      },
      obstacles: [],
      scale: { status: "estimated", confidence: 0.55 },
      providerResult: {
        provider: "mock",
        model: this.model,
        requestId: "mock-scene-analysis",
        status: "succeeded",
        durationMs: 1,
        estimatedCostUsd: 0,
        images: [],
        safety: { blocked: false },
        attemptCount: 1,
      },
    };
  }
}

export class LocalPointSegmentationProvider implements SegmentationProvider {
  readonly name = "local-point-mask";

  isAvailable(): boolean {
    return true;
  }

  async segment(request: SegmentationRequest): Promise<SegmentationResult> {
    const source = Buffer.from(request.room.data);
    const metadata = await sharp(source).metadata();
    const width = metadata.width ?? 1024;
    const height = metadata.height ?? 1024;
    const box = {
      xMin: Math.max(0, request.point.x - 0.12),
      yMin: Math.max(0, request.point.y - 0.14),
      xMax: Math.min(1, request.point.x + 0.12),
      yMax: Math.min(1, request.point.y + 0.14),
    };
    const pixels = Buffer.alloc(width * height * 4, 0);
    const minX = Math.floor(box.xMin * width);
    const maxX = Math.ceil(box.xMax * width);
    const minY = Math.floor(box.yMin * height);
    const maxY = Math.ceil(box.yMax * height);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const rx = Math.max(1, (maxX - minX) / 2);
    const ry = Math.max(1, (maxY - minY) / 2);
    for (let y = minY; y < maxY; y += 1) {
      for (let x = minX; x < maxX; x += 1) {
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 > 1) continue;
        const offset = (y * width + x) * 4;
        pixels[offset] = 255;
        pixels[offset + 1] = 46;
        pixels[offset + 2] = 46;
        pixels[offset + 3] = 150;
      }
    }
    const mask = await sharp(pixels, {
      raw: { width, height, channels: 4 },
    })
      .png()
      .toBuffer();
    return {
      mask: { data: new Uint8Array(mask), mimeType: "image/png" },
      confidence: 0.5,
      label: "élément sélectionné",
      box,
      providerResult: {
        provider: "mock",
        model: this.name,
        requestId: "mock-segmentation",
        status: "succeeded",
        durationMs: 1,
        estimatedCostUsd: 0,
        images: [],
        safety: { blocked: false },
        attemptCount: 1,
      },
    };
  }
}
