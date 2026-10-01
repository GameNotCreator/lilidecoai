import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Filter } from "mongodb";
import type { RenderDocument } from "./types";
import {
  effectiveRenderDeadline,
  storefrontRenderDeadlineExpired,
  STOREFRONT_RENDER_DEADLINE_MESSAGE,
} from "./storefront-render-deadline";

export const DURABLE_ENGINE_VERSION = "render-durable-v2";
export interface DurableContext {
  render: RenderDocument;
  token: string;
  yieldAt?: number;
  signal?: AbortSignal;
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
    readonly code:
      "lease_lost" | "retry" | "provider_unknown" | "permanent" | "yield" | "deadline",
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
  if (storefrontRenderDeadlineExpired(context.render))
    throw new DurableExecutionError(STOREFRONT_RENDER_DEADLINE_MESSAGE, "deadline");
  return {
    organizationId: context.render.organizationId,
    "execution.token": context.token,
    "execution.leaseUntil": { $gt: new Date() },
    "execution.deadlineAt": { $gt: new Date() },
  };
}

export function renderDeadline(startedAt: number): number {
  const render = durableContext.getStore()?.render;
  return render?.execution ? effectiveRenderDeadline(render) : startedAt + 285_000;
}

/** Each provider keeps its own timeout and also observes the shop's hard stop. */
export function durableAbortSignal(signal?: AbortSignal): AbortSignal | undefined {
  const deadlineSignal = durableContext.getStore()?.signal;
  return deadlineSignal
    ? signal
      ? AbortSignal.any([signal, deadlineSignal])
      : deadlineSignal
    : signal;
}

export function propagateDurableError(reason: unknown): void {
  if (reason instanceof DurableExecutionError) throw reason;
}
