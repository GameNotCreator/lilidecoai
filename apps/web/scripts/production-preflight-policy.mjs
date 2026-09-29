// Pure release policy. Never return environment values, credentials or URIs.
import { inspectWorkerRevision } from "../lib/render-worker-revision.mjs";
export const PRODUCTION_PREFLIGHT_POLICY = "production-spatial-closed-v1";
export const PRODUCTION_DURABLE_ENGINE = "render-durable-v2";

const configured = (value) =>
  typeof value === "string" && value.trim().length > 0;

// Match server config normalization without returning any credential material.
const clean = value => {
  if (!configured(value)) return undefined;
  const trimmed = value.trim();
  return ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))) ? trimmed.slice(1, -1) : trimmed;
};
const placeholder = value => /^(replace-with|change-me)/.test(value.toLowerCase()) ||
  ["", "password", "admin"].includes(value.toLowerCase());
const privateSecret = value => Boolean(value && value.length >= 32 && !placeholder(value));
const bcryptHash = value => /^\$2[aby]?\$\d{2}\$[./A-Za-z0-9]{53}$/.test(value);

/** Explicit package identity wins. An invalid explicit value never falls back. */
export function productionRevisionMetadata(env) {
  const { source, kind, credible } = inspectWorkerRevision(env);
  return { source, kind, credible, identityVerified: false };
}

export function evaluateProductionConfig(env) {
  const checks = [];
  const check = (id, name, passed) =>
    checks.push({ id, name, passed: Boolean(passed) });
  for (const name of [
    "MONGODB_URI",
    "MONGODB_DB",
    "OPENAI_API_KEY",
  ])
    check(`configured-${name}`, `${name} configuré`, configured(env[name]));
  const adminMode = typeof env.ADMIN_CREDENTIALS_MODE === "string"
    ? env.ADMIN_CREDENTIALS_MODE.trim() || "fixed"
    : env.ADMIN_CREDENTIALS_MODE === undefined ? "fixed" : "invalid";
  const passwordHash = clean(env.ADMIN_PASSWORD_HASH)?.trim();
  const password = clean(env.ADMIN_PASSWORD)?.trim();
  check("admin-credentials-mode", "mode administrateur fixe ou rotation explicite",
    ["fixed", "environment"].includes(adminMode));
  check("admin-credentials-active", "compte administrateur disponible côté serveur",
    adminMode === "fixed" || (adminMode === "environment" &&
      (passwordHash ? bcryptHash(passwordHash) : Boolean(password && password.length >= 10 && !placeholder(password)))));
  check(
    "session-secret",
    "secret de session : 32 caractères minimum",
    privateSecret(clean(env.APP_SESSION_SECRET)),
  );
  check("admin-session-secret", "secret administrateur optionnel privé et valide",
    !configured(env.ADMIN_SESSION_SECRET) || privateSecret(clean(env.ADMIN_SESSION_SECRET)));
  check(
    "cron-secret",
    "secret cron : 32 caractères minimum et distinct de la session",
    configured(env.CRON_SECRET) &&
      env.CRON_SECRET.length >= 32 &&
      env.APP_SESSION_SECRET !== env.CRON_SECRET,
  );
  check(
    "demo-disabled",
    "authentification production explicite, démo désactivée",
    env.DEMO_MODE === "false",
  );
  check(
    "merchant-signup-disabled",
    "inscriptions marchandes avec crédits offertes désactivées",
    env.MERCHANT_SIGNUP_ENABLED === undefined || env.MERCHANT_SIGNUP_ENABLED === "" || env.MERCHANT_SIGNUP_ENABLED === "false",
  );
  check(
    "mocks-disabled",
    "mocks explicitement désactivés",
    env.AI_MOCK_MODE === "false",
  );
  check(
    "image-provider-enabled",
    "fournisseur image explicitement actif",
    env.OPENAI_IMAGE_ENABLED === "true",
  );
  check(
    "spatial-admissions-disabled",
    "admissions spatiales non qualifiées désactivées",
    env.SPATIAL_ORGANIZATION_IDS === undefined ||
      (typeof env.SPATIAL_ORGANIZATION_IDS === "string" &&
        env.SPATIAL_ORGANIZATION_IDS.trim() === ""),
  );
  check(
    "durable-required",
    "mode durable explicite",
    env.RENDER_EXECUTION_MODE === "durable",
  );
  check(
    "capture-disabled",
    "captures intermédiaires désactivées en production",
    env.RENDER_STAGE_CAPTURE === undefined ||
      env.RENDER_STAGE_CAPTURE === "" ||
      env.RENDER_STAGE_CAPTURE === "false",
  );
  const migrations = Object.entries(env).filter(([name]) =>
    /^APPLY_.*_MIGRATION$/.test(name),
  );
  check(
    "automatic-migrations-disabled",
    "aucune migration automatique pendant la publication",
    migrations.every(
      ([, value]) => value === undefined || value === "" || value === "false",
    ),
  );
  const revision = productionRevisionMetadata(env);
  check(
    "credible-revision",
    "révision explicite de paquet ou commit Git complet",
    revision.credible,
  );
  const imageModel = env.OPENAI_MODEL || "gpt-image-2.5-sunburst";
  const visionModel = env.OPENAI_VISION_MODEL || "gpt-6-astra";
  check(
    "image-model",
    "identifiant de modèle image GPT valide",
    typeof imageModel === "string" &&
      /^gpt-image-[a-z0-9][a-z0-9._-]{0,99}$/.test(imageModel),
  );
  check(
    "vision-model",
    "identifiant de modèle visuel valide",
    typeof visionModel === "string" &&
      /^[a-z0-9][a-z0-9._-]{0,99}$/.test(visionModel),
  );
  check(
    "same-site-api",
    "API servie par le même site",
    env.NEXT_PUBLIC_API_URL === undefined || env.NEXT_PUBLIC_API_URL === "",
  );
  let officialEndpoint = false;
  try {
    const url = new URL(env.OPENAI_BASE_URL || "https://api.openai.com/v1");
    officialEndpoint =
      url.protocol === "https:" &&
      url.hostname === "api.openai.com" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      ["/v1", "/v1/"].includes(url.pathname);
  } catch {
    /* Report only a static name, never the rejected URL. */
  }
  check(
    "official-model-endpoint",
    "contrôles modèles limités à l’API OpenAI officielle",
    officialEndpoint,
  );
  return {
    policy: PRODUCTION_PREFLIGHT_POLICY,
    passed: checks.every((item) => item.passed),
    checks,
    revision,
    scope:
      "Configuration seulement ; qualification spatiale, authenticité du paquet et publication non attestées.",
  };
}

// Names, exact key order and options must match runtime createIndex calls.
// Equivalent keys under another name still make createIndex fail. Never mutate here.
export const PRODUCTION_REQUIRED_INDEXES = [
  ["assets", "identity", { id: 1 }, { unique: true }],
  [
    "assets",
    "expiration-lookup",
    { expiresAt: 1 },
    { name: "asset_expiration_lookup" },
  ],
  ["products", "identity", { organizationId: 1, id: 1 }, { unique: true }],
  ["organizations", "identity", { id: 1 }, { unique: true }],
  ["organizations", "slug", { slug: 1 }, { unique: true }],
  ["products", "created", { organizationId: 1, createdAt: -1 }, {}],
  ["products", "status", { organizationId: 1, status: 1, updatedAt: -1 }, {}],
  [
    "products",
    "placement",
    {
      organizationId: 1,
      objectType: 1,
      placementType: 1,
      status: 1,
      updatedAt: -1,
    },
    {},
  ],
  [
    "products",
    "price",
    { organizationId: 1, priceCents: 1, updatedAt: -1 },
    {},
  ],
  ["products", "name", { organizationId: 1, name: 1 }, {}],
  ["scenes", "identity", { organizationId: 1, id: 1 }, { unique: true }],
  ["scenes", "public-session", { publicSessionId: 1 }, { sparse: true }],
  ["scenes", "expiration", { expiresAt: 1 }, { expireAfterSeconds: 0 }],
  ["calibrations", "identity", { organizationId: 1, id: 1 }, { unique: true }],
  ["renders", "identity", { organizationId: 1, id: 1 }, { unique: true }],
  ["renders", "public-session", { publicSessionId: 1 }, { sparse: true }],
  [
    "renders",
    "durable-claim",
    { "execution.configFingerprint": 1, status: 1, "execution.availableAt": 1 },
    {},
  ],
  ["renders", "durable-deadline", { "execution.deadlineAt": 1, status: 1 }, {}],
  [
    "renders",
    "idempotency",
    { organizationId: 1, idempotencyKey: 1 },
    { unique: true },
  ],
  ["render_dispatch", "global-lease", { key: 1 }, { unique: true }],
  ["render_attempts", "history", { organizationId: 1, createdAt: -1 }, {}],
  ["segmentations", "identity", { organizationId: 1, id: 1 }, { unique: true }],
  ["segmentations", "scene", { sceneId: 1, createdAt: -1 }, {}],
  ["render_feedback", "render", { organizationId: 1, renderId: 1 }, {}],
  ["rate_limits", "identity", { id: 1 }, { unique: true }],
  ["rate_limits", "expiration", { expiresAt: 1 }, { expireAfterSeconds: 0 }],
  ["wallets", "organization", { organizationId: 1 }, { unique: true }],
  [
    "credit_transactions",
    "idempotency",
    { organizationId: 1, idempotencyKey: 1 },
    { unique: true },
  ],
  ["users", "email", { email: 1 }, { unique: true }],
  ["analytics_events", "created", { organizationId: 1, createdAt: -1 }, {}],
  [
    "spatial_scene_cache",
    "expiration",
    { expiresAt: 1 },
    { expireAfterSeconds: 0 },
  ],
  [
    "spatial_source_reviews",
    "expiration",
    { expiresAt: 1 },
    { expireAfterSeconds: 0 },
  ],
].map(([collection, id, key, options]) => ({
  collection,
  id: `${collection}/${id}`,
  name:
    options.name ??
    Object.entries(key)
      .map(([field, direction]) => `${field}_${direction}`)
      .join("_"),
  key,
  options,
}));

export function evaluateProductionIndexes(indexesByCollection) {
  const checks = PRODUCTION_REQUIRED_INDEXES.map((required) => {
    const indexes = indexesByCollection?.[required.collection];
    const passed =
      Array.isArray(indexes) &&
      indexes.some(
        (index) =>
          index &&
          typeof index === "object" &&
          index.name === required.name &&
          JSON.stringify(index.key) === JSON.stringify(required.key) &&
          Boolean(index.unique) === Boolean(required.options.unique) &&
          Boolean(index.sparse) === Boolean(required.options.sparse) &&
          index.expireAfterSeconds === required.options.expireAfterSeconds &&
          !index.partialFilterExpression &&
          !index.hidden &&
          (!index.collation || index.collation.locale === "simple"),
      );
    return { id: required.id, name: `index ${required.id}`, passed };
  });
  checks.push({
    id: "assets/no-ttl",
    name: "aucun TTL MongoDB sur les métadonnées des images",
    passed:
      Array.isArray(indexesByCollection?.assets) &&
      indexesByCollection.assets.every(
        (index) => index && index.expireAfterSeconds === undefined,
      ),
  });
  return { passed: checks.every((item) => item.passed), checks };
}

export const DRAINAGE_COUNT_FIELDS = [
  "queued",
  "processing",
  "durableActive",
  "legacyOrUnknownExecutionActive",
  "activeWithoutExecution",
  "activeSpatial",
  "activeExpired",
  "activeProviderUnknown",
  "activeFingerprintVariants",
];

export function evaluateProductionDrainage(counts) {
  const valid = Boolean(
    counts &&
    typeof counts === "object" &&
    DRAINAGE_COUNT_FIELDS.every(
      (name) => Number.isSafeInteger(counts[name]) && counts[name] >= 0,
    ),
  );
  const checks = [
    {
      id: "drainage-counts",
      name: "compteurs de drainage disponibles et valides",
      passed: valid,
    },
    {
      id: "drainage-empty",
      name: "aucun rendu actif avant changement de révision",
      passed:
        valid && DRAINAGE_COUNT_FIELDS.every((name) => counts[name] === 0),
    },
  ];
  return {
    passed: checks.every((item) => item.passed),
    checks,
    scope:
      "Instantané en lecture seule, sans verrou d’admission : recontrôler immédiatement avant la bascule.",
  };
}
