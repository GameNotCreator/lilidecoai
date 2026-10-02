import "server-only";

import type {
  ImageEditingProvider,
  ImageEditingRequest,
  ImageGenerationProvider,
  ImageGenerationRequest,
  ProviderAttemptResult,
} from "@lili/ai-router";

import { serverConfig } from "../config";
import { durableAbortSignal } from "../durable-context";
import {
  imageCostAllowance,
  imageQualityForModel,
  imageUsageCost,
} from "./openai-image-settings";

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
    const timeoutMs = Math.min(
      180_000,
      (request.deadlineMs ?? startedAt + 225_000) - startedAt - 45_000,
    );
    if (timeoutMs < 10_000)
      return failure(
        this.model,
        crypto.randomUUID(),
        0,
        "render_deadline",
        "Le délai restant ne permet plus une génération suivie de son contrôle qualité.",
        false,
      );
    const body = new FormData();
    body.append("model", this.model);
    const references = request.references ?? [];
    const productIsolation =
      "productIsolation" in request && request.productIsolation === true;
    const productReferences = references.filter((reference) =>
      reference.role.startsWith("product_"),
    );
    if (productIsolation) {
      if (productReferences.length === 0)
        return failure(
          this.model,
          crypto.randomUUID(),
          Date.now() - startedAt,
          "invalid_input",
          "Une photographie catalogue est requise pour isoler le produit.",
          false,
        );
      const orderedReferences = [
        ...productReferences,
        ...references.filter((reference) => reference.role === "room_original"),
        ...references.filter((reference) => reference.role === "spatial_guide"),
      ];
      for (const [index, reference] of orderedReferences.entries()) {
        const name =
          reference.role === "room_original"
            ? "room-original"
            : reference.role === "spatial_guide"
              ? "spatial-guide"
              : `product-${index + 1}`;
        body.append(
          "image[]",
          new Blob([toArrayBuffer(reference.data)], {
            type: reference.mimeType,
          }),
          `${name}.${extension(reference.mimeType)}`,
        );
      }
    } else {
      const editable =
        references.find((reference) => reference.role === "composition") ??
        references.find((reference) => reference.role === "room_original");
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
      const orderedReferences = [
        identities[0]!,
        ...references.filter((reference) => reference.role === "spatial_guide"),
        ...identities.slice(1),
      ];
      for (const [index, reference] of orderedReferences.entries()) {
        body.append(
          "image[]",
          new Blob([toArrayBuffer(reference.data)], {
            type: reference.mimeType,
          }),
          `${reference.role === "spatial_guide" ? "spatial-guide" : `product-${index + 1}`}.${extension(reference.mimeType)}`,
        );
      }
      if (mask) {
        body.append(
          "mask",
          new Blob([toArrayBuffer(mask.data)], { type: mask.mimeType }),
          "mask.png",
        );
      }
    }
    body.append("prompt", request.prompt);
    body.append("quality", imageQualityForModel(this.model, request.quality));
    body.append("size", request.size);
    body.append("background", productIsolation ? "transparent" : "opaque");
    body.append("output_format", "webp");
    body.append("output_compression", "100");

    let response: Response;
    try {
      response = await fetch(`${serverConfig.openaiBaseUrl}/images/edits`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serverConfig.openaiApiKey}`,
          "Idempotency-Key": request.idempotencyKey,
        },
        body,
        signal: durableAbortSignal(AbortSignal.timeout(timeoutMs)),
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
        // A dropped connection cannot prove the provider did not run the job.
        estimateOpenAICost(request.quality, request.size, this.model),
      );
    }
    const requestId =
      response.headers.get("x-request-id") ?? crypto.randomUUID();
    const payload = (await response.json().catch(() => ({}))) as {
      data?: Array<{ b64_json?: string }>;
      usage?: Record<string, unknown>;
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
          response.status >= 500 || response.status === 408
            ? estimateOpenAICost(request.quality, request.size, this.model)
            : 0,
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
        // HTTP 200: the model ran, and the call is billed.
        estimateOpenAICost(request.quality, request.size, this.model),
      );
    }
    return {
      provider: "openai",
      model: this.model,
      requestId,
      status: "succeeded",
      durationMs: Date.now() - startedAt,
      estimatedCostUsd:
        imageUsageCost(this.model, payload.usage) ??
        estimateOpenAICost(request.quality, request.size, this.model),
      usage: payload.usage,
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

/**
 * A13 of the audit: every failure used to be reported as costing nothing.
 * A request that reached the model and then timed out was very likely run and
 * billed, and recording it as free both understated the cost per accepted
 * render and let a job that kept timing out run for ever under its budget.
 *
 * `estimatedCostUsd` is a conservative allowance when the call's outcome is
 * unknown. A network error cannot prove generation never started.
 */
function failure(
  model: string,
  requestId: string,
  durationMs: number,
  code: string,
  message: string,
  retryable: boolean,
  estimatedCostUsd = 0,
): ProviderAttemptResult {
  return {
    provider: "openai",
    model,
    requestId,
    status: "failed",
    durationMs,
    estimatedCostUsd,
    images: [],
    error: { code, message, retryable },
    safety: { blocked: false },
    attemptCount: 1,
  };
}

/**
 * Planning allowance for an edit. Actual returned token usage supersedes it.
 * GPT Image 2.5 consumption cannot be inferred from the GPT Image 2 rate card.
 */
export function estimateOpenAICost(
  quality: ImageGenerationRequest["quality"],
  size: ImageGenerationRequest["size"],
  model = serverConfig.openaiModel,
): number {
  return imageCostAllowance(model, quality, size);
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
