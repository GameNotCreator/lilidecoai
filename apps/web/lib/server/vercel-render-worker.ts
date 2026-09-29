import { serverConfig } from "./config";
import { database } from "./mongodb";
import {
  assertDurableDatabase,
  boundedSetting,
  durableEnabled,
  expireDurableRenders,
} from "./durable-queue";
import { runWorkerOnce } from "./render-worker";

export async function runVercelRenderWorker(
  request: Request,
): Promise<Response> {
  const refused = workerAdmission(request);
  if (refused) return refused;
  return runWorkerBatch();
}

/**
 * The authenticated kick belongs to this dedicated 800-second route. The
 * admission route only awaits its acknowledgement; provider calls run in the
 * worker's own `after` lifetime, with the same leases/checkpoints as cron.
 */
export function scheduleVercelRenderWorker(
  request: Request,
  afterResponse: (task: () => Promise<void>) => void,
): Response {
  const refused = workerAdmission(request);
  if (refused) return refused;
  afterResponse(async () => {
    try {
      await runWorkerBatch();
    } catch {
      // The queued document remains durable and cron retries admission.
      // Do not log request headers, URLs or arbitrary infrastructure errors.
      console.error("render_worker_kick_failed");
    }
  });
  return Response.json(
    { enabled: true, scheduled: true },
    { status: 202, headers: { "Cache-Control": "no-store" } },
  );
}

function workerAdmission(request: Request): Response | null {
  if (
    !serverConfig.cronSecret ||
    request.headers.get("authorization") !== `Bearer ${serverConfig.cronSecret}`
  )
    return Response.json({ error: "Non autorisé" }, { status: 401 });
  if (!durableEnabled()) return Response.json({ enabled: false });
  return null;
}

async function runWorkerBatch(): Promise<Response> {
  const db = await database();
  await assertDurableDatabase(db);
  const expired = await expireDurableRenders(db);
  const results = await Promise.allSettled(
    Array.from(
      { length: boundedSetting("RENDER_WORKER_CONCURRENCY", 2, 4) },
      () =>
        runWorkerOnce(db, `vercel:${crypto.randomUUID()}`, {
          // Keep the existing margin under the route's 800s lifetime: a
          // provider call already started before yielding may run for minutes.
          yieldAfterMs: 300_000,
        }),
    ),
  );
  const errors = results.filter(
    (result) => result.status === "rejected",
  ).length;
  console.info("render_worker_tick", {
    expired,
    errors,
    processed: results.filter(
      (result) => result.status === "fulfilled" && result.value,
    ).length,
  });
  return Response.json(
    {
      enabled: true,
      expired,
      processed: results.filter(
        (result) => result.status === "fulfilled" && result.value,
      ).length,
      errors,
    },
    { status: errors ? 503 : 200 },
  );
}
