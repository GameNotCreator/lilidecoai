import { database, mongoClient } from "../lib/server/mongodb";
import { ensurePreparedViewIndexes } from "../lib/server/prepared-views";
async function main() {
  if (process.argv.includes("--help")) {
    console.log("Creates additive prepared-view indexes only. Does not approve views or enable rendering. Configure the intended MongoDB target before running.");
    return;
  }
  const db = await database();
  await ensurePreparedViewIndexes(db);
  await db.collection("oriented_preview_usage").createIndex({ organizationId: 1, createdAt: -1 });
  console.log("Prepared-view indexes ready. No catalogue approval or strategy activation performed.");
}
void main().catch(() => { console.error("Oriented-view migration failed; no strategy was activated."); process.exitCode = 1; }).finally(async () => {
  if (globalThis.__liliMongoClientPromise) await (await mongoClient()).close();
});
