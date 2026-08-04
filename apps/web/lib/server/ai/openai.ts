import "server-only";

import type {
  ImageEditingProvider,
  ImageEditingRequest,
  ImageGenerationProvider,
  ImageGenerationRequest,
  ProviderAttemptResult,
} from "@lili/ai-router";

import { serverConfig } from "../config";

export class OpenAIImageProvider
  implements ImageEditingProvider, ImageGenerationProvider
{
  readonly name = "openai";

  constructor(readonly model = serverConfig.openaiModel) {}

  isAvailable(): boolean {
    return Boolean(
      serverConfig.openAIImageEnabled &&
      serverConfig.openaiApiKey &&
      !serverConfig.aiMockMode,
    );
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
    const startedAt = Date.now();
    const body = new FormData();
    body.append("model", this.model);
    const references = request.references ?? [];
    const editable =
      references.find((reference) => reference.role === "composition") ??
      references.find((reference) => reference.role === "room_original");
    const productReferences = references.filter((reference) =>
      reference.role.startsWith("product_"),
    );
    const mask =
      "targetMask" in request && request.targetMask
        ? request.targetMask
        : references.find((reference) => reference.role === "target_mask");
    const base = editable ?? {
      data: request.composition,
      mimeType: "image/webp" as const,
      role: "composition" as const,
    };
    body.append(
      "image[]",
      new Blob([toArrayBuffer(base.data)], { type: base.mimeType }),
      `composition.${extension(base.mimeType)}`,
    );
    const identities =
      productReferences.length > 0
        ? productReferences
        : [
            {
              data: request.productCutout,
              mimeType: "image/webp" as const,
              role: "product_front" as const,
            },
          ];
    for (const [index, reference] of identities.entries()) {
      body.append(
        "image[]",
        new Blob([toArrayBuffer(reference.data)], {
          type: reference.mimeType,
        }),
        `product-${index + 1}.${extension(reference.mimeType)}`,
      );
    }
    if (mask) {
      body.append(
        "mask",
        new Blob([toArrayBuffer(mask.data)], { type: mask.mimeType }),
        "mask.png",
      );
    }
    body.append("prompt", request.prompt);
    body.append("quality", request.quality);
    body.append("size", request.size);
    body.append("background", "opaque");
    body.append("output_format", "webp");
    body.append("output_compression", "90");

    let response: Response;
    try {
      response = await fetch(`${serverConfig.openaiBaseUrl}/images/edits`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serverConfig.openaiApiKey}`,
          "Idempotency-Key": request.idempotencyKey,
        },
        body,
        signal: AbortSignal.timeout(180_000),
      });
    } catch (reason) {
      const timeout =
        reason instanceof Error &&
        (reason.name === "TimeoutError" || reason.name === "AbortError");
      return failure(
        this.model,
        crypto.randomUUID(),
        Date.now() - startedAt,
        timeout ? "timeout" : "network_error",
        timeout
          ? "OpenAI a dépassé le temps de traitement autorisé."
          : "Impossible de joindre le service d’image OpenAI.",
        true,
      );
    }
    const requestId =
      response.headers.get("x-request-id") ?? crypto.randomUUID();
    const payload = (await response.json().catch(() => ({}))) as {
      data?: Array<{ b64_json?: string }>;
      error?: {
        code?: string;
        type?: string;
        message?: string;
        moderation_details?: {
          moderation_stage?: string;
          categories?: string[];
        };
      };
    };
    if (!response.ok) {
      const blocked = payload.error?.code === "moderation_blocked";
      return {
        ...failure(
          this.model,
          requestId,
          Date.now() - startedAt,
          payload.error?.code ?? `http_${response.status}`,
          blocked
            ? "La demande ne respecte pas les exigences de sécurité."
            : (payload.error?.message?.slice(0, 300) ??
                `Erreur OpenAI ${response.status}.`),
          response.status === 408 ||
            response.status === 429 ||
            response.status >= 500,
        ),
        safety: {
          blocked,
          reason: payload.error?.moderation_details?.moderation_stage,
          categories: payload.error?.moderation_details?.categories,
        },
      };
    }
    const encoded = payload.data?.[0]?.b64_json;
    if (!encoded) {
      return failure(
        this.model,
        requestId,
        Date.now() - startedAt,
        "empty_image_response",
        "OpenAI n’a retourné aucune image.",
        false,
      );
    }
    return {
      provider: "openai",
      model: this.model,
      requestId,
      status: "succeeded",
      durationMs: Date.now() - startedAt,
      estimatedCostUsd: estimateOpenAICost(request.quality, request.size),
      images: [
        {
          data: new Uint8Array(Buffer.from(encoded, "base64")),
          mimeType: "image/webp",
        },
      ],
      safety: { blocked: false },
      attemptCount: 1,
    };
  }
}

function failure(
  model: string,
  requestId: string,
  durationMs: number,
  code: string,
  message: string,
  retryable: boolean,
): ProviderAttemptResult {
  return {
    provider: "openai",
    model,
    requestId,
    status: "failed",
    durationMs,
    estimatedCostUsd: 0,
    images: [],
    error: { code, message, retryable },
    safety: { blocked: false },
    attemptCount: 1,
  };
}

function estimateOpenAICost(
  quality: ImageGenerationRequest["quality"],
  size: ImageGenerationRequest["size"],
): number {
  const square = size === "1024x1024";
  if (quality === "low") return square ? 0.006 : 0.005;
  if (quality === "medium") return square ? 0.053 : 0.041;
  return square ? 0.211 : 0.165;
}

function extension(mimeType: string): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  return "webp";
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
