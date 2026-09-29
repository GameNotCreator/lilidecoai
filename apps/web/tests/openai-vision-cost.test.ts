import { describe, expect, it } from "vitest";
import {
  estimateVisionUsage, observeVisionResponse, preserveVisionObservation,
  spatialVisionAllowance, VISION_COST_POLICY, visionObservation,
  spatialVisionAdmissionPolicy,
  type VisionObservation,
} from "../lib/server/ai/openai-vision-cost";

const observed = (usage: unknown, extra: Partial<VisionObservation> = {}): VisionObservation => ({
  requestedModel: "gpt-6-astra", requestedServiceTier: "auto", model: "gpt-6-astra",
  serviceTier: "default", baseUrl: "https://api.openai.com/v1", usage, ...extra,
});
const tokens = (input = 1000, output = 100) => ({
  input_tokens: input, output_tokens: output, total_tokens: input + output,
  input_tokens_details: { cached_tokens: 200, cache_write_tokens: 300 },
  output_tokens_details: { reasoning_tokens: output },
});

describe("reported vision token estimates", () => {
  it("partitions cache writes and does not add reasoning output twice", () => {
    const value = estimateVisionUsage(observed(tokens()), 0.7);
    expect(value.estimatedCostUsd).toBeCloseTo(0.01395, 10);
    expect(value.provenance).toMatchObject({ method: "reported-tokens", invoice: false,
      tokens: { ordinaryInput: 500, cachedInput: 200, cacheWrite: 300, output: 100 } });
  });
  it("recalculates the two archived baseline usages independently of the old journal", () => {
    const a = estimateVisionUsage(observed({ input_tokens: 1278, output_tokens: 109,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 1275 } }), 0.03);
    const b = estimateVisionUsage(observed({ input_tokens: 1532, output_tokens: 2936,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 1529 } }), 0.03);
    expect(a.estimatedCostUsd).toBeCloseTo(0.0214175, 10);
    expect(b.estimatedCostUsd).toBeCloseTo(0.1659425, 10);
    expect(a.estimatedCostUsd + b.estimatedCostUsd).toBeCloseTo(0.18736, 10);
  });
  it.each([272000, 272001])("applies the long-context discontinuity at %i input", (input) => {
    const price = estimateVisionUsage(observed({ input_tokens: input, output_tokens: 100, input_tokens_details: { cached_tokens: 0 } }), 1);
    expect(price.estimatedCostUsd).toBeCloseTo((input * 10 * (input > 272000 ? 2 : 1) + 5000 * (input > 272000 ? 1.5 : 1)) / 1e6, 10);
  });
  it.each(["priority", "fast", "flex"])("uses the returned %s tier", (serviceTier) => {
    const base = estimateVisionUsage(observed(tokens()), 1).estimatedCostUsd;
    expect(estimateVisionUsage(observed(tokens(), { serviceTier }), 1).estimatedCostUsd)
      .toBeCloseTo(base * (serviceTier === "flex" ? 0.5 : 2), 10);
  });
  it.each([
    undefined, null, {}, { input_tokens: -1, output_tokens: 2 },
    { input_tokens: 1000, output_tokens: 100 },
    { input_tokens: 1.5, output_tokens: 2 }, { input_tokens: 1, output_tokens: NaN },
    { input_tokens: 0, output_tokens: 0 }, { ...tokens(), total_tokens: 10 },
    { ...tokens(), input_tokens_details: { cached_tokens: 500, cache_write_tokens: 501 } },
    { ...tokens(), input_tokens_details: { cached_tokens: "100" } },
    { ...tokens(), output_tokens_details: { reasoning_tokens: 101 } },
  ])("keeps the allowance for absent or invalid usage %j", (usage) => {
    expect(estimateVisionUsage(observed(usage), 0.7)).toMatchObject({ estimatedCostUsd: 0.7,
      provenance: { method: "allowance" } });
  });
  it.each([
    { model: "gpt-other" }, { serviceTier: "auto" }, { serviceTier: "unknown" },
    { baseUrl: "https://eu.api.openai.com/v1" },
  ])("does not invent unsupported pricing %j", (extra) => {
    expect(estimateVisionUsage(observed(tokens(), extra), 0.7).estimatedCostUsd).toBe(0.7);
  });
  it("does not change the business object or lose usage on local parse failure", () => {
    const payload = { usage: tokens(), model: "gpt-6-astra", service_tier: "default" };
    const business = { accepted: false, checks: [] };
    const result = observeVisionResponse(payload, { requestedModel: "gpt-6-astra", baseUrl: "https://api.openai.com/v1" }, () => business);
    expect(result).toBe(business);
    expect(JSON.stringify(result)).toBe('{"accepted":false,"checks":[]}');
    const rejected = new Error("invalid QA");
    expect(() => preserveVisionObservation(result, () => { throw rejected; })).toThrow(rejected);
    expect(visionObservation(rejected)?.usage).toEqual(tokens());
  });
});

describe("frozen spatial allowances", () => {
  it("keeps alternative-model admissions on their compatible allowance", () => {
    expect(spatialVisionAdmissionPolicy("gpt-6-astra")).toEqual({ visionCostPolicy: VISION_COST_POLICY });
    for (const model of ["vision-custom", "gpt-6-sol", "gpt-6-astra-future"]) {
      const versions = { visionModel: model, ...spatialVisionAdmissionPolicy(model) };
      expect(versions.visionCostPolicy).toBeUndefined();
      expect(spatialVisionAllowance({ model, policy: versions.visionCostPolicy, maxOutputTokens: 9000 })).toEqual({ estimatedCostUsd: 0.03 });
    }
  });
  it("preserves admitted jobs without a policy and reserves output plus input on new jobs", () => {
    expect(spatialVisionAllowance({ model: "legacy", maxOutputTokens: 9000 })).toEqual({ estimatedCostUsd: 0.03 });
    expect(spatialVisionAllowance({ policy: VISION_COST_POLICY, model: "gpt-6-astra", maxOutputTokens: 9000, serviceTier: "auto" }))
      .toMatchObject({ estimatedCostUsd: 1.4, usage: { costAllowance: { hardSpendCap: false, inputTokenAllowance: 20000 } } });
    expect(spatialVisionAllowance({ policy: VISION_COST_POLICY, model: "gpt-6-astra", maxOutputTokens: 13000, serviceTier: "default" }).estimatedCostUsd).toBe(0.9);
  });
  it("refuses unknown policies/models before a provider call", () => {
    for (const extra of [{ policy: "future" }, { model: "gpt-unknown" }, { maxOutputTokens: NaN }])
      expect(() => spatialVisionAllowance({ policy: VISION_COST_POLICY, model: "gpt-6-astra", maxOutputTokens: 5000, ...extra })).toThrow(/réserve/);
  });
});
