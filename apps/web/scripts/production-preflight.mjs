import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { MongoClient } from "mongodb";
import { v2 as cloudinary } from "cloudinary";

// Read-only checks. Never print connection strings or provider credentials.
const filename = process.argv[2];
if (!filename)
  throw new Error("Passer le fichier d'environnement de production.");
const env =
  filename === "--runtime"
    ? process.env
    : parseEnv(readFileSync(filename, "utf8"));
const failures = [];
const check = (name, passed) => {
  console.log(`${passed ? "OK" : "FAIL"} ${name}`);
  if (!passed) failures.push(name);
};
for (const name of [
  "MONGODB_URI",
  "MONGODB_DB",
  "OPENAI_API_KEY",
  "ADMIN_USERNAME",
  "ADMIN_PASSWORD_HASH",
])
  check(`${name} configuré`, Boolean(env[name]?.trim()));
check(
  "secret de session : 32 caractères minimum",
  env.APP_SESSION_SECRET?.length >= 32,
);
check(
  "secret cron : 32 caractères minimum, distinct de la session",
  Boolean(
    env.CRON_SECRET?.length >= 32 && env.APP_SESSION_SECRET !== env.CRON_SECRET,
  ),
);
check("authentification production", env.DEMO_MODE === "false");
check(
  "IA réelle activée",
  env.AI_MOCK_MODE === "false" && env.OPENAI_IMAGE_ENABLED === "true",
);
const imageModel = env.OPENAI_MODEL || "gpt-image-2.5-sunburst";
check("modèle image GPT configuré", /^gpt-image-/.test(imageModel));
check("API servie par le même site", !env.NEXT_PUBLIC_API_URL);

for (const model of [imageModel, env.OPENAI_VISION_MODEL || "gpt-6-astra"]) {
  try {
    const response = await fetch(
      `${env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"}/models/${encodeURIComponent(model)}`,
      {
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
        signal: AbortSignal.timeout(15000),
      },
    );
    check(`accès au modèle ${model} (HTTP ${response.status})`, response.ok);
  } catch {
    check(`accès au modèle ${model}`, false);
  }
}

if (failures.length) process.exit(1);
const client = new MongoClient(env.MONGODB_URI, {
  serverSelectionTimeoutMS: 10000,
});
try {
  await client.connect();
  const db = client.db(env.MONGODB_DB);
  check("MongoDB joignable", (await db.command({ ping: 1 })).ok === 1);
  if (env.RENDER_EXECUTION_MODE === "durable") {
    const topology = await db.command({ hello: 1 });
    check(
      "transactions MongoDB disponibles",
      Boolean(topology.setName || topology.msg === "isdbgrid"),
    );
    check(
      "révision du worker figée",
      Boolean(
        env.VERCEL_GIT_COMMIT_SHA ||
        (env.RENDER_WORKER_REVISION && env.RENDER_WORKER_REVISION !== "local"),
      ),
    );
  }
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
      executionMode: env.RENDER_EXECUTION_MODE || "web",
    }),
  );
} catch {
  check("MongoDB joignable et inspectable", false);
} finally {
  await client.close();
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
