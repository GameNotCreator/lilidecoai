import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Filter } from "mongodb";
import type { RenderDocument } from "./types";

export const DURABLE_ENGINE_VERSION = "render-durable-v2";
export interface DurableContext {
  render: RenderDocument;
  token: string;
}
export const durableContext = new AsyncLocalStorage<DurableContext>();

export class DurableExecutionError extends Error {
  get status(): number {
    return this.code === "permanent"
      ? 422
      : this.code === "lease_lost"
        ? 409
        : 503;
  }
  constructor(
    message: string,
    readonly code: "lease_lost" | "retry" | "provider_unknown" | "permanent",
  ) {
    super(message);
  }
}

/** Every mutation by a worker is fenced, including after a slow provider call. */
export function executionFence(renderId: string): Filter<RenderDocument> {
  const context = durableContext.getStore();
  if (!context) return { execution: { $exists: false } };
  if (context.render.id !== renderId)
    throw new DurableExecutionError("Contexte de rendu invalide.", "permanent");
  return {
    organizationId: context.render.organizationId,
    "execution.token": context.token,
    "execution.leaseUntil": { $gt: new Date() },
    "execution.deadlineAt": { $gt: new Date() },
  };
}

export function renderDeadline(startedAt: number): number {
  return (
    durableContext.getStore()?.render.execution?.deadlineAt.getTime() ??
    startedAt + 285_000
  );
}

export function propagateDurableError(reason: unknown): void {
  if (reason instanceof DurableExecutionError) throw reason;
}
