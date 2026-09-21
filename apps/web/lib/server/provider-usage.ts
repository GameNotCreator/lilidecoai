import "server-only";

import type { Db } from "mongodb";

import { serverConfig } from "./config";
import { collections } from "./mongodb";
import type { RenderDocument } from "./types";
import { durableStep } from "./durable-steps";

/**
 * One journal row per paid provider call, and a spending ceiling per render —
 * audit finding A13.
 *
 * A render used to report the cost of its final edit and nothing else: cutout
 * isolation, scale estimation, obstacle inspection and obstacle removal were
 * all paid for and invisible, and a call whose response was lost was recorded
 * as costing zero. Cost per accepted render could not be computed from that.
 *
 * Three rules here:
 *
 * 1. Every paid call is journaled, including the ones that fail. A call whose
 *    outcome is genuinely unknown — a timeout, an aborted request, a lost
 *    response — is recorded as `unknown` with its cost still counted. The
 *    provider may well have run it.
 * 2. The render carries the running total, so a diagnosis needs one document,
 *    not a join.
 * 3. Before each new paid step the accumulated cost is checked against the
 *    render budget. A job that has already spent its ceiling stops instead of
 *    continuing to spend.
 *
 * The amounts are estimates from local constants, not reconciled provider
 * invoices. They bound a runaway job; they do not close the books.
 */

export type UsageOutcome = "succeeded" | "failed" | "unknown";

export interface ProviderUsageInput {
  step: string;
  provider: string;
  model: string;
  outcome: UsageOutcome;
  estimatedCostUsd: number;
  latencyMs: number;
  attemptNumber?: number;
  promptVersion?: string;
  requestId?: string;
  errorCode?: string;
  error?: string;
  retryable?: boolean;
  degradedMode?: boolean;
  usage?: Record<string, unknown>;
}

export interface RenderUsageTotals {
  calls: number;
  estimatedCostUsd: number;
  /** Calls whose provider-side outcome could not be established. */
  unknownOutcomeCalls: number;
}

/** Ceiling for one render, all steps together. */
export function renderBudgetUsd(): number {
  const configured = Number(process.env.RENDER_MAX_COST_USD ?? "");
  if (Number.isFinite(configured) && configured > 0) return configured;
  // Four full-size edits' worth: enough for inspection, removal, the final
  // edit and one review, and far below anything a loop could reach.
  //
  // `openaiMaxCostUsd` comes from the environment through `Number(...)`, so a
  // malformed value is NaN — and `NaN > budget` is false, which would silently
  // disable every spending ceiling. A ceiling that fails open is not a ceiling.
  const perEdit = Number(serverConfig.openaiMaxCostUsd);
  return (Number.isFinite(perEdit) ? Math.max(perEdit, 0.05) : 0.25) * 4;
}

/**
 * Marks an error as a refusal the provider itself answered — a 4xx, a
 * moderation or safety block. Such a call is known and unbilled, so
 * `measureProviderCall` records it as `failed` at zero instead of `unknown`
 * at full price.
 *
 * It is a marker set by the call site, never a guess made here: only the code
 * that read the response knows whether the provider answered at all.
 */
const PROVIDER_REFUSAL = Symbol.for("lili.providerRefusal");

export function markProviderRefusal<T extends object>(error: T): T {
  return Object.assign(error, { [PROVIDER_REFUSAL]: true });
}

export function isProviderRefusal(reason: unknown): boolean {
  return (
    typeof reason === "object" &&
    reason !== null &&
    (reason as Record<symbol, unknown>)[PROVIDER_REFUSAL] === true
  );
}

export class RenderBudgetError extends Error {
  readonly status = 402;
  constructor(spentUsd: number, budgetUsd: number) {
    super(
      `Budget du rendu atteint (${spentUsd.toFixed(3)} / ${budgetUsd.toFixed(3)} USD). Le rendu est arrêté avant tout nouvel appel payant.`,
    );
  }
}

/**
 * Journal one call and add it to the render's running total. Never throws:
 * losing a measurement must not break the render it measures, and a failure
 * here is reported to the logs instead.
 */
export async function recordProviderUsage(
  db: Db,
  render: Pick<RenderDocument, "id" | "organizationId">,
  input: ProviderUsageInput,
): Promise<void> {
  const c = collections(db);
  try {
    await c.renderAttempts.insertOne({
      id: crypto.randomUUID(),
      organizationId: render.organizationId,
      renderId: render.id,
      provider: input.provider,
      model: input.model,
      // `render_attempts` predates this module and only knows two outcomes.
      // `usageOutcome` carries the third without rewriting old rows.
      status: input.outcome === "succeeded" ? "succeeded" : "failed",
      usageOutcome: input.outcome,
      stage: input.step,
      ...(input.attemptNumber !== undefined
        ? { attemptNumber: input.attemptNumber }
        : {}),
      ...(input.promptVersion ? { promptVersion: input.promptVersion } : {}),
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      ...(input.error ? { error: input.error.slice(0, 500) } : {}),
      ...(input.retryable !== undefined ? { retryable: input.retryable } : {}),
      ...(input.degradedMode !== undefined
        ? { degradedMode: input.degradedMode }
        : {}),
      ...(input.usage ? { usage: input.usage } : {}),
      latencyMs: input.latencyMs,
      estimatedCostUsd: input.estimatedCostUsd,
      createdAt: new Date(),
    });
    await c.renders.updateOne(
      { id: render.id },
      {
        $inc: {
          "usageTotals.calls": 1,
          "usageTotals.estimatedCostUsd": input.estimatedCostUsd,
          "usageTotals.unknownOutcomeCalls":
            input.outcome === "unknown" ? 1 : 0,
        },
      },
    );
  } catch (reason) {
    console.error("Provider usage journal failed", reason);
  }
}

export async function renderUsageTotals(
  db: Db,
  renderId: string,
): Promise<RenderUsageTotals> {
  const render = await collections(db).renders.findOne(
    { id: renderId },
    { projection: { usageTotals: 1 } },
  );
  return {
    calls: render?.usageTotals?.calls ?? 0,
    estimatedCostUsd: render?.usageTotals?.estimatedCostUsd ?? 0,
    unknownOutcomeCalls: render?.usageTotals?.unknownOutcomeCalls ?? 0,
  };
}

/**
 * Refuse the next paid step when this render has already spent its budget.
 * Call before the step, not after: the point is not to notice the overrun.
 */
export async function assertRenderBudget(
  db: Db,
  renderId: string,
  nextStepCostUsd: number,
): Promise<void> {
  const budget = renderBudgetUsd();
  const totals = await renderUsageTotals(db, renderId);
  if (totals.estimatedCostUsd + nextStepCostUsd > budget) {
    throw new RenderBudgetError(totals.estimatedCostUsd, budget);
  }
}

/**
 * Run one paid call, timing it and journaling the outcome either way.
 *
 * A thrown error is recorded as `unknown`, not as free: an aborted or timed
 * out request may well have been executed and billed on the provider side.
 * The exception is an error the call site marked with `markProviderRefusal` —
 * the provider answered and refused, so nothing was billed.
 */
export async function measureProviderCall<T>(
  db: Db,
  render: Pick<RenderDocument, "id" | "organizationId">,
  descriptor: Omit<
    ProviderUsageInput,
    "outcome" | "latencyMs" | "error" | "errorCode"
  >,
  call: () => Promise<T>,
): Promise<T> {
  return durableStep(db, `${descriptor.step}-${descriptor.attemptNumber ?? 1}`,
    descriptor.step === "removing_target" ? "image" : "analysis",
    () => measureUncachedProviderCall(db, render, descriptor, call));
}

async function measureUncachedProviderCall<T>(
  db: Db,
  render: Pick<RenderDocument, "id" | "organizationId">,
  descriptor: Omit<ProviderUsageInput, "outcome" | "latencyMs" | "error" | "errorCode">,
  call: () => Promise<T>,
): Promise<T> {
  await assertRenderBudget(db, render.id, descriptor.estimatedCostUsd);
  const startedAt = Date.now();
  try {
    const result = await call();
    await recordProviderUsage(db, render, {
      ...descriptor,
      outcome: "succeeded",
      latencyMs: Date.now() - startedAt,
    });
    return result;
  } catch (reason) {
    // A refusal the provider answered is known and unbilled. Anything else may
    // have reached the model, so it is `unknown` and its cost counts.
    const refused = isProviderRefusal(reason);
    const notCalled =
      typeof reason === "object" &&
      reason !== null &&
      "providerCalled" in reason &&
      reason.providerCalled === false;
    await recordProviderUsage(db, render, {
      ...descriptor,
      ...(refused || notCalled ? { estimatedCostUsd: 0 } : {}),
      outcome: refused || notCalled ? "failed" : "unknown",
      latencyMs: Date.now() - startedAt,
      error: reason instanceof Error ? reason.message : "Appel indisponible",
      errorCode: notCalled
        ? "provider_not_called"
        : refused
          ? "provider_refused"
          : "provider_outcome_unknown",
    });
    throw reason;
  }
}
