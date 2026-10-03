import "server-only";
import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { collections } from "./mongodb";
import { transaction } from "./durable-queue";
import {
  durableContext,
  DurableExecutionError,
  executionFence,
} from "./durable-context";
import { durableStep } from "./durable-steps";
import {
  renderBudgetUsd,
  RenderBudgetError,
  isProviderRefusal,
} from "./provider-usage";
import {
  estimateVisionUsage,
  visionObservation,
} from "./ai/openai-vision-cost";
import type { RenderDocument } from "./types";
import type { ImageProviderResponseObservation } from "@lili/ai-router";

export async function recordOrientedImageResponse(
  db: Db,
  render: RenderDocument,
  key: string,
  observation: ImageProviderResponseObservation,
) {
  await transaction(db, async (session) => {
    const c = collections(db);
    const row = await c.renderAttempts.findOne(
      { id: `${render.id}:${key}`, organizationId: render.organizationId },
      { session },
    );
    if (!row)
      throw new DurableExecutionError(
        "Intention image introuvable.",
        "permanent",
      );
    await c.renderAttempts.updateOne(
      { id: row.id },
      {
        $set: {
          "usage.providerResponse": observation,
          usageOutcome: "succeeded",
          estimatedCostUsd: observation.estimatedCostUsd,
        },
      },
      { session },
    );
    await c.renders.updateOne(
      { id: render.id, organizationId: render.organizationId },
      {
        $inc: {
          "usageTotals.estimatedCostUsd":
            observation.estimatedCostUsd - row.estimatedCostUsd,
          "usageTotals.unknownOutcomeCalls":
            row.usageOutcome === "unknown" ? -1 : 0,
        },
      },
      { session },
    );
  });
}

interface ProviderGate {
  _id: string;
  token?: string;
  occupiedUntil: Date;
  nextStartAt: Date;
}
/** One shared provider departure lease, including catalogue preparation. */
export async function acquireOrientedProviderSlot(
  db: Db,
  provider: string,
  deadlineMs: number,
) {
  const gates = db.collection<ProviderGate>("oriented_provider_gates");
  try {
    await gates.updateOne(
      { _id: provider },
      {
        $setOnInsert: { occupiedUntil: new Date(0), nextStartAt: new Date(0) },
      },
      { upsert: true },
    );
  } catch (reason) {
    if (!(
      reason &&
      typeof reason === "object" &&
      "code" in reason &&
      reason.code === 11000
    ))
      throw reason;
  }
  const token = randomUUID(),
    now = new Date();
  const gate = await gates.findOneAndUpdate(
    { _id: provider, occupiedUntil: { $lte: now }, nextStartAt: { $lte: now } },
    {
      $set: {
        token,
        occupiedUntil: new Date(deadlineMs + 15_000),
        nextStartAt: new Date(Date.now() + 2_000),
      },
    },
    { returnDocument: "after" },
  );
  if (!gate)
    throw new DurableExecutionError(
      "Le fournisseur traite déjà une demande. Reprise différée.",
      "retry",
    );
  return async (rateLimited = false) => {
    await gates.updateOne(
      { _id: provider, token },
      {
        $set: {
          occupiedUntil: new Date(),
          ...(rateLimited
            ? { nextStartAt: new Date(Date.now() + 60_000) }
            : {}),
        },
        $unset: { token: "" },
      },
    );
  };
}

export interface OrientedCallDescriptor {
  key: string;
  provider: string;
  model: string;
  policy: "image" | "analysis";
  allowanceUsd: number;
  reserveAfterUsd: number;
  deadlineMs: number;
  promptVersion?: string;
}
/** Intention, provisional expense and journal are committed BEFORE the request. */
export async function orientedProviderCall<T>(
  db: Db,
  render: RenderDocument,
  descriptor: OrientedCallDescriptor,
  call: () => Promise<T>,
  recoverKnownImage?: (
    observation: ImageProviderResponseObservation,
  ) => Promise<T>,
): Promise<T> {
  if (!durableContext.getStore() || render.engine !== "oriented")
    throw new DurableExecutionError(
      "Contexte durable orienté requis.",
      "permanent",
    );
  if (
    ![descriptor.allowanceUsd, descriptor.reserveAfterUsd].every(
      (n) => Number.isFinite(n) && n >= 0,
    )
  )
    throw new Error("Allocation fournisseur invalide.");
  return durableStep(
    db,
    descriptor.key,
    descriptor.policy,
    async () => {
      if (descriptor.deadlineMs <= Date.now())
        throw new DurableExecutionError(
          "Délai fournisseur expiré.",
          "permanent",
        );
      const release = await acquireOrientedProviderSlot(
        db,
        descriptor.provider,
        descriptor.deadlineMs,
      );
      let rateLimited = false;
      try {
        let usageId = `${render.id}:${descriptor.key}`;
        await transaction(db, async (session) => {
          const c = collections(db);
          const current = await c.renders.findOne(
            { id: render.id, ...executionFence(render.id) },
            { session },
          );
          if (!current)
            throw new DurableExecutionError(
              "Bail expiré avant envoi.",
              "lease_lost",
            );
          // Vision retries may be billed; each bounded attempt owns its journal.
          // Image generation always keeps one immutable intention.
          if (descriptor.policy === "analysis")
            usageId = `${render.id}:${descriptor.key}:analysis-${current.execution?.steps[descriptor.key]?.attempts ?? 1}`;
          const prior = await c.renderAttempts.findOne(
            { id: usageId, organizationId: render.organizationId },
            { session },
          );
          if (prior)
            throw new DurableExecutionError(
              "Une intention fournisseur existe déjà : aucun nouvel envoi automatique.",
              "provider_unknown",
            );
          const spent = current.usageTotals?.estimatedCostUsd ?? 0;
          if (
            spent + descriptor.allowanceUsd + descriptor.reserveAfterUsd >
            renderBudgetUsd()
          )
            throw new RenderBudgetError(spent, renderBudgetUsd());
          await c.renderAttempts.insertOne(
            {
              id: usageId,
              organizationId: render.organizationId,
              renderId: render.id,
              usageAccountingVersion: 2,
              provider: descriptor.provider,
              model: descriptor.model,
              stage: descriptor.key,
              status: "failed",
              usageOutcome: "unknown",
              estimatedCostUsd: descriptor.allowanceUsd,
              latencyMs: 0,
              promptVersion: descriptor.promptVersion,
              usage: { intentPersisted: true, provisional: true },
              createdAt: new Date(),
            },
            { session },
          );
          const reserved = await c.renders.updateOne(
            {
              id: render.id,
              status: "processing",
              ...executionFence(render.id),
            },
            {
              $push: { usageCallIds: usageId },
              $inc: {
                "usageTotals.calls": 1,
                "usageTotals.estimatedCostUsd": descriptor.allowanceUsd,
                "usageTotals.unknownOutcomeCalls": 1,
                ...(descriptor.policy === "image" ? { attemptCount: 1 } : {}),
              },
            },
            { session },
          );
          if (!reserved.matchedCount)
            throw new DurableExecutionError(
              "Bail expiré avant allocation.",
              "lease_lost",
            );
        });
        const started = Date.now();
        let result: T | undefined, failure: unknown;
        try {
          result = await call();
        } catch (reason) {
          failure = reason;
        }
        const carrier = (failure ?? result) as
          | {
              estimatedCostUsd?: number;
              usage?: Record<string, unknown>;
              status?: number | string;
              error?: { httpStatus?: number };
              providerCalled?: boolean;
            }
          | undefined;
        rateLimited =
          carrier?.status === 429 || carrier?.error?.httpStatus === 429;
        const observation = visionObservation(failure ?? result);
        const providerOutcome = carrier?.usage?.providerOutcome;
        const notSent =
          carrier?.providerCalled === false ||
          isProviderRefusal(failure) ||
          providerOutcome === "not_sent";
        const known =
          !!observation ||
          notSent ||
          ["succeeded", "rejected"].includes(String(providerOutcome)) ||
          (!failure && carrier?.status !== "failed");
        const succeeded = !failure && carrier?.status !== "failed";
        const outcome = known
          ? succeeded
            ? "succeeded"
            : "failed"
          : "unknown";
        const price = observation
          ? estimateVisionUsage(observation, descriptor.allowanceUsd)
              .estimatedCostUsd
          : notSent
            ? 0
            : typeof carrier?.estimatedCostUsd === "number" &&
                Number.isFinite(carrier.estimatedCostUsd) &&
                carrier.estimatedCostUsd >= 0
              ? carrier.estimatedCostUsd
              : descriptor.allowanceUsd;
        // Reconciliation may outlive the execution lease. It may settle this exact
        // intention once, but can neither start another call nor deliver a render.
        await transaction(db, async (session) => {
          const c = collections(db);
          const pending = await c.renderAttempts.findOne(
            { id: usageId },
            { session },
          );
          const settled = await c.renderAttempts.updateOne(
            { id: usageId, "usage.provisional": true },
            {
              $set: {
                status: succeeded ? "succeeded" : "failed",
                usageOutcome: outcome,
                estimatedCostUsd: price,
                latencyMs: Date.now() - started,
                usage: {
                  ...pending?.usage,
                  ...carrier?.usage,
                  intentPersisted: true,
                  provisional: false,
                  ...(observation ? { providerUsage: observation.usage } : {}),
                },
              },
            },
            { session },
          );
          if (settled.matchedCount)
            await c.renders.updateOne(
              { id: render.id, organizationId: render.organizationId },
              {
                $inc: {
                  "usageTotals.estimatedCostUsd":
                    price -
                    (pending?.estimatedCostUsd ?? descriptor.allowanceUsd),
                  "usageTotals.unknownOutcomeCalls":
                    (known ? 0 : 1) -
                    (pending?.usageOutcome === "unknown" ? 1 : 0),
                },
              },
              { session },
            );
        });
        if (failure) throw failure;
        return result as T;
      } finally {
        await release(rateLimited);
      }
    },
    descriptor.policy === "analysis"
      ? { maxAttempts: 3, respectRetryable: true }
      : undefined,
    recoverKnownImage
      ? async () => {
          const row = await collections(db).renderAttempts.findOne({
            id: `${render.id}:${descriptor.key}`,
            organizationId: render.organizationId,
          });
          const observation = row?.usage?.providerResponse as
            ImageProviderResponseObservation | undefined;
          if (!observation || observation.outcome !== "succeeded")
            throw new DurableExecutionError(
              "L’issue fournisseur reste inconnue. Aucun nouvel envoi.",
              "provider_unknown",
            );
          let recovered: T | undefined, failure: unknown;
          try {
            recovered = await recoverKnownImage(observation);
          } catch (reason) {
            failure = reason;
          }
          const recoveredStatus = (recovered as { status?: string } | undefined)
            ?.status;
          const recoveredSuccessfully =
            !failure && recoveredStatus !== "failed";
          if (
            !Number.isFinite(observation.estimatedCostUsd) ||
            observation.estimatedCostUsd < 0
          )
            throw new DurableExecutionError(
              "Coût de la réponse conservée invalide.",
              "permanent",
            );
          // A persisted provider response is a known expense even if its GET
          // fails or the old worker loses its lease during download. Reconcile
          // only this existing intention; never reserve a second call. The
          // surrounding durableStep still fences checkpoint writes/delivery.
          await transaction(db, async (session) => {
            const c = collections(db);
            const pending = await c.renderAttempts.findOne(
              {
                id: row!.id,
                organizationId: render.organizationId,
                renderId: render.id,
                "usage.providerResponse.requestId": observation.requestId,
              },
              { session },
            );
            if (!pending)
              throw new DurableExecutionError(
                "La réponse privée à rapprocher a changé.",
                "permanent",
              );
            const successful =
              recoveredSuccessfully || pending.status === "succeeded";
            await c.renderAttempts.updateOne(
              { id: pending.id, organizationId: render.organizationId },
              {
                $set: {
                  status: successful ? "succeeded" : "failed",
                  usageOutcome: successful ? "succeeded" : "failed",
                  estimatedCostUsd: observation.estimatedCostUsd,
                  "usage.provisional": false,
                  ...(recoveredSuccessfully
                    ? { "usage.downloadRecovered": true }
                    : {}),
                },
              },
              { session },
            );
            await c.renders.updateOne(
              { id: render.id, organizationId: render.organizationId },
              {
                $inc: {
                  "usageTotals.estimatedCostUsd":
                    observation.estimatedCostUsd - pending.estimatedCostUsd,
                  "usageTotals.unknownOutcomeCalls":
                    pending.usageOutcome === "unknown" ? -1 : 0,
                },
              },
              { session },
            );
          });
          if (failure) throw failure;
          return recovered as T;
        }
      : undefined,
  );
}
