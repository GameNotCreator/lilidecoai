import "server-only";
import type { Db } from "mongodb";
import { durableContext, DurableExecutionError } from "./durable-context";
import {
  claimRender,
  endDurableRender,
  heartbeat,
  reserveDurableCredit,
  retryDurableRender,
  validateExecutionSources,
  reconcileRenderDeadline,
} from "./durable-queue";
import { executeDurableRender } from "./rendering";
import { RenderQualityError } from "./render-quality";
import { collections } from "./mongodb";
import { runPreparedViewTasks } from "./prepared-view-tasks";
import { effectiveRenderDeadline, STOREFRONT_RENDER_DEADLINE_MESSAGE } from "./storefront-render-deadline";

export async function runWorkerOnce(
  db: Db,
  workerId: string,
  options: { yieldAfterMs?: number } = {},
): Promise<boolean> {
  const render = await claimRender(db, workerId);
  if (!render?.execution?.token) {
    return (await runPreparedViewTasks(db, { limit: 1 })).processed > 0;
  }
  const token = render.execution.token;
  const startedAt = Date.now();
  const deadlineController = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  // The deadline is enforced independently of the provider promise. A slow or
  // disconnected provider cannot leave the browser waiting or keep a credit held.
  const expired = new Promise<void>((resolve, reject) => {
    deadlineTimer = setTimeout(() => {
      deadlineController.abort(new DurableExecutionError(STOREFRONT_RENDER_DEADLINE_MESSAGE, "deadline"));
      void reconcileRenderDeadline(db, render).then(() => resolve(), reject);
    }, Math.max(0, effectiveRenderDeadline(render) - Date.now()));
  });
  // Single flight renewal; no detached timer error can kill a healthy worker.
  let renewing = false;
  const timer = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void heartbeat(db, render, token)
      .catch(() => {
        console.error("render_worker_heartbeat_failed", {
          renderId: render.id,
        });
      })
      .finally(() => {
        renewing = false;
      });
  }, 20_000);
  try {
    const execution = durableContext.run(
      {
        render,
        token,
        signal: deadlineController.signal,
        ...(options.yieldAfterMs !== undefined
          ? { yieldAt: Date.now() + options.yieldAfterMs }
          : {}),
      },
      async () => {
        try {
          await validateExecutionSources(db, render);
          await reserveDurableCredit(db, render);
          await executeDurableRender(db, render);
        } catch (reason) {
          const current = await collections(db).renders.findOne({
            id: render.id,
            organizationId: render.organizationId,
          });
          // Includes an ambiguous transaction commit which actually succeeded.
          if (!current || !["queued", "processing"].includes(current.status))
            return;
          if (current.execution && effectiveRenderDeadline(current) <= Date.now()) {
            await reconcileRenderDeadline(db, current);
            return;
          }
          if (
            reason instanceof DurableExecutionError &&
            reason.code === "yield"
          ) {
            await retryDurableRender(db, render, reason.message, true);
            return;
          }
          if (
            reason instanceof DurableExecutionError &&
            reason.code === "lease_lost"
          )
            return;
          const message =
            reason instanceof Error ? reason.message : "Traitement interrompu.";
          const status =
            typeof reason === "object" && reason !== null && "status" in reason
              ? Number(reason.status)
              : 0;
          if (
            !(reason instanceof DurableExecutionError) &&
            [400, 401, 402, 403, 404, 422].includes(status)
          ) {
            await endDurableRender(
              db,
              render,
              "failed",
              message.slice(0, 500),
              "input_rejected",
              true,
            );
            return;
          }
          if (
            reason instanceof DurableExecutionError &&
            reason.code === "retry"
          ) {
            await retryDurableRender(db, render, message);
            return;
          }
          if (
            !(reason instanceof DurableExecutionError) &&
            !(reason instanceof RenderQualityError)
          ) {
            // Infrastructure failures may have happened during checkpointing.
            // Replaying sees a 'running' edit and stops without spending twice.
            await retryDurableRender(db, render, message);
            return;
          }
          await endDurableRender(
            db,
            render,
            "failed",
            message.slice(0, 500),
            reason instanceof DurableExecutionError
              ? reason.code
              : "quality_rejected",
            true,
          );
        }
      },
    );
    // Promise.race observes a provider that finishes late; its publication is
    // also fenced by the persisted deadline and terminal status.
    await Promise.race([execution, expired]);
  } finally {
    clearInterval(timer);
    clearTimeout(deadlineTimer);
    // Diagnose an early refusal without logging customer photos, prompts,
    // provider messages or credentials.
    const state = await collections(db).renders.findOne({
      id: render.id, organizationId: render.organizationId,
    }).catch(() => null);
    console.info("render_worker_finished", {
      renderId: render.id,
      status: state?.status ?? "unavailable",
      pipelineState: state?.pipelineState,
      errorCode: state?.execution?.errorCode,
      providerCalls: state?.usageTotals?.calls ?? 0,
      elapsedMs: Date.now() - startedAt,
    });
  }
  return true;
}
