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
