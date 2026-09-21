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
  if (
    !serverConfig.cronSecret ||
    request.headers.get("authorization") !== `Bearer ${serverConfig.cronSecret}`
  )
    return Response.json({ error: "Non autorisé" }, { status: 401 });
  if (!durableEnabled()) return Response.json({ enabled: false });
  const db = await database();
  await assertDurableDatabase(db);
  const expired = await expireDurableRenders(db);
  const results = await Promise.allSettled(
    Array.from(
      { length: boundedSetting("RENDER_WORKER_CONCURRENCY", 2, 4) },
      () =>
        runWorkerOnce(db, `vercel:${crypto.randomUUID()}`, {
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
