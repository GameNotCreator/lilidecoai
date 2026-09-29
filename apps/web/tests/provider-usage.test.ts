import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "mongodb";

const mocks = vi.hoisted(() => ({
  collections: vi.fn(),
  config: { openaiMaxCostUsd: 0.25 },
}));
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/mongodb", () => ({ collections: mocks.collections }));
vi.mock("../lib/server/config", () => ({ serverConfig: mocks.config }));

import {
  assertRenderBudget,
  isProviderRefusal,
  markProviderRefusal,
  measureProviderCall,
  recordProviderUsage,
  RenderBudgetError,
  renderBudgetUsd,
  renderUsageTotals,
} from "../lib/server/provider-usage";
import { mongoStore } from "./helpers/mongo-store";
import { observeVisionResponse } from "../lib/server/ai/openai-vision-cost";

const db = {} as Db;
const render = { id: "r", organizationId: "org" };

let renders: ReturnType<typeof mongoStore>;
let renderAttempts: ReturnType<typeof mongoStore>;

beforeEach(() => {
  renders = mongoStore();
  renderAttempts = mongoStore();
  renders.rows.push({ id: "r", organizationId: "org" });
  mocks.collections.mockReturnValue({ renders, renderAttempts });
  delete process.env.RENDER_MAX_COST_USD;
});

describe("provider usage journal", () => {
  it("journals a call and adds it to the render total", async () => {
    await recordProviderUsage(db, render, {
      step: "generating_final",
      provider: "openai",
      model: "gpt-image-2",
      outcome: "succeeded",
      estimatedCostUsd: 0.12,
      latencyMs: 4_000,
    });
    expect(renderAttempts.rows).toHaveLength(1);
    expect(renderAttempts.rows[0]).toMatchObject({
      renderId: "r",
      stage: "generating_final",
      status: "succeeded",
      usageOutcome: "succeeded",
      estimatedCostUsd: 0.12,
    });
    expect(await renderUsageTotals(db, "r")).toEqual({
      calls: 1,
      estimatedCostUsd: 0.12,
      unknownOutcomeCalls: 0,
    });
    // The legacy pipeline retains its existing summary semantics.
    expect(renders.rows[0]!.estimatedCostUsd).toBeUndefined();
    expect(renders.rows[0]!.attemptCount).toBeUndefined();
  });

  // A13 of the audit: a lost response was recorded as costing nothing.
  it("counts a call of unknown outcome, and its cost", async () => {
    await recordProviderUsage(db, render, {
      step: "removing_target",
      provider: "openai",
      model: "gpt-image-2",
      outcome: "unknown",
      estimatedCostUsd: 0.115,
      latencyMs: 145_000,
      errorCode: "provider_outcome_unknown",
    });
    const totals = await renderUsageTotals(db, "r");
    expect(totals.unknownOutcomeCalls).toBe(1);
    expect(totals.estimatedCostUsd).toBeCloseTo(0.115);
    // Still readable as a failure by everything that only knows `status`.
    expect(renderAttempts.rows[0]!.status).toBe("failed");
  });

  it("accumulates every step, failures included", async () => {
    for (const outcome of ["succeeded", "failed", "unknown"] as const) {
      await recordProviderUsage(db, render, {
        step: `step-${outcome}`,
        provider: "openai",
        model: "m",
        outcome,
        estimatedCostUsd: 0.03,
        latencyMs: 10,
      });
    }
    expect(await renderUsageTotals(db, "r")).toEqual({
      calls: 3,
      estimatedCostUsd: 0.09,
      unknownOutcomeCalls: 1,
    });
  });

  it("never lets a journal failure break the render it measures", async () => {
    mocks.collections.mockReturnValue({
      renders,
      renderAttempts: {
        ...renderAttempts,
        async insertOne() {
          throw new Error("journal down");
        },
      },
    });
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      recordProviderUsage(db, render, {
        step: "generating_final",
        provider: "openai",
        model: "m",
        outcome: "succeeded",
        estimatedCostUsd: 0.12,
        latencyMs: 10,
      }),
    ).resolves.toBeUndefined();
    expect(await renderUsageTotals(db, "r")).toMatchObject({
      calls: 1,
      estimatedCostUsd: 0.12,
    });
    process.env.RENDER_MAX_COST_USD = "0.2";
    const nextCall = vi.fn().mockResolvedValue("should not be called");
    await expect(
      measureProviderCall(
        db,
        render,
        {
          step: "spatial-analysis",
          provider: "openai",
          model: "m",
          estimatedCostUsd: 0.12,
        },
        nextCall,
      ),
    ).rejects.toBeInstanceOf(RenderBudgetError);
    expect(nextCall).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("still journals a paid call when the summary update fails", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.collections.mockReturnValue({
      renders: {
        ...renders,
        updateOne: vi.fn().mockRejectedValue(new Error("summary down")),
      },
      renderAttempts,
    });
    await recordProviderUsage(db, render, {
      step: "spatial-generation",
      provider: "openai",
      model: "m",
      outcome: "unknown",
      estimatedCostUsd: 0.12,
      latencyMs: 10,
    });
    expect(renderAttempts.rows).toHaveLength(1);
    expect(renderAttempts.rows[0]).toMatchObject({
      usageOutcome: "unknown",
      estimatedCostUsd: 0.12,
    });
    process.env.RENDER_MAX_COST_USD = "0.2";
    expect(await renderUsageTotals(db, "r")).toMatchObject({
      calls: 1,
      estimatedCostUsd: 0.12,
    });
    await expect(assertRenderBudget(db, "r", 0.12)).rejects.toBeInstanceOf(
      RenderBudgetError,
    );
    warn.mockRestore();
  });

  it("counts disjoint partial writes once after a worker restart", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const descriptor = {
      step: "spatial-generation",
      provider: "openai",
      model: "m",
      outcome: "succeeded" as const,
      estimatedCostUsd: 0.12,
      latencyMs: 10,
    };
    // First call survives only in the summary; second only in the journal.
    mocks.collections.mockReturnValue({
      renders,
      renderAttempts: {
        ...renderAttempts,
        insertOne: vi.fn().mockRejectedValue(new Error("journal down")),
      },
    });
    await recordProviderUsage(db, render, descriptor);
    mocks.collections.mockReturnValue({
      renders: {
        ...renders,
        updateOne: vi.fn().mockRejectedValue(new Error("summary down")),
      },
      renderAttempts,
    });
    await recordProviderUsage(db, render, descriptor);
    mocks.collections.mockReturnValue({ renders, renderAttempts });
    await recordProviderUsage(db, render, descriptor);
    expect(await renderUsageTotals(db, "r")).toEqual({
      calls: 3,
      estimatedCostUsd: 0.36,
      unknownOutcomeCalls: 0,
    });
    process.env.RENDER_MAX_COST_USD = "0.4";
    await expect(assertRenderBudget(db, "r", 0.12)).rejects.toBeInstanceOf(
      RenderBudgetError,
    );
    warn.mockRestore();
  });

  it("stops when neither accounting record can be persisted", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const insert = vi.fn().mockRejectedValue(new Error("journal down"));
    mocks.collections.mockReturnValue({
      renders: {
        ...renders,
        updateOne: vi.fn().mockRejectedValue(new Error("summary down")),
      },
      renderAttempts: { ...renderAttempts, insertOne: insert },
    });
    const call = vi.fn().mockResolvedValue("paid result");
    await expect(
      measureProviderCall(
        db,
        render,
        {
          step: "spatial-analysis",
          provider: "openai",
          model: "m",
          estimatedCostUsd: 0.12,
        },
        call,
      ),
    ).rejects.toMatchObject({ status: 402, retryable: false });
    expect(call).toHaveBeenCalledOnce();
    expect(insert).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("render budget", () => {
  it("reads an explicit ceiling, and derives one otherwise", () => {
    expect(renderBudgetUsd()).toBeCloseTo(1);
    process.env.RENDER_MAX_COST_USD = "0.4";
    expect(renderBudgetUsd()).toBeCloseTo(0.4);
  });

  it("stops the next paid step once the ceiling is reached", async () => {
    process.env.RENDER_MAX_COST_USD = "0.2";
    await recordProviderUsage(db, render, {
      step: "removing_target",
      provider: "openai",
      model: "m",
      outcome: "succeeded",
      estimatedCostUsd: 0.15,
      latencyMs: 10,
    });
    await expect(assertRenderBudget(db, "r", 0.12)).rejects.toBeInstanceOf(
      RenderBudgetError,
    );
    // Under the ceiling the step still runs.
    await expect(assertRenderBudget(db, "r", 0.04)).resolves.toBeUndefined();
  });

  it("checks the budget before the call, not after", async () => {
    process.env.RENDER_MAX_COST_USD = "0.05";
    const call = vi.fn().mockResolvedValue("image");
    await expect(
      measureProviderCall(
        db,
        render,
        {
          step: "generating_final",
          provider: "openai",
          model: "m",
          estimatedCostUsd: 0.12,
        },
        call,
      ),
    ).rejects.toBeInstanceOf(RenderBudgetError);
    expect(call).not.toHaveBeenCalled();
    expect(renderAttempts.rows).toHaveLength(0);
  });
});

describe("measureProviderCall", () => {
  it.each([false, true])("prices observed usage without changing the QA result (rejected=%s)", async (rejected) => {
    const value = { accepted: false, checks: [{ score: 0 }] };
    const failure = new Error("invalid local review");
    const pending = measureProviderCall(db, render, {
      step: "spatial-review", provider: "openai", model: "gpt-6-astra", estimatedCostUsd: 0.9,
      usage: { reviewExecutionPolicy: "kept" },
    }, async () => observeVisionResponse({
      usage: { input_tokens: 1532, output_tokens: 2936, input_tokens_details: { cache_write_tokens: 1529, cached_tokens: 0 } },
      service_tier: "default", model: "gpt-6-astra",
    }, { requestedModel: "gpt-6-astra", baseUrl: "https://api.openai.com/v1", requestId: "req-fixture" },
    () => { if (rejected) throw failure; return value; }));
    if (rejected) await expect(pending).rejects.toBe(failure);
    else expect(await pending).toBe(value);
    expect(renderAttempts.rows[0]).toMatchObject({
      usageOutcome: rejected ? "failed" : "succeeded", estimatedCostUsd: 0.1659425,
      requestId: "req-fixture", usage: { reviewExecutionPolicy: "kept",
        providerUsage: { input_tokens: 1532, output_tokens: 2936 },
        costEstimate: { method: "reported-tokens", invoice: false } },
    });
    expect((await renderUsageTotals(db, "r")).estimatedCostUsd).toBeCloseTo(0.1659425);
  });
  it("retains the allowance when observed usage is absent and prevents the next expensive call", async () => {
    await measureProviderCall(db, render, {
      step: "spatial-review", provider: "openai", model: "gpt-6-astra", estimatedCostUsd: 0.9,
    }, async () => observeVisionResponse({}, { requestedModel: "gpt-6-astra", requestedServiceTier: "default", baseUrl: "https://api.openai.com/v1" }, () => ({ accepted: false })));
    expect(renderAttempts.rows[0]).toMatchObject({ estimatedCostUsd: 0.9,
      usage: { costEstimate: { method: "allowance" } } });
    const next = vi.fn();
    await expect(measureProviderCall(db, render, { step: "spatial-review", provider: "openai", model: "gpt-6-astra", estimatedCostUsd: 0.9 }, next)).rejects.toBeInstanceOf(RenderBudgetError);
    expect(next).not.toHaveBeenCalled();
  });
  it.each([NaN, Infinity, -1])("refuses invalid next-call reserve %s", async (value) => {
    await expect(assertRenderBudget(db, "r", value)).rejects.toThrow(/invalide/);
  });
  it("journals a success and returns its value", async () => {
    const result = await measureProviderCall(
      db,
      render,
      {
        step: "inspecting_target",
        provider: "openai",
        model: "vision",
        estimatedCostUsd: 0.03,
      },
      async () => "inspection",
    );
    expect(result).toBe("inspection");
    expect(renderAttempts.rows[0]).toMatchObject({
      usageOutcome: "succeeded",
      stage: "inspecting_target",
    });
  });

  it("records a thrown call as unknown, not as free, and rethrows", async () => {
    await expect(
      measureProviderCall(
        db,
        render,
        {
          step: "inspecting_target",
          provider: "openai",
          model: "vision",
          estimatedCostUsd: 0.03,
        },
        async () => {
          throw new Error("timeout after 75s");
        },
      ),
    ).rejects.toThrow(/timeout/);
    expect(renderAttempts.rows[0]).toMatchObject({
      usageOutcome: "unknown",
      errorCode: "provider_outcome_unknown",
      estimatedCostUsd: 0.03,
    });
    expect((await renderUsageTotals(db, "r")).unknownOutcomeCalls).toBe(1);
  });
});

/**
 * Found by the adversarial review of the cost fix: charging a refusal at full
 * price over-states the cost and trips the ceiling early. Only the code that
 * read the response knows the provider answered, so it marks the error.
 */
describe("a refusal the provider answered", () => {
  it("does not price an inspector that failed before making a request", async () => {
    const localError = Object.assign(new Error("deadline"), {
      providerCalled: false,
    });
    await expect(
      measureProviderCall(
        db,
        render,
        {
          step: "quality_check",
          provider: "openai",
          model: "vision",
          estimatedCostUsd: 0.03,
        },
        async () => {
          throw localError;
        },
      ),
    ).rejects.toThrow("deadline");
    expect(renderAttempts.rows[0]).toMatchObject({
      usageOutcome: "failed",
      estimatedCostUsd: 0,
      errorCode: "provider_not_called",
    });
  });
  it("is journaled as a known, unbilled failure", async () => {
    await expect(
      measureProviderCall(
        db,
        render,
        {
          step: "inspecting_target",
          provider: "openai",
          model: "vision",
          estimatedCostUsd: 0.03,
        },
        async () => {
          throw markProviderRefusal(new Error("HTTP 400"));
        },
      ),
    ).rejects.toThrow(/400/);
    expect(renderAttempts.rows[0]).toMatchObject({
      usageOutcome: "failed",
      errorCode: "provider_refused",
      estimatedCostUsd: 0,
    });
    expect(await renderUsageTotals(db, "r")).toEqual({
      calls: 1,
      estimatedCostUsd: 0,
      unknownOutcomeCalls: 0,
    });
  });

  it("leaves an unmarked failure priced and unknown", async () => {
    await expect(
      measureProviderCall(
        db,
        render,
        {
          step: "inspecting_target",
          provider: "openai",
          model: "vision",
          estimatedCostUsd: 0.03,
        },
        async () => {
          throw new Error("timeout");
        },
      ),
    ).rejects.toThrow(/timeout/);
    expect(renderAttempts.rows[0]).toMatchObject({
      usageOutcome: "unknown",
      estimatedCostUsd: 0.03,
    });
  });

  it("recognises the marker only where it was set", () => {
    expect(isProviderRefusal(new Error("plain"))).toBe(false);
    expect(isProviderRefusal(markProviderRefusal(new Error("refused")))).toBe(
      true,
    );
    expect(isProviderRefusal(null)).toBe(false);
    expect(isProviderRefusal("refused")).toBe(false);
  });
});
