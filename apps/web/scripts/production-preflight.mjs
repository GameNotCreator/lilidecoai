import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { MongoClient } from "mongodb";
import { v2 as cloudinary } from "cloudinary";
import {
  evaluateProductionConfig,
  evaluateProductionIndexes,
  evaluateProductionDrainage,
  PRODUCTION_REQUIRED_INDEXES,
  PRODUCTION_DURABLE_ENGINE,
} from "./production-preflight-policy.mjs";

// Read-only checks. Never print connection strings or provider credentials.
let env;
try {
  const filename = process.argv[2];
  if (!filename || process.argv.length !== 3) throw new Error();
  env =
    filename === "--runtime"
      ? process.env
      : parseEnv(readFileSync(filename, "utf8"));
} catch {
  console.error(
    "Passer un unique fichier d’environnement lisible ou --runtime. Son contenu n’est jamais journalisé.",
  );
  process.exit(1);
}
const failures = [];
const check = (name, passed) => {
  console.log(`${passed ? "OK" : "FAIL"} ${name}`);
  if (!passed) failures.push(name);
};
const config = evaluateProductionConfig(env);
for (const item of config.checks) check(item.name, item.passed);
console.log(
  JSON.stringify({
    policy: config.policy,
    revision: config.revision,
    imageProvider: config.imageProvider,
    openAIImageAndVisionRequired: true,
    myArchitectAIAuthentication: config.imageProvider === "myarchitectai" ? "credential-present-not-tested" : "not-selected",
    spatialQualification: "not-qualified",
    spatialAdmissionsRequired: "disabled",
    scope: config.scope,
  }),
);
// Reject unsafe release configuration before any database or provider access.
if (!config.passed) process.exit(1);
// OpenAI remains required for multi-object generation and vision when MyArchitectAI
// handles a single object. GET checks do not invoke either paid image API.
const imageModel = env.OPENAI_MODEL || "gpt-image-2.5-sunburst";
for (const [label, model] of [
  ["image", imageModel],
  ["image boutique", env.STOREFRONT_IMAGE_MODEL || "gpt-image-2.5-sunburst"],
  ["vision", env.OPENAI_VISION_MODEL || "gpt-6-astra"],
]) {
  try {
    const response = await fetch(
      `${(env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "")}/models/${encodeURIComponent(model)}`,
      {
        method: "GET",
        redirect: "error",
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
        signal: AbortSignal.timeout(15000),
      },
    );
    check(
      `accès au modèle ${label} par GET (HTTP ${response.status})`,
      response.ok,
    );
    await response.body?.cancel().catch(() => {});
  } catch {
    check(`accès au modèle ${label} par GET`, false);
  }
}

let client;
try {
  // Do not import database(): it creates indexes and drops a legacy TTL index.
  client = new MongoClient(env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
  });
  await client.connect();
  const db = client.db(env.MONGODB_DB);
  check("MongoDB joignable", (await db.command({ ping: 1 })).ok === 1);
  const topology = await db.command({ hello: 1 });
  check(
    "transactions MongoDB disponibles",
    Boolean(topology.setName || topology.msg === "isdbgrid"),
  );
  const legacyProducts = await db.collection("products").countDocuments({
    assetId: { $type: "string" },
    views: { $exists: false },
  });
  const legacyRenders = await db.collection("renders").countDocuments({
    $or: [
      { pipelineState: { $exists: false } },
      { mode: { $exists: false } },
      { promptVersion: { $exists: false } },
    ],
  });
  console.log(JSON.stringify({ migration: { legacyProducts, legacyRenders } }));
  check(
    "migration image déjà appliquée",
    legacyProducts === 0 && legacyRenders === 0,
  );
  const missingVisibility = await db
    .collection("assets")
    .countDocuments({ visibility: { $exists: false } });
  check("propriété des images migrée", missingVisibility === 0);
  console.log(
    JSON.stringify({
      catalogue: {
        missingVisibility,
        syntheticCutouts: await db.collection("products").countDocuments({
          $or: [{ "cutout.synthetic": true }, { "cutout.source": "model" }],
        }),
        unknownCutoutProvenance: await db
          .collection("products")
          .countDocuments({
            cutoutAssetId: { $exists: true },
            "cutout.cutoutVersion": { $exists: false },
          }),
      },
      executionMode: "durable",
    }),
  );
  const indexes = {};
  for (const collection of new Set(
    PRODUCTION_REQUIRED_INDEXES.map((item) => item.collection),
  )) {
    try {
      indexes[collection] = await db
        .collection(collection)
        .listIndexes()
        .toArray();
    } catch (error) {
      if (error?.code === 26) indexes[collection] = [];
      else throw error;
    }
  }
  const indexPolicy = evaluateProductionIndexes(indexes);
  for (const item of indexPolicy.checks) check(item.name, item.passed);
  console.log(
    JSON.stringify({
      indexes: {
        inspectedCollections: Object.keys(indexes).length,
        required: PRODUCTION_REQUIRED_INDEXES.length,
        missingOrInvalid: indexPolicy.checks
          .filter((item) => !item.passed)
          .map((item) => item.id),
        writesPerformed: 0,
      },
    }),
  );
  const active = { status: { $in: ["queued", "processing"] } };
  const count = (filter) =>
    db.collection("renders").countDocuments(filter, { maxTimeMS: 15000 });
  const preparedCount = (filter) =>
    db.collection("prepared_view_tasks").countDocuments(filter, { maxTimeMS: 15000 });
  const [
    queued,
    processing,
    durableActive,
    legacyOrUnknownExecutionActive,
    activeWithoutExecution,
    activeSpatial,
    activeExpired,
    activeProviderUnknown,
    fingerprintGroups,
    preparedQueued,
    preparedPreparing,
    preparedProviderUnknown,
  ] = await Promise.all([
    count({ status: "queued" }),
    count({ status: "processing" }),
    count({ ...active, "execution.version": PRODUCTION_DURABLE_ENGINE }),
    count({
      ...active,
      execution: { $exists: true },
      "execution.version": { $ne: PRODUCTION_DURABLE_ENGINE },
    }),
    count({ ...active, execution: { $exists: false } }),
    count({ ...active, engine: "spatial" }),
    count({ ...active, "execution.deadlineAt": { $lte: new Date() } }),
    count({ ...active, "execution.errorCode": "provider_unknown" }),
    db
      .collection("renders")
      .aggregate(
        [
          { $match: active },
          { $group: { _id: "$execution.configFingerprint" } },
          { $count: "variants" },
        ],
        { maxTimeMS: 15000 },
      )
      .toArray(),
    preparedCount({ state: "queued" }),
    preparedCount({ state: "preparing" }),
    preparedCount({ $or: [{ state: "unknown" }, { "provider.state": { $in: ["sent", "unknown"] } }] }),
  ]);
  const drainage = {
    queued,
    processing,
    durableActive,
    legacyOrUnknownExecutionActive,
    activeWithoutExecution,
    activeSpatial,
    activeExpired,
    activeProviderUnknown,
    activeFingerprintVariants: fingerprintGroups[0]?.variants ?? 0,
    preparedQueued,
    preparedPreparing,
    preparedProviderUnknown,
  };
  const drainPolicy = evaluateProductionDrainage(drainage);
  for (const item of drainPolicy.checks) check(item.name, item.passed);
  console.log(
    JSON.stringify({ drainage, scope: drainPolicy.scope, writesPerformed: 0 }),
  );
} catch {
  check("MongoDB joignable et inspectable", false);
} finally {
  await client?.close().catch(() => {});
}
try {
  if (env.CLOUDINARY_URL) {
    const url = new URL(env.CLOUDINARY_URL);
    cloudinary.config({
      cloud_name: url.hostname,
      api_key: decodeURIComponent(url.username),
      api_secret: decodeURIComponent(url.password),
      secure: true,
    });
  } else
    cloudinary.config({
      cloud_name: env.CLOUDINARY_CLOUD_NAME,
      api_key: env.CLOUDINARY_API_KEY,
      api_secret: env.CLOUDINARY_API_SECRET,
    });
  check(
    "Cloudinary authentifié",
    (await cloudinary.api.ping()).status === "ok",
  );
} catch {
  check("Cloudinary authentifié", false);
}
process.exitCode = failures.length ? 1 : 0;
