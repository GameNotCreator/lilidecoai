import { parseArgs } from "node:util";
import { MongoClient } from "mongodb";
import {
  auditMongoStorage,
  migrateR2Assets,
  MigrationPreflightError,
} from "../lib/server/r2-asset-migration";
import { getR2Storage } from "../lib/server/r2-storage";

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean" },
      limit: { type: "string", default: "200" },
      site: { type: "string" },
    },
  });
  if (values.help) {
    console.log(
      "npm run migrate:r2-assets -- [audit|copy|prune|restore] [--limit 200] [--site https://…]",
    );
    return;
  }
  const [mode = "audit"] = positionals;
  if (
    positionals.length > 1 ||
    (mode !== "audit" &&
      mode !== "copy" &&
      mode !== "prune" &&
      mode !== "restore")
  ) {
    throw new MigrationPreflightError("Opération inconnue. Utilisez --help.");
  }
  const limit = Number(values.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new MigrationPreflightError("Indiquez une limite entre 1 et 1000.");
  }
  const uri = process.env.MONGODB_URI?.trim();
  const dbName = process.env.MONGODB_DB?.trim();
  if (!uri || !dbName)
    throw new MigrationPreflightError("Configurez MONGODB_URI et MONGODB_DB.");
  const storage = mode === "audit" ? null : getR2Storage();
  if (mode !== "audit" && !storage)
    throw new MigrationPreflightError("Configuration R2 incomplète.");

  const mongo = new MongoClient(uri, {
    appName: "lilidecoai-r2-asset-migration",
    maxPoolSize: 2,
    serverSelectionTimeoutMS: 8_000,
    writeConcern: { w: "majority" },
  });
  try {
    await mongo.connect();
    const db = mongo.db(dbName);
    if (mode === "audit") {
      console.log(JSON.stringify(await auditMongoStorage(db), null, 2));
    } else if (storage) {
      const result = await migrateR2Assets(db, storage, {
        mode,
        limit,
        site: values.site,
      });
      console.log(JSON.stringify(result, null, 2));
      if (result.failed || result.cleanupFailures) process.exitCode = 1;
    }
  } finally {
    await mongo.close();
  }
}

void main().catch((reason: unknown) => {
  // MongoDB and transport exceptions can contain credentials or URLs.
  const message =
    reason instanceof MigrationPreflightError
      ? reason.message
      : "Opération interrompue. Vérifiez l’accès au cluster et la configuration R2.";
  console.error(message);
  process.exitCode = 1;
});
