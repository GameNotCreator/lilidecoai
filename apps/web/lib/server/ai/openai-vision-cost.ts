/** Published token-price estimate, never a reconciled invoice. No provider calls. */
export const VISION_PRICE_VERSION = "openai-astra-2026-09-27-v1";
export const VISION_PRICE_SOURCE = "https://developers.openai.com/api/docs/pricing";
export const VISION_COST_POLICY = "astra-token-allowance-v1";

/** Only models with a verified price table opt into the new admission policy. */
export function spatialVisionAdmissionPolicy(model: string): { visionCostPolicy?: typeof VISION_COST_POLICY } {
  return model === "gpt-6-astra" ? { visionCostPolicy: VISION_COST_POLICY } : {};
}

/**
 * Admission freezes this ESTIMATE, not a hard token/spend cap. Reserve the full
 * output limit plus 20k input tokens at cache-write prices. Auto/unknown tiers
 * use the highest published Astra tier (2x). Inputs exceeding this allowance or
 * long-context pricing can cost more; exact usage is settled without clamping.
 */
export function spatialVisionAllowance(input: {
  policy?: string; model: string; maxOutputTokens: number; serviceTier?: string;
}) {
  if (input.policy === undefined) return { estimatedCostUsd: 0.03 };
  if (input.policy !== VISION_COST_POLICY || input.model !== "gpt-6-astra" ||
      !Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens <= 0)
    throw Object.assign(new Error("Politique de réserve vision non prise en charge."), {
      providerCalled: false, status: 402, retryable: false,
    });
  const tierFactor = input.serviceTier === "default" ? 1 : input.serviceTier === "flex" ? 0.5 : 2;
  return {
    estimatedCostUsd: (20_000 * 12.5 + input.maxOutputTokens * 50) * tierFactor / 1_000_000,
    usage: {
      costAllowance: {
        policy: VISION_COST_POLICY,
        inputTokenAllowance: 20_000,
        maxOutputTokens: input.maxOutputTokens,
        tierFactor,
        priceVersion: VISION_PRICE_VERSION,
        hardSpendCap: false,
      },
    },
  };
}

export interface VisionObservation {
  usage?: unknown;
  model?: unknown;
  serviceTier?: unknown;
  requestedModel: string;
  requestedServiceTier?: string;
  baseUrl: string;
  requestId?: string;
}

const observations = new WeakMap<object, VisionObservation>();
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function visionObservation(value: unknown): VisionObservation | undefined {
  return object(value) ? observations.get(value) : undefined;
}

/** Metadata stays outside business/QA objects and durable checkpoint payloads. */
export function preserveVisionObservation<T>(source: unknown, parse: () => T): T {
  const observation = visionObservation(source);
  try {
    const result = parse();
    if (observation && object(result)) observations.set(result, observation);
    return result;
  } catch (reason) {
    if (observation && object(reason)) observations.set(reason, observation);
    throw reason;
  }
}

/** Preserve usage even when a paid response is incomplete or fails local QA parsing. */
export function observeVisionResponse<T>(
  payload: unknown,
  request: Omit<VisionObservation, "usage" | "model" | "serviceTier">,
  parse: () => T,
): T {
  const observation: VisionObservation = {
    ...request,
    ...(object(payload) ? {
      usage: payload.usage,
      model: payload.model,
      serviceTier: payload.service_tier,
    } : {}),
  };
  const carrier = {};
  observations.set(carrier, observation);
  return preserveVisionObservation(carrier, parse);
}

const tokenCount = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

export function estimateVisionUsage(observation: VisionObservation | undefined, allowanceUsd: number) {
  if (!Number.isFinite(allowanceUsd) || allowanceUsd < 0)
    throw new Error("Invalid provider allowance.");
  const fallback = (reason: string) => ({
    estimatedCostUsd: allowanceUsd,
    provenance: {
      method: "allowance" as const,
      priceVersion: VISION_PRICE_VERSION,
      reason,
      allowanceUsd,
      invoice: false,
    },
  });
  if (!observation) return fallback("usage-unavailable");
  if (typeof observation.baseUrl !== "string" || observation.baseUrl.replace(/\/$/, "") !== "https://api.openai.com/v1")
    return fallback("unsupported-endpoint");
  const model = observation.model ?? observation.requestedModel;
  if (model !== "gpt-6-astra") return fallback("unsupported-model");
  const tier = observation.serviceTier ?? observation.requestedServiceTier;
  const tierFactor = tier === "default" ? 1 : tier === "flex" ? 0.5 :
    tier === "priority" || tier === "fast" ? 2 : undefined;
  if (tierFactor === undefined) return fallback("unknown-service-tier");
  const usage = observation.usage;
  if (!object(usage) || !tokenCount(usage.input_tokens) || !tokenCount(usage.output_tokens))
    return fallback("invalid-usage");
  const details = usage.input_tokens_details;
  if (!object(details))
    return fallback("invalid-input-details");
  const cached = details.cached_tokens;
  const written = details.cache_write_tokens ?? 0;
  if (!tokenCount(cached) || !tokenCount(written) || cached + written > usage.input_tokens)
    return fallback("invalid-cache-partition");
  if (usage.total_tokens !== undefined &&
      (!tokenCount(usage.total_tokens) || usage.total_tokens !== usage.input_tokens + usage.output_tokens))
    return fallback("inconsistent-total");
  const outputDetails = usage.output_tokens_details;
  if (outputDetails !== undefined && outputDetails !== null && !object(outputDetails))
    return fallback("invalid-output-details");
  if (object(outputDetails) && outputDetails.reasoning_tokens !== undefined &&
      (!tokenCount(outputDetails.reasoning_tokens) || outputDetails.reasoning_tokens > usage.output_tokens))
    return fallback("invalid-reasoning-count");
  if (usage.input_tokens + usage.output_tokens === 0) return fallback("empty-usage");
  const longContext = usage.input_tokens > 272_000;
  const inputFactor = longContext ? 2 : 1;
  const outputFactor = longContext ? 1.5 : 1;
  const ordinary = usage.input_tokens - cached - written;
  // Cache writes REPLACE ordinary input pricing. Reasoning is already in output_tokens.
  const estimatedCostUsd = tierFactor * (
    (ordinary * 10 + cached * 1 + written * 12.5) * inputFactor +
    usage.output_tokens * 50 * outputFactor
  ) / 1_000_000;
  return {
    estimatedCostUsd,
    provenance: {
      method: "reported-tokens" as const,
      priceVersion: VISION_PRICE_VERSION,
      source: VISION_PRICE_SOURCE,
      model,
      serviceTier: tier,
      longContext,
      tokens: { ordinaryInput: ordinary, cachedInput: cached, cacheWrite: written, output: usage.output_tokens },
      usdPerMillion: { input: 10 * inputFactor * tierFactor, cachedInput: inputFactor * tierFactor,
        cacheWrite: 12.5 * inputFactor * tierFactor, output: 50 * outputFactor * tierFactor },
      allowanceUsd,
      invoice: false,
    },
  };
}
