import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { database, mongoClient } from "../lib/server/mongodb";
import {
  assertDurableDatabase,
  boundedSetting,
  expireDurableRenders,
} from "../lib/server/durable-queue";
import { runWorkerOnce } from "../lib/server/render-worker";
import { renderWorkerRevision } from "../lib/render-worker-revision.mjs";

async function main() {
  if (process.argv.includes("--help")) {
    console.log(
      "npm run worker:render -- [--once]\nRequires a MongoDB replica set, the same environment/revision as the web app, and private durable asset storage.",
    );
    return;
  }
  if (process.env.NODE_ENV === "production")
    renderWorkerRevision(process.env, true);
  const db = await database();
  await assertDurableDatabase(db);
  const workerId = `${hostname()}:${process.pid}:${crypto.randomUUID()}`;
  let stopping = false;
  process.once("SIGTERM", () => {
    stopping = true;
  });
  process.once("SIGINT", () => {
    stopping = true;
  });
  const once = process.argv.includes("--once");
  let nextSweep = 0;
  await Promise.all(
    Array.from(
      { length: once ? 1 : boundedSetting("RENDER_WORKER_CONCURRENCY", 2, 16) },
      async () => {
        do {
          try {
            if (Date.now() >= nextSweep) {
              nextSweep = Date.now() + 30_000;
              await expireDurableRenders(db);
            }
            const worked = await runWorkerOnce(db, workerId);
            if (!worked && !once && !stopping) await sleep(2_000);
          } catch {
            // Credentials and source photographs never belong in worker logs.
            console.error("render_worker_iteration_failed");
            if (once) throw new Error("Worker iteration failed");
            if (!stopping) await sleep(5_000);
          }
        } while (!stopping && !once);
      },
    ),
  );
}

void main()
  .catch((reason: unknown) => {
    console.error(reason instanceof Error ? reason.message : "Worker failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    if (globalThis.__liliMongoClientPromise)
      await (await mongoClient()).close();
  });
