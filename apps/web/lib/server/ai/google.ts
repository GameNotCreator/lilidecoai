import "server-only";

import type {
  ImageEditingProvider,
  ImageEditingRequest,
  ImageGenerationProvider,
  ImageGenerationRequest,
  ImageReference,
  NormalizedProviderError,
  ProviderAttemptResult,
  SceneAnalysisProvider,
  SceneAnalysisRequest,
  SceneAnalysisResult,
  SegmentationProvider,
  SegmentationRequest,
  SegmentationResult,
  SurfaceType,
} from "@lili/ai-router";
import sharp from "sharp";

import { serverConfig } from "../config";

type GooglePart = {
  text?: string;
  inlineData?: { data?: string; mimeType?: string };
  inline_data?: { data?: string; mime_type?: string };
};

interface GoogleResponsePayload {
  candidates?: Array<{
    finishReason?: string;
    safetyRatings?: Array<{
      category?: string;
      probability?: string;
      blocked?: boolean;
    }>;
    content?: { parts?: GooglePart[] };
  }>;
  usageMetadata?: Record<string, unknown>;
  promptFeedback?: {
    blockReason?: string;
    safetyRatings?: Array<Record<string, unknown>>;
  };
  error?: { code?: number; status?: string; message?: string };
}

interface GoogleCallResult {
  payload?: GoogleResponsePayload;
  requestId: string;
  durationMs: number;
  attemptCount: number;
  error?: NormalizedProviderError;
}

export async function inspectImagesWithGoogle(
  prompt: string,
  references: ImageReference[],
  model = serverConfig.googlePreviewImageModel,
): Promise<{
  data: Record<string, unknown>;
  providerResult: ProviderAttemptResult;
}> {
  const result = await callGoogleModel(model, {
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          ...references.map((reference) => imagePart(reference)),
        ],
      },
    ],
    generationConfig: { responseModalities: ["TEXT"] },
  });
  if (!result.payload || result.error) {
    throw new GoogleProviderError(
      result.error?.message ?? "Inspection Google indisponible.",
      result.error?.httpStatus ?? 502,
      result.error?.code ?? "google_inspection_failed",
    );
  }
  const text = result.payload.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? "")
    .join("\n")
    .trim();
  if (!text) {
    throw new GoogleProviderError(
      "Google n’a retourné aucun contrôle.",
      502,
      "empty_inspection",
    );
  }
  return {
    data: parseJsonRecord(text),
    providerResult: {
      provider: "google",
      model,
      requestId: result.requestId,
      status: "succeeded",
      durationMs: result.durationMs,
      estimatedCostUsd: 0.003,
      images: [],
      safety: { blocked: false, raw: safetyMetadata(result.payload) },
      attemptCount: result.attemptCount,
      usage: result.payload.usageMetadata,
    },
  };
}

export class GoogleImageProvider
  implements ImageEditingProvider, ImageGenerationProvider
{
  readonly name = "google";

  constructor(readonly model: string) {}

  isAvailable(): boolean {
    return Boolean(serverConfig.googleApiKey) && !serverConfig.aiMockMode;
  }

  async generate(
    request: ImageGenerationRequest,
  ): Promise<ProviderAttemptResult> {
    return this.run(request);
  }

  async edit(request: ImageEditingRequest): Promise<ProviderAttemptResult> {
    return this.run(request);
  }

  private async run(
    request: ImageGenerationRequest | ImageEditingRequest,
  ): Promise<ProviderAttemptResult> {
    const references = request.references ?? fallbackReferences(request);
    const imageSize = request.outputQuality === "preview" ? "1K" : "2K";
    const parts = [
      { text: request.prompt },
      ...references.map((reference) => imagePart(reference)),
    ];
    const result = await callGoogleModel(this.model, {
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseModalities: ["IMAGE"],
        responseFormat: {
          image: {
            aspectRatio: aspectRatio(request.size),
            imageSize,
          },
        },
      },
    });

    if (!result.payload || result.error) {
      return failedResult(this.model, result);
    }
    const candidate = result.payload.candidates?.[0];
    const images = (candidate?.content?.parts ?? [])
      .map((part) => {
        const inline =
          part.inlineData ??
          (part.inline_data
            ? {
                data: part.inline_data.data,
                mimeType: part.inline_data.mime_type,
              }
            : undefined);
        if (!inline?.data) return null;
        return {
          data: new Uint8Array(Buffer.from(inline.data, "base64")),
          mimeType: inline.mimeType ?? "image/png",
        };
      })
      .filter((image): image is NonNullable<typeof image> => Boolean(image));
    const blocked = Boolean(result.payload.promptFeedback?.blockReason);
    if (images.length === 0) {
      return {
        provider: "google",
        model: this.model,
        requestId: result.requestId,
        status: "failed",
        durationMs: result.durationMs,
        estimatedCostUsd: 0,
        images: [],
        error: {
          code: blocked ? "safety_blocked" : "empty_image_response",
          message: blocked
            ? "La demande a été bloquée par les contrôles de sécurité Google."
            : "Google n’a retourné aucune image.",
          retryable: false,
        },
        safety: {
          blocked,
          reason: result.payload.promptFeedback?.blockReason,
          raw: safetyMetadata(result.payload),
        },
        attemptCount: result.attemptCount,
        usage: result.payload.usageMetadata,
      };
    }
    return {
      provider: "google",
      model: this.model,
      requestId: result.requestId,
      status: "succeeded",
      durationMs: result.durationMs,
      estimatedCostUsd: estimateGoogleCost(
        this.model,
        imageSize,
        references.length,
      ),
      images,
      safety: {
        blocked: false,
        raw: safetyMetadata(result.payload),
      },
      attemptCount: result.attemptCount,
      usage: result.payload.usageMetadata,
    };
  }
}

export class GoogleSceneAnalysisProvider implements SceneAnalysisProvider {
  readonly name = "google";

  constructor(readonly model: string) {}

  isAvailable(): boolean {
    return Boolean(serverConfig.googleApiKey) && !serverConfig.aiMockMode;
  }

  async analyze(request: SceneAnalysisRequest): Promise<SceneAnalysisResult> {
    const prompt = [
      "Analyze this interior photograph for a constrained product placement workflow.",
      `The normalized user point is x=${request.placementPoint.x.toFixed(4)}, y=${request.placementPoint.y.toFixed(4)} and requested surface is ${request.surfaceType}.`,
      `Product dimensions are ${request.productDimensionsCm.width} x ${request.productDimensionsCm.height} x ${request.productDimensionsCm.depth} cm.`,
      `Calibration input: ${JSON.stringify(request.calibration ?? { status: "estimated" })}.`,
      "Return JSON only, with no markdown. Use normalized coordinates from 0 to 1.",
      "Required shape: {roomType:string, clarityScore:number, depth:'close'|'medium'|'far', horizonY:number, vanishingPoints:[{x,y}], surfaces:[{type,confidence,polygon:[{x,y}]}], lighting:{direction,intensity,colorTemperature:'warm'|'neutral'|'cool',softness,timeOfDay}, obstacles:[{label,confidence,box:{xMin,yMin,xMax,yMax}}], scale:{status:'calibrated'|'estimated',pixelsPerCentimeter?:number,confidence:number}}.",
      "Detect the room type, depth, principal support planes, vanishing lines, light direction and temperature, obstacles at/near the point, occlusions and scale evidence. Be conservative when the image is unclear.",
    ].join("\n");
    const result = await callGoogleModel(this.model, {
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }, imagePart(request.room)],
        },
      ],
      generationConfig: { responseModalities: ["TEXT"] },
    });
    if (!result.payload || result.error) {
      throw new GoogleProviderError(
        result.error?.message ?? "Analyse Google indisponible.",
        result.error?.httpStatus ?? 502,
        result.error?.code ?? "google_analysis_failed",
      );
    }
    const text = result.payload.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("\n")
      .trim();
    if (!text) {
      throw new GoogleProviderError(
        "Google n’a retourné aucune analyse de scène.",
        502,
        "empty_analysis",
      );
    }
    const parsed = parseJsonRecord(text);
    const calibration = request.calibration ?? {};
    const calibrated =
      calibration.estimated === false ||
      typeof calibration.pixelsPerCentimeter === "number";
    return {
      roomType: textValue(parsed.roomType, "interior"),
      clarityScore: unitValue(parsed.clarityScore, 0.72),
      depth: enumValue(parsed.depth, ["close", "medium", "far"], "medium"),
      horizonY: unitValue(parsed.horizonY, 0.44),
      vanishingPoints: normalizedPoints(parsed.vanishingPoints),
      surfaces: normalizeSurfaces(parsed.surfaces, request.surfaceType),
      lighting: normalizeLighting(parsed.lighting),
      obstacles: normalizeObstacles(parsed.obstacles),
      scale: {
        status: calibrated ? "calibrated" : "estimated",
        ...(typeof calibration.pixelsPerCentimeter === "number"
          ? { pixelsPerCentimeter: calibration.pixelsPerCentimeter }
          : {}),
        confidence: calibrated
          ? 1
          : unitValue(asRecord(parsed.scale).confidence, 0.55),
      },
      providerResult: {
        provider: "google",
        model: this.model,
        requestId: result.requestId,
        status: "succeeded",
        durationMs: result.durationMs,
        estimatedCostUsd: 0.002,
        images: [],
        safety: {
          blocked: false,
          raw: safetyMetadata(result.payload),
        },
        attemptCount: result.attemptCount,
        usage: result.payload.usageMetadata,
      },
    };
  }
}

export class GooglePointSegmentationProvider implements SegmentationProvider {
  readonly name = "google-point-mask";

  constructor(private readonly model: string) {}

  isAvailable(): boolean {
    return Boolean(serverConfig.googleApiKey) && !serverConfig.aiMockMode;
  }

  async segment(request: SegmentationRequest): Promise<SegmentationResult> {
    const prompt = [
      "Point-prompt object segmentation for an interior photograph.",
      `The positive target point is x=${request.point.x.toFixed(4)}, y=${request.point.y.toFixed(4)}.`,
      "Identify the single physical object containing that point. Do not select the wall, floor, shelf, table or room architecture unless the point does not lie on an object.",
      "Include the complete target silhouette, feet, handles, appendages and cables, but exclude the support and neighboring items.",
      "Return JSON only: {label:string, confidence:number, xMin:number, yMin:number, xMax:number, yMax:number}. Coordinates must be normalized 0..1.",
    ].join("\n");
    const result = await callGoogleModel(this.model, {
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }, imagePart(request.room)],
        },
      ],
      generationConfig: { responseModalities: ["TEXT"] },
    });
    if (!result.payload || result.error) {
      throw new GoogleProviderError(
        result.error?.message ?? "Segmentation Google indisponible.",
        result.error?.httpStatus ?? 502,
        result.error?.code ?? "google_segmentation_failed",
      );
    }
    const text = result.payload.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("\n")
      .trim();
    const parsed = parseJsonRecord(text ?? "");
    const box = normalizeBox({
      xMin: numberValue(parsed.xMin, request.point.x - 0.12),
      yMin: numberValue(parsed.yMin, request.point.y - 0.14),
      xMax: numberValue(parsed.xMax, request.point.x + 0.12),
      yMax: numberValue(parsed.yMax, request.point.y + 0.14),
    });
    const mask = await createOverlayMask(request.room.data, box);
    return {
      mask: { data: new Uint8Array(mask), mimeType: "image/png" },
      confidence: unitValue(parsed.confidence, 0.62),
      label: textValue(parsed.label, "élément sélectionné"),
      box,
      providerResult: {
        provider: "google",
        model: this.model,
        requestId: result.requestId,
        status: "succeeded",
        durationMs: result.durationMs,
        estimatedCostUsd: 0.002,
        images: [],
        safety: { blocked: false, raw: safetyMetadata(result.payload) },
        attemptCount: result.attemptCount,
        usage: result.payload.usageMetadata,
      },
    };
  }
}

async function callGoogleModel(
  model: string,
  body: Record<string, unknown>,
): Promise<GoogleCallResult> {
  const startedAt = Date.now();
  const maximumAttempts = 1 + serverConfig.googleMaxRetries;
  let lastError: NormalizedProviderError | undefined;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      const response = await fetch(
        `${serverConfig.googleApiBaseUrl}/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": serverConfig.googleApiKey ?? "",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(serverConfig.googleTimeoutMs),
        },
      );
      const requestId =
        response.headers.get("x-goog-request-id") ??
        response.headers.get("x-request-id") ??
        crypto.randomUUID();
      const payload = (await response
        .json()
        .catch(() => ({}))) as GoogleResponsePayload;
      if (response.ok) {
        return {
          payload,
          requestId,
          durationMs: Date.now() - startedAt,
          attemptCount: attempt,
        };
      }
      lastError = normalizeGoogleError(response.status, payload);
      if (!lastError.retryable || attempt === maximumAttempts) {
        return {
          requestId,
          durationMs: Date.now() - startedAt,
          attemptCount: attempt,
          error: lastError,
        };
      }
    } catch (reason) {
      const timeout = isTimeoutError(reason);
      lastError = {
        code: timeout ? "timeout" : "network_error",
        message: timeout
          ? "Google a dépassé le temps de traitement autorisé."
          : "Impossible de joindre le service d’image Google.",
        retryable: true,
      };
      if (attempt === maximumAttempts) {
        return {
          requestId: crypto.randomUUID(),
          durationMs: Date.now() - startedAt,
          attemptCount: attempt,
          error: lastError,
        };
      }
    }
  }
  return {
    requestId: crypto.randomUUID(),
    durationMs: Date.now() - startedAt,
    attemptCount: maximumAttempts,
    error: lastError ?? {
      code: "unknown",
      message: "Erreur Google inconnue.",
      retryable: false,
    },
  };
}

function fallbackReferences(request: ImageGenerationRequest): ImageReference[] {
  return [
    {
      data: request.scene,
      mimeType: "image/webp",
      role: "room_original",
    },
    {
      data: request.productCutout,
      mimeType: "image/webp",
      role: "product_front",
    },
    {
      data: request.composition,
      mimeType: "image/webp",
      role: "composition",
    },
  ];
}

function imagePart(reference: ImageReference) {
  return {
    inline_data: {
      mime_type: reference.mimeType,
      data: Buffer.from(reference.data).toString("base64"),
    },
  };
}

function failedResult(
  model: string,
  result: GoogleCallResult,
): ProviderAttemptResult {
  return {
    provider: "google",
    model,
    requestId: result.requestId,
    status: "failed",
    durationMs: result.durationMs,
    estimatedCostUsd: 0,
    images: [],
    error: result.error ?? {
      code: "unknown",
      message: "Erreur Google inconnue.",
      retryable: false,
    },
    safety: { blocked: result.error?.code === "safety_blocked" },
    attemptCount: result.attemptCount,
  };
}

function normalizeGoogleError(
  status: number,
  payload: GoogleResponsePayload,
): NormalizedProviderError {
  const code = payload.error?.status?.toLowerCase() ?? `http_${status}`;
  const retryable = status === 408 || status === 429 || status >= 500;
  return {
    code,
    message:
      status === 429
        ? "La limite Google est temporairement atteinte. Réessayez dans un instant."
        : status === 401 || status === 403
          ? "La clé Gemini n’est pas valide ou n’autorise pas ce modèle."
          : (payload.error?.message?.slice(0, 300) ??
            `Erreur Google ${status}.`),
    retryable,
    httpStatus: status,
  };
}

function estimateGoogleCost(
  model: string,
  imageSize: string,
  inputImages: number,
): number {
  if (model.includes("3.1-flash-image")) {
    const output =
      imageSize === "1K" ? 0.067 : imageSize === "2K" ? 0.101 : 0.151;
    return Number((output + inputImages * 0.001).toFixed(4));
  }
  const output = imageSize === "4K" ? 0.24 : 0.134;
  return Number((output + inputImages * 0.0011).toFixed(4));
}

function aspectRatio(size: ImageGenerationRequest["size"]): string {
  if (size === "1536x1024") return "3:2";
  if (size === "1024x1536") return "2:3";
  return "1:1";
}

function safetyMetadata(
  payload: GoogleResponsePayload,
): Record<string, unknown> {
  return {
    promptFeedback: payload.promptFeedback ?? null,
    candidateSafety: payload.candidates?.[0]?.safetyRatings ?? [],
    finishReason: payload.candidates?.[0]?.finishReason ?? null,
  };
}

function parseJsonRecord(value: string): Record<string, unknown> {
  const stripped = value
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new GoogleProviderError(
      "La réponse d’analyse Google est illisible.",
      502,
      "invalid_json",
    );
  }
  try {
    return JSON.parse(stripped.slice(start, end + 1)) as Record<
      string,
      unknown
    >;
  } catch {
    throw new GoogleProviderError(
      "La réponse d’analyse Google est invalide.",
      502,
      "invalid_json",
    );
  }
}

function normalizeSurfaces(value: unknown, fallback: SurfaceType) {
  if (!Array.isArray(value)) {
    return [
      {
        type: fallback,
        confidence: 0.5,
        polygon: [
          { x: 0.1, y: 0.55 },
          { x: 0.9, y: 0.55 },
          { x: 0.9, y: 0.95 },
          { x: 0.1, y: 0.95 },
        ],
      },
    ];
  }
  return value.slice(0, 12).map((item) => {
    const record = asRecord(item);
    return {
      type: normalizeSurface(record.type, fallback),
      confidence: unitValue(record.confidence, 0.5),
      polygon: normalizedPoints(record.polygon),
    };
  });
}

function normalizeLighting(value: unknown): SceneAnalysisResult["lighting"] {
  const record = asRecord(value);
  return {
    direction: textValue(record.direction, "front-left"),
    intensity: unitValue(record.intensity, 0.6),
    colorTemperature: enumValue(
      record.colorTemperature,
      ["warm", "neutral", "cool"],
      "neutral",
    ),
    softness: unitValue(record.softness, 0.7),
    timeOfDay: textValue(record.timeOfDay, "unknown"),
  };
}

function normalizeObstacles(value: unknown): SceneAnalysisResult["obstacles"] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map((item) => {
    const record = asRecord(item);
    return {
      label: textValue(record.label, "object"),
      confidence: unitValue(record.confidence, 0.5),
      box: normalizeBox(asRecord(record.box)),
    };
  });
}

function normalizedPoints(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).map((item) => {
    const record = asRecord(item);
    return { x: unitValue(record.x, 0.5), y: unitValue(record.y, 0.5) };
  });
}

function normalizeBox(value: Record<string, unknown>) {
  const xMin = unitValue(value.xMin, 0.35);
  const yMin = unitValue(value.yMin, 0.35);
  const xMax = unitValue(value.xMax, 0.65);
  const yMax = unitValue(value.yMax, 0.75);
  return {
    xMin: Math.min(xMin, xMax - 0.01),
    yMin: Math.min(yMin, yMax - 0.01),
    xMax: Math.max(xMax, xMin + 0.01),
    yMax: Math.max(yMax, yMin + 0.01),
  };
}

async function createOverlayMask(
  room: Uint8Array,
  box: { xMin: number; yMin: number; xMax: number; yMax: number },
): Promise<Buffer> {
  const metadata = await sharp(Buffer.from(room)).metadata();
  const width = metadata.width ?? 1024;
  const height = metadata.height ?? 1024;
  const pixels = Buffer.alloc(width * height * 4, 0);
  const minX = Math.max(0, Math.floor(box.xMin * width));
  const maxX = Math.min(width, Math.ceil(box.xMax * width));
  const minY = Math.max(0, Math.floor(box.yMin * height));
  const maxY = Math.min(height, Math.ceil(box.yMax * height));
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const radiusX = Math.max(1, (maxX - minX) / 2);
  const radiusY = Math.max(1, (maxY - minY) / 2);
  for (let y = minY; y < maxY; y += 1) {
    for (let x = minX; x < maxX; x += 1) {
      const inside =
        ((x - centerX) * (x - centerX)) / (radiusX * radiusX) +
          ((y - centerY) * (y - centerY)) / (radiusY * radiusY) <=
        1;
      if (!inside) continue;
      const offset = (y * width + x) * 4;
      pixels[offset] = 255;
      pixels[offset + 1] = 46;
      pixels[offset + 2] = 46;
      pixels[offset + 3] = 150;
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function textValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 200)
    : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function unitValue(value: unknown, fallback: number): number {
  return Math.max(0, Math.min(1, numberValue(value, fallback)));
}

function enumValue<T extends string>(
  value: unknown,
  options: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && options.includes(value as T)
    ? (value as T)
    : fallback;
}

function normalizeSurface(value: unknown, fallback: SurfaceType): SurfaceType {
  const valid: SurfaceType[] = [
    "tabletop",
    "shelf",
    "niche",
    "wall",
    "floor",
    "rug_zone",
    "ceiling",
    "existing_object",
  ];
  return enumValue(value, valid, fallback);
}

function isTimeoutError(reason: unknown): boolean {
  return (
    reason instanceof Error &&
    (reason.name === "TimeoutError" || reason.name === "AbortError")
  );
}

export class GoogleProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}
