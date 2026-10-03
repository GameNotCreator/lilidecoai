import "server-only";

import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import sharp from "sharp";
import type {
  ImageEditingProvider,
  ImageEditingRequest,
  ImageGenerationProvider,
  ImageGenerationRequest,
  ImageReference,
  ProviderAttemptResult,
  PreparedViewGenerationRequest,
  OrientedHarmonizationRequest,
  ImageProviderResponseObservation,
  RequestedViewOrientation,
} from "@lili/ai-router";
import {
  buildPreparedViewPrompt,
  buildOrientedHarmonizationPrompt,
  validRequestedViewOrientation,
  PREPARED_VIEW_PROMPT_VERSION,
  ORIENTED_HARMONIZATION_PROMPT_VERSION,
} from "@lili/ai-router";
import { serverConfig } from "../config";
import { durableAbortSignal } from "../durable-context";
import { STOREFRONT_HYBRID_PROMPT_VERSION } from "../storefront-hybrid";

const API_URL = "https://api.myarchitectai.com/v1/edit-by-prompt";
const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 25_000_000;
const REVIEW_RESERVE_MS = 45_000;
export const MYARCHITECTAI_CONFIGURATION_VERSION = "myarchitectai-edit-v2";
const LEGACY_PROMPT_VERSION = "myarchitectai-legacy-mapping-v1";
type ProviderOutcome = "not_sent" | "succeeded" | "rejected" | "unknown";

export interface MyArchitectAIEditRequest {
  image: ImageReference;
  referenceImage?: ImageReference;
  prompt: string;
  /** Absolute deadline for the complete API call, download and decoding. */
  deadlineMs?: number;
  onProviderResponse?: (
    observation: ImageProviderResponseObservation,
  ) => Promise<void>;
}

/**
 * The documented endpoint accepts one base image and one identity image.
 * Its underlying model is not a versioned part of the public API contract.
 */
export class MyArchitectAIImageProvider
  implements ImageEditingProvider, ImageGenerationProvider
{
  readonly name = "myarchitectai";
  readonly model = "edit-by-prompt";

  isAvailable(): boolean {
    return Boolean(
      serverConfig.myArchitectAIApiKey && !serverConfig.aiMockMode,
    );
  }

  generate(request: ImageGenerationRequest): Promise<ProviderAttemptResult> {
    return this.run(request);
  }

  edit(request: ImageEditingRequest): Promise<ProviderAttemptResult> {
    return this.run(request);
  }

  /** Catalogue preparation is explicit and never starts from a client render. */
  async prepareView(
    request: PreparedViewGenerationRequest,
  ): Promise<ProviderAttemptResult> {
    const startedAt = Date.now();
    const finish = (result: ProviderAttemptResult) =>
      operationMetadata(result, "prepared_view", PREPARED_VIEW_PROMPT_VERSION);
    if (
      !validRequestedViewOrientation(request.requestedOrientation) ||
      !request.productImage?.role.startsWith("product_") ||
      (request.referenceImage &&
        !request.referenceImage.role.startsWith("product_"))
    )
      return finish(
        failure(
          startedAt,
          "invalid_prepared_view_input",
          "La préparation exige des références produit et une orientation valides.",
        ),
      );
    if (
      !(await decodableImage(request.productImage)) ||
      (request.referenceImage &&
        !(await decodableImage(request.referenceImage)))
    ) {
      return finish(
        failure(
          startedAt,
          "invalid_input",
          "La référence produit ne peut pas être décodée.",
        ),
      );
    }
    const result = await this.editImage({
      image: request.productImage,
      referenceImage: request.referenceImage,
      prompt: buildPreparedViewPrompt(
        request.requestedOrientation,
        Boolean(request.referenceImage),
        request.instructions,
      ),
      deadlineMs: request.deadlineMs,
      onProviderResponse: request.onProviderResponse,
    });
    const checked = await preserveAspectRatio(
      result,
      request.productImage,
      startedAt,
    );
    return finish({
      ...checked,
      usage: {
        ...checked.usage,
        requestedOrientation: { ...request.requestedOrientation },
        candidateOnly: true,
      },
    });
  }

  /** The chosen view is already in the composition. No reference image is sent. */
  async harmonize(
    request: OrientedHarmonizationRequest,
  ): Promise<ProviderAttemptResult> {
    const startedAt = Date.now();
    const finish = (result: ProviderAttemptResult) =>
      operationMetadata(
        result,
        "oriented_harmonization",
        ORIENTED_HARMONIZATION_PROMPT_VERSION,
      );
    if (
      request.composition?.role !== "composition" ||
      /\bimage\s*(?:#\s*)?(?:2|two)\b/i.test(request.instructions ?? "") ||
      !(await decodableImage(request.composition))
    ) {
      return finish(
        failure(
          startedAt,
          "invalid_harmonization_input",
          "L’harmonisation exige une composition lisible sans instruction de seconde image.",
        ),
      );
    }
    const result = await this.editImage({
      image: request.composition,
      prompt: buildOrientedHarmonizationPrompt(request.instructions),
      deadlineMs:
        request.deadlineMs === undefined
          ? undefined
          : request.deadlineMs - REVIEW_RESERVE_MS,
      onProviderResponse: request.onProviderResponse,
    });
    return finish(
      await preserveAspectRatio(result, request.composition, startedAt),
    );
  }

  /** Resume an already paid preparation from a private checkpoint, never a POST. */
  async downloadPreparedResponse(request: {
    observation: ImageProviderResponseObservation;
    productImage: ImageReference;
    requestedOrientation: RequestedViewOrientation;
    deadlineMs?: number;
  }): Promise<ProviderAttemptResult> {
    const startedAt = Date.now();
    const timeoutMs = Math.floor(
      Math.min(
        serverConfig.myArchitectAITimeoutMs,
        (request.deadlineMs ?? Infinity) - startedAt,
      ),
    );
    const { observation } = request;
    let result: ProviderAttemptResult;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) {
      result = failure(
        startedAt,
        "render_deadline",
        "Le délai restant ne permet plus la récupération de cette image.",
        observation.estimatedCostUsd,
        false,
        observation.requestId,
        undefined,
        "succeeded",
      );
    } else {
      result = await retrieveProviderOutput(
        observation,
        AbortSignal.timeout(timeoutMs),
        startedAt,
        timeoutMs,
      );
      result = await preserveAspectRatio(
        result,
        request.productImage,
        startedAt,
      );
    }
    return operationMetadata(
      {
        ...result,
        usage: {
          ...result.usage,
          candidateOnly: true,
          requestedOrientation: { ...request.requestedOrientation },
          recoveredResponse: true,
        },
      },
      "prepared_view",
      PREPARED_VIEW_PROMPT_VERSION,
    );
  }

  /** Resume only the download of a known paid harmonization, with no generation. */
  async downloadHarmonizationResponse(request: {
    observation: ImageProviderResponseObservation;
    composition: ImageReference;
    deadlineMs?: number;
  }): Promise<ProviderAttemptResult> {
    const startedAt = Date.now();
    const timeoutMs = Math.floor(
      Math.min(
        serverConfig.myArchitectAITimeoutMs,
        (request.deadlineMs === undefined
          ? Infinity
          : request.deadlineMs - REVIEW_RESERVE_MS) - startedAt,
      ),
    );
    const { observation } = request;
    let result: ProviderAttemptResult;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) {
      result = failure(
        startedAt,
        "render_deadline",
        "Le délai restant ne permet plus la récupération de cette image.",
        observation.estimatedCostUsd,
        false,
        observation.requestId,
        undefined,
        "succeeded",
      );
    } else {
      result = await retrieveProviderOutput(
        observation,
        AbortSignal.timeout(timeoutMs),
        startedAt,
        timeoutMs,
      );
      result = await preserveAspectRatio(
        result,
        request.composition,
        startedAt,
      );
    }
    return operationMetadata(
      { ...result, usage: { ...result.usage, recoveredResponse: true } },
      "oriented_harmonization",
      ORIENTED_HARMONIZATION_PROMPT_VERSION,
    );
  }

  private async run(
    request: ImageGenerationRequest | ImageEditingRequest,
  ): Promise<ProviderAttemptResult> {
    const startedAt = Date.now();
    const references = request.references ?? [];
    const finish = (result: ProviderAttemptResult) =>
      operationMetadata(
        result,
        request.operation ?? "legacy_composition",
        request.operation === "storefront_integration"
          ? STOREFRONT_HYBRID_PROMPT_VERSION
          : request.operation === "oriented_harmonization"
          ? ORIENTED_HARMONIZATION_PROMPT_VERSION
          : LEGACY_PROMPT_VERSION,
      );
    const identities = references.filter((item) =>
      item.role.startsWith("product_"),
    );
    if (references.some((item) => item.role === "spatial_guide")) {
      return finish(
        failure(
          Date.now(),
          "unsupported_spatial_guide",
          "MyArchitectAI ne prend pas en charge le guide spatial de ce rendu.",
        ),
      );
    }
    if (
      request.operation &&
      !["legacy_composition", "oriented_harmonization", "storefront_integration"].includes(
        request.operation,
      )
    ) {
      return finish(
        failure(
          startedAt,
          "unsupported_operation",
          "Cette opération MyArchitectAI n’est pas reconnue.",
        ),
      );
    }
    if (request.operation === "oriented_harmonization") {
      return this.harmonize({
        composition: references.find((item) => item.role === "composition") ?? {
          data: request.composition,
          mimeType: "image/webp",
          role: "composition",
        },
        instructions: request.prompt,
        deadlineMs: request.deadlineMs,
      });
    }
    if (identities.length > 1) {
      return finish(
        failure(
          Date.now(),
          "unsupported_product_references",
          "MyArchitectAI accepte une seule image de référence produit par rendu.",
        ),
      );
    }
    const image = references.find((item) => item.role === "composition") ??
      references.find((item) => item.role === "room_original") ?? {
        data: request.composition,
        mimeType: "image/webp" as const,
        role: "composition" as const,
      };
    // The API has no mask parameter. Background restoration remains the caller's
    // responsibility; sending a mask as the product reference would corrupt it.
    const result = await this.editImage({
      image,
      referenceImage: request.operation === "storefront_integration" ? undefined : identities[0] ?? {
        data: request.productCutout,
        mimeType: "image/webp",
        role: "product_front",
      },
      prompt: request.operation === "storefront_integration" ? request.prompt : `${request.prompt}\n\nInput mapping: image 1 is the base composition; image 2 is the attached product catalogue reference. Preserve the requested placement and product identity. If the product is already visible in the base composition, refine that instance only; do not add a duplicate.`,
      deadlineMs:
        request.deadlineMs === undefined
          ? undefined
          : request.deadlineMs - REVIEW_RESERVE_MS,
    });
    return finish(await preserveAspectRatio(result, image, startedAt));
  }

  async editImage(
    request: MyArchitectAIEditRequest,
  ): Promise<ProviderAttemptResult> {
    return operationMetadata(
      await this.executeEditImage(request),
      "direct_edit",
      "caller-prompt-v1",
    );
  }

  private async executeEditImage(
    request: MyArchitectAIEditRequest,
  ): Promise<ProviderAttemptResult> {
    const startedAt = Date.now();
    if (!this.isAvailable()) {
      return failure(
        startedAt,
        "provider_unavailable",
        "MyArchitectAI n’est pas configuré pour les rendus réels.",
      );
    }
    if (
      !request.prompt.trim() ||
      !validImage(request.image) ||
      (request.referenceImage && !validImage(request.referenceImage))
    ) {
      return failure(
        startedAt,
        "invalid_input",
        "L’édition nécessite une image et une instruction valides.",
      );
    }
    const timeoutMs = Math.floor(
      Math.min(
        serverConfig.myArchitectAITimeoutMs,
        (request.deadlineMs ?? Infinity) - startedAt,
      ),
    );
    if (timeoutMs < 1_000) {
      return failure(
        startedAt,
        "render_deadline",
        "Le délai restant ne permet plus cette édition.",
      );
    }
    // Check raw bytes before encoding, then the entire UTF-8 JSON envelope.
    if (
      request.image.data.byteLength +
        (request.referenceImage?.data.byteLength ?? 0) >
      MAX_REQUEST_BYTES * 0.75
    ) {
      return failure(
        startedAt,
        "request_too_large",
        "Les images dépassent la limite de 10 Mo de MyArchitectAI.",
      );
    }
    const body = JSON.stringify({
      image: dataUri(request.image),
      prompt: request.prompt,
      ...(request.referenceImage
        ? { referenceImage: dataUri(request.referenceImage) }
        : {}),
    });
    if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
      return failure(
        startedAt,
        "request_too_large",
        "La requête dépasse la limite de 10 Mo de MyArchitectAI.",
      );
    }

    const signal = durableAbortSignal(AbortSignal.timeout(timeoutMs))!;
    const allowance = serverConfig.myArchitectAIEditCostUsd;
    let response: Response;
    try {
      // Never retry this paid POST automatically: the API does not document an
      // idempotency guarantee, and a lost response can hide a completed edit.
      response = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": serverConfig.myArchitectAIApiKey!,
        },
        body,
        redirect: "error",
        cache: "no-store",
        signal,
      });
    } catch (reason) {
      return failure(
        startedAt,
        isTimeout(reason, signal) ? "timeout" : "network_error",
        isTimeout(reason, signal)
          ? "MyArchitectAI a dépassé le délai autorisé."
          : "Impossible de joindre MyArchitectAI.",
        allowance,
      );
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const status = response.status;
      return failure(
        startedAt,
        `http_${status}`,
        httpMessage(status),
        status >= 500 || status === 408 ? allowance : 0,
        status === 429,
        undefined,
        status,
      );
    }

    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(await boundedResponseText(response));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("invalid_payload");
      payload = parsed as Record<string, unknown>;
    } catch (reason) {
      return failure(
        startedAt,
        isTimeout(reason, signal) ? "timeout" : "invalid_response",
        "La réponse de MyArchitectAI est incomplète ou illisible.",
        allowance,
      );
    }
    const requestId =
      typeof payload.requestId === "number" &&
      Number.isSafeInteger(payload.requestId)
        ? String(payload.requestId)
        : crypto.randomUUID();
    if (typeof payload.error === "string" && payload.error.trim()) {
      // Documented HTTP 200 errors are refunded. Do not echo upstream diagnostics
      // which may contain a key, source image, signed URL or private prompt.
      return failure(
        startedAt,
        "provider_error",
        "MyArchitectAI n’a pas pu produire l’image ; cet appel a été remboursé.",
        0,
        false,
        requestId,
      );
    }
    const cost =
      typeof payload.cost === "number" &&
      Number.isFinite(payload.cost) &&
      payload.cost >= 0
        ? payload.cost
        : allowance;
    if (typeof payload.output !== "string" || !payload.output.trim()) {
      // Only the documented error envelope proves a refund. An incomplete
      // success-shaped response must not silently clear the paid allowance.
      return failure(
        startedAt,
        "empty_image_response",
        "MyArchitectAI n’a retourné aucune image exploitable.",
        Math.max(cost, allowance),
        false,
        requestId,
      );
    }

    if (request.onProviderResponse) {
      try {
        await request.onProviderResponse({
          requestId,
          estimatedCostUsd: cost,
          outcome: "succeeded",
          outputReference: payload.output,
        });
      } catch {
        return failure(
          startedAt,
          "provider_checkpoint_failed",
          "La réponse facturée n’a pas pu être enregistrée ; aucun nouvel appel ne sera lancé.",
          cost,
          false,
          requestId,
          undefined,
          "succeeded",
        );
      }
    }

    return retrieveProviderOutput(
      {
        requestId,
        estimatedCostUsd: cost,
        outcome: "succeeded",
        outputReference: payload.output,
      },
      signal,
      startedAt,
      timeoutMs,
    );
  }
}

async function retrieveProviderOutput(
  observation: ImageProviderResponseObservation,
  signal: AbortSignal,
  startedAt: number,
  timeoutMs: number,
): Promise<ProviderAttemptResult> {
  const { requestId, estimatedCostUsd: cost } = observation;
  let stage: "download" | "decode" = "download";
  try {
    const bytes = await downloadImage(observation.outputReference, signal);
    stage = "decode";
    signal.throwIfAborted();
    const decoder = sharp(bytes, {
      limitInputPixels: MAX_IMAGE_PIXELS,
      failOn: "warning",
    });
    const metadata = await abortable(decoder.metadata(), signal);
    if (
      !metadata.width ||
      !metadata.height ||
      !["jpeg", "png", "webp"].includes(metadata.format ?? "") ||
      (metadata.pages ?? 1) !== 1
    )
      throw new Error("invalid_image");
    const remainingSeconds = Math.max(
      1,
      Math.ceil((startedAt + timeoutMs - Date.now()) / 1_000),
    );
    const normalized = await abortable(
      decoder
        .rotate()
        .webp({ lossless: true })
        .timeout({ seconds: remainingSeconds })
        .toBuffer({ resolveWithObject: true }),
      signal,
    );
    if (normalized.data.byteLength > MAX_IMAGE_BYTES)
      throw new Error("image_too_large");
    signal.throwIfAborted();
    return {
      provider: "myarchitectai",
      model: "edit-by-prompt",
      requestId,
      status: "succeeded",
      durationMs: Date.now() - startedAt,
      estimatedCostUsd: cost,
      images: [
        {
          data: new Uint8Array(normalized.data),
          mimeType: "image/webp",
          width: normalized.info.width,
          height: normalized.info.height,
        },
      ],
      safety: { blocked: false },
      attemptCount: 1,
      usage: { costUsd: cost, providerOutcome: "succeeded" },
    };
  } catch (reason) {
    return failure(
      startedAt,
      isTimeout(reason, signal)
        ? "timeout"
        : stage === "download"
          ? "image_download_failed"
          : "invalid_output_image",
      "L’image produite par MyArchitectAI n’a pas pu être récupérée et validée.",
      cost,
      false,
      requestId,
      undefined,
      "succeeded",
    );
  }
}

function validImage(image: ImageReference): boolean {
  return (
    image.data.byteLength > 0 &&
    ["image/jpeg", "image/png", "image/webp"].includes(image.mimeType)
  );
}

async function decodableImage(image: ImageReference): Promise<boolean> {
  if (!validImage(image) || image.data.byteLength > MAX_IMAGE_BYTES)
    return false;
  try {
    const metadata = await sharp(image.data, {
      limitInputPixels: MAX_IMAGE_PIXELS,
      failOn: "warning",
    }).metadata();
    return Boolean(
      metadata.width &&
      metadata.height &&
      (metadata.pages ?? 1) === 1 &&
      ["png", "jpeg", "webp"].includes(metadata.format ?? ""),
    );
  } catch {
    return false;
  }
}

function operationMetadata(
  result: ProviderAttemptResult,
  operation: string,
  promptVersion: string,
): ProviderAttemptResult {
  return {
    ...result,
    usage: {
      ...result.usage,
      operation,
      promptVersion,
      configurationVersion: MYARCHITECTAI_CONFIGURATION_VERSION,
      configuration: {
        endpoint: "edit-by-prompt",
        modelVersion: "unspecified_by_provider",
        timeoutMs: serverConfig.myArchitectAITimeoutMs,
        allowanceUsd: serverConfig.myArchitectAIEditCostUsd,
      },
    },
  };
}

async function preserveAspectRatio(
  result: ProviderAttemptResult,
  image: ImageReference,
  startedAt: number,
): Promise<ProviderAttemptResult> {
  if (result.status !== "succeeded") return result;
  // Never stretch a changed frame into the scene during background restoration.
  let errorCode = "output_aspect_ratio_mismatch";
  try {
    const base = await sharp(image.data, {
      limitInputPixels: MAX_IMAGE_PIXELS,
    }).metadata();
    const output = result.images[0];
    if (!base.width || !base.height || !output?.width || !output.height)
      throw new Error("missing_image_dimensions");
    const swapped = (base.orientation ?? 1) >= 5;
    const ratio = swapped ? base.height / base.width : base.width / base.height;
    if (Math.abs(output.width / output.height / ratio - 1) <= 0.02)
      return result;
  } catch {
    errorCode = "unverifiable_image_dimensions";
  }
  return {
    ...result,
    status: "failed",
    images: [],
    durationMs: Date.now() - startedAt,
    error: {
      code: errorCode,
      message:
        errorCode === "output_aspect_ratio_mismatch"
          ? "MyArchitectAI a modifié les proportions de l’image ; ce rendu ne peut pas être utilisé."
          : "Les proportions de l’image produite par MyArchitectAI n’ont pas pu être vérifiées.",
      retryable: false,
    },
  };
}

function dataUri(image: ImageReference): string {
  return `data:${image.mimeType};base64,${Buffer.from(image.data).toString("base64")}`;
}

function failure(
  startedAt: number,
  code: string,
  message: string,
  cost = 0,
  retryable = false,
  requestId = crypto.randomUUID(),
  httpStatus?: number,
  providerOutcome: ProviderOutcome = code === "provider_error" ||
  (httpStatus !== undefined && httpStatus < 500 && httpStatus !== 408)
    ? "rejected"
    : [
          "timeout",
          "network_error",
          "invalid_response",
          "empty_image_response",
        ].includes(code) ||
        (httpStatus !== undefined && (httpStatus >= 500 || httpStatus === 408))
      ? "unknown"
      : "not_sent",
): ProviderAttemptResult {
  return {
    provider: "myarchitectai",
    model: "edit-by-prompt",
    requestId,
    status: "failed",
    durationMs: Date.now() - startedAt,
    estimatedCostUsd: cost,
    images: [],
    error: { code, message, retryable, ...(httpStatus ? { httpStatus } : {}) },
    safety: { blocked: false },
    attemptCount: 1,
    usage: {
      costUsd: cost,
      providerOutcome,
      ...(code === "provider_error" ? { refundConfirmed: true } : {}),
    },
  };
}

function httpMessage(status: number): string {
  if (status === 401 || status === 403)
    return "La clé MyArchitectAI n’est pas autorisée.";
  if (status === 402) return "Le solde MyArchitectAI est insuffisant.";
  if (status === 413)
    return "MyArchitectAI a refusé une requête trop volumineuse.";
  if (status === 429)
    return "MyArchitectAI reçoit trop de demandes ; réessayez plus tard.";
  return `MyArchitectAI a refusé la demande (HTTP ${status}).`;
}

function isTimeout(reason: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (reason instanceof Error &&
      ["AbortError", "TimeoutError"].includes(reason.name))
  );
}

async function boundedResponseText(response: Response): Promise<string> {
  if (!response.body) throw new Error("empty_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("response_too_large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

const blockedV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blockedV4.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const blockedV6 = new BlockList();
blockedV6.addSubnet("2001::", 23, "ipv6");
blockedV6.addSubnet("2001:db8::", 32, "ipv6");
blockedV6.addSubnet("2002::", 16, "ipv6");

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) return !blockedV4.check(address, "ipv4");
  return (
    isIP(address) === 6 &&
    globalV6.check(address, "ipv6") &&
    !blockedV6.check(address, "ipv6")
  );
}

function imageUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname;
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    isIP(host.replace(/^\[|\]$/g, "")) ||
    host.length > 253 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(
      host,
    ) ||
    /(?:^|\.)(?:localhost|local|internal|invalid|test|onion)$/i.test(host)
  ) {
    throw new Error("unsafe_image_url");
  }
  return url;
}

/** Validate every redirect and pin DNS so a public hostname cannot rebind. */
async function downloadImage(
  output: string,
  signal: AbortSignal,
): Promise<Buffer> {
  let url = imageUrl(output);
  for (let redirects = 0; redirects <= 3; redirects++) {
    signal.throwIfAborted();
    const addresses = await abortable(
      lookup(url.hostname, { all: true, verbatim: true }),
      signal,
    );
    if (
      !addresses.length ||
      addresses.some((item) => !publicAddress(item.address))
    )
      throw new Error("unsafe_image_host");
    const selected =
      addresses.find((item) => item.family === 4) ?? addresses[0]!;
    const pinnedLookup: LookupFunction = (_host, options, callback) => {
      if (options.all) callback(null, [selected]);
      else callback(null, selected.address, selected.family);
    };
    const downloaded = await new Promise<Buffer | URL>((resolve, reject) => {
      const req = httpsRequest(
        url,
        {
          method: "GET",
          signal,
          lookup: pinnedLookup,
          // Do not reuse a connection resolved outside this validation, and never
          // attach the API key, cookies or authorization to an output/CDN URL.
          agent: false,
          headers: { Accept: "image/png,image/jpeg,image/webp" },
        },
        (res) => {
          if (
            res.statusCode &&
            [301, 302, 303, 307, 308].includes(res.statusCode)
          ) {
            res.destroy();
            try {
              if (!res.headers.location || redirects === 3)
                throw new Error("image_redirect_limit");
              resolve(imageUrl(new URL(res.headers.location, url).href));
            } catch (reason) {
              reject(reason);
            }
            return;
          }
          if (
            res.statusCode !== 200 ||
            Number(res.headers["content-length"] ?? 0) > MAX_IMAGE_BYTES
          ) {
            res.destroy();
            reject(new Error("image_download_rejected"));
            return;
          }
          const type = res.headers["content-type"]
            ?.split(";")[0]
            ?.trim()
            .toLowerCase();
          if (
            type &&
            ![
              "image/png",
              "image/jpeg",
              "image/webp",
              "application/octet-stream",
            ].includes(type)
          ) {
            res.destroy();
            reject(new Error("invalid_image_type"));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.byteLength;
            if (size > MAX_IMAGE_BYTES) {
              res.destroy();
              reject(new Error("image_too_large"));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => resolve(Buffer.concat(chunks)));
          res.on("error", reject);
          res.on("aborted", () => reject(new Error("incomplete_image")));
        },
      );
      req.on("error", reject);
      req.end();
    });
    if (Buffer.isBuffer(downloaded)) return downloaded;
    url = downloaded;
  }
  throw new Error("image_redirect_limit");
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}
