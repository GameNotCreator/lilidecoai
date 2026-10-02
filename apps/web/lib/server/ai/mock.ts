import "server-only";

import type {
  ImageEditingProvider,
  ImageEditingRequest,
  ImageGenerationProvider,
  ImageGenerationRequest,
  PlacementIntentProvider,
  PlacementIntentRequest,
  PlacementIntentResult,
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
    request: ImageGenerationRequest | ImageEditingRequest,
  ): Promise<ProviderAttemptResult> {
    let data = request.composition;
    if ("productIsolation" in request && request.productIsolation === true) {
      try {
        data = new Uint8Array(await mockIsolatedProducts(request));
      } catch {
        return {
          provider: "mock",
          model: this.model,
          requestId: `mock-${request.idempotencyKey}`,
          status: "failed",
          durationMs: 1,
          estimatedCostUsd: 0,
          images: [],
          error: {
            code: "invalid_input",
            message:
              "La simulation d’isolation nécessite une à trois photographies catalogue lisibles.",
            retryable: false,
          },
          safety: { blocked: false },
          attemptCount: 1,
        };
      }
    }
    return {
      provider: "mock",
      model: this.model,
      requestId: `mock-${request.idempotencyKey}`,
      status: "succeeded",
      durationMs: 1,
      estimatedCostUsd: 0,
      images: [
        {
          data,
          mimeType: "image/webp",
        },
      ],
      safety: { blocked: false },
      attemptCount: 1,
    };
  }
}

/** Mock-only catalogue contact sheet; no generated pose or AI matting is claimed. */
async function mockIsolatedProducts(
  request: ImageGenerationRequest,
): Promise<Buffer> {
  const products = (request.references ?? []).filter((reference) =>
    reference.role.startsWith("product_"),
  );
  if (products.length < 1 || products.length > 3)
    throw new Error("Invalid mock product count");
  const sizes = {
    "1024x1024": [1024, 1024],
    "1536x1024": [1536, 1024],
    "1024x1536": [1024, 1536],
  } as const;
  const [width, height] = sizes[request.size];
  const overlays = await Promise.all(
    products.map(async (reference, index) => {
      const start = Math.round(index * width / products.length);
      const end = Math.round((index + 1) * width / products.length);
      const columnWidth = end - start;
      const marginX = Math.ceil(columnWidth * 0.1);
      const marginY = Math.ceil(height * 0.1);
      // The whole original photograph is an opaque connected mock tile,
      // rather than a claim that its real product silhouette was inferred.
      const tile = await sharp(Buffer.from(reference.data))
        .rotate()
        .removeAlpha()
        .toColourspace("srgb")
        .resize({
          width: columnWidth - marginX * 2,
          height: height - marginY * 2,
          fit: "inside",
        })
        .png()
        .toBuffer({ resolveWithObject: true });
      return {
        input: tile.data,
        left: start + Math.floor((columnWidth - tile.info.width) / 2),
        top: Math.floor((height - tile.info.height) / 2),
      };
    }),
  );
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(overlays)
    .webp({ lossless: true })
    .toBuffer();
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

export class MockPlacementIntentProvider implements PlacementIntentProvider {
  readonly name = "mock-placement-intent";
  readonly model = "deterministic-intent-v1";

  isAvailable(): boolean {
    return true;
  }

  async resolve(
    request: PlacementIntentRequest,
  ): Promise<PlacementIntentResult> {
    const replace =
      /(remplac\w*|replace|swap|à la place|a la place|instead of|retire\w*|enlève\w*|enleve\w*)/i.test(
        request.instruction,
      );
    return {
      mode: replace ? "replace" : "insert",
      surfaceType: replace ? "existing_object" : request.productSurfaceType,
      placementPoint: { x: 0.5, y: 0.7 },
      ...(replace ? { targetPoint: { x: 0.5, y: 0.58 } } : {}),
      ...(replace ? { targetLabel: "objet demandé" } : {}),
      confidence: 0.92,
      needsClarification: false,
      rationale: replace
        ? "L’élément cité a été identifié automatiquement."
        : "Le meilleur emplacement compatible sera utilisé.",
      providerResult: {
        provider: "mock",
        model: this.model,
        requestId: "mock-placement-intent",
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
