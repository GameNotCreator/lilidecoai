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
} from "./durable-queue";
import { executeDurableRender } from "./rendering";
import { RenderQualityError } from "./render-quality";
import { collections } from "./mongodb";
import {
  effectiveRenderDeadline,
  isTimedStorefrontRender,
  storefrontRenderDeadlineExpired,
  STOREFRONT_RENDER_DEADLINE_MESSAGE,
} from "./storefront-render-deadline";

export async function runWorkerOnce(
  db: Db,
  workerId: string,
  options: { yieldAfterMs?: number } = {},
): Promise<boolean> {
  const render = await claimRender(db, workerId);
  if (!render?.execution?.token) return false;
  const token = render.execution.token;
  const deadlineController = isTimedStorefrontRender(render)
    ? new AbortController()
    : null;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadlineFailure = deadlineController
    ? new Promise<never>((_resolve, reject) => {
        deadlineTimer = setTimeout(() => {
          const reason = new DurableExecutionError(
            STOREFRONT_RENDER_DEADLINE_MESSAGE,
            "deadline",
          );
          deadlineController.abort(reason);
          reject(reason);
        }, Math.max(0, effectiveRenderDeadline(render) - Date.now()));
      })
    : null;
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
    await durableContext.run(
      {
        render,
        token,
        ...(deadlineController ? { signal: deadlineController.signal } : {}),
        ...(options.yieldAfterMs !== undefined
          ? { yieldAt: Date.now() + options.yieldAfterMs }
          : {}),
      },
      async () => {
        try {
          const execute = async () => {
            await validateExecutionSources(db, render);
            await reserveDurableCredit(db, render);
            await executeDurableRender(db, render);
          };
          if (deadlineFailure) await Promise.race([execute(), deadlineFailure]);
          else await execute();
        } catch (reason) {
          const current = await collections(db).renders.findOne({
            id: render.id,
            organizationId: render.organizationId,
          });
          // Includes an ambiguous transaction commit which actually succeeded.
          if (!current || !["queued", "processing"].includes(current.status))
            return;
          if (
            storefrontRenderDeadlineExpired(current) ||
            (reason instanceof DurableExecutionError && reason.code === "deadline")
          ) {
            await endDurableRender(
              db, current, "failed", STOREFRONT_RENDER_DEADLINE_MESSAGE, "deadline",
            );
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
  } finally {
    clearInterval(timer);
    clearTimeout(deadlineTimer);
  }
  return true;
}
