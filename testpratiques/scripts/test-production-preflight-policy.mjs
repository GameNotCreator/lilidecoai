import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  evaluateProductionConfig,
  evaluateProductionDrainage,
  evaluateProductionIndexes,
  PRODUCTION_REQUIRED_INDEXES,
  DRAINAGE_COUNT_FIELDS,
} from "../../apps/web/scripts/production-preflight-policy.mjs";

const contentHash =
  "5f7c991bce266191d0618c6f999db584ec778c950c847eae4d9475b8d19f33f9";
const gitHash = "3769f9e6f13056ca6aa67edc654c68a48b1d4eb5";
function validEnv() {
  return {
    MONGODB_URI:
      "mongodb://private-user:private-password@private-db.invalid/database",
    MONGODB_DB: "private-db",
    OPENAI_API_KEY: "private-provider-key",
    APP_SESSION_SECRET: "s".repeat(32),
    CRON_SECRET: "c".repeat(32),
    DEMO_MODE: "false",
    AI_MOCK_MODE: "false",
    OPENAI_IMAGE_ENABLED: "true",
    RENDER_EXECUTION_MODE: "durable",
    RENDER_WORKER_REVISION: `sha256:${contentHash}`,
  };
}
const failed = (env, id) =>
  evaluateProductionConfig(env).checks.find((item) => item.id === id)
    ?.passed === false;

test("fixed administrator works without ADMIN credentials and ignores stale values", () => {
  for (const mode of [undefined, "", " fixed "])
    assert.equal(evaluateProductionConfig({ ...validEnv(), ADMIN_CREDENTIALS_MODE: mode,
      ADMIN_USERNAME: "obsolete", ADMIN_PASSWORD_HASH: "obsolete-hash", ADMIN_PASSWORD: "change-me" }).passed, true);
  for (const mode of ["env", "FIXED", null, true])
    assert.equal(failed({ ...validEnv(), ADMIN_CREDENTIALS_MODE: mode }, "admin-credentials-mode"), true);
});

test("explicit rotation requires valid credentials with hash precedence and never falls back", () => {
  const rotated = { ...validEnv(), ADMIN_CREDENTIALS_MODE: "environment" };
  const hash = "$2b$12$" + "A".repeat(53);
  assert.equal(failed(rotated, "admin-credentials-active"), true);
  for (const password of ["short", "change-me-long-password", "replace-with-new-password"])
    assert.equal(failed({ ...rotated, ADMIN_PASSWORD: password }, "admin-credentials-active"), true);
  assert.equal(evaluateProductionConfig({ ...rotated, ADMIN_PASSWORD: "private-rotation-password" }).passed, true);
  assert.equal(evaluateProductionConfig({ ...rotated, ADMIN_PASSWORD_HASH: hash, ADMIN_PASSWORD: "change-me" }).passed, true);
  assert.equal(failed({ ...rotated, ADMIN_PASSWORD_HASH: "invalid", ADMIN_PASSWORD: "private-rotation-password" }, "admin-credentials-active"), true);
  const serialized = JSON.stringify(evaluateProductionConfig({ ...rotated, ADMIN_USERNAME: "private-admin-name", ADMIN_PASSWORD_HASH: hash }));
  assert.equal(serialized.includes(hash), false);
  assert.equal(serialized.includes("private-admin-name"), false);
});

test("fixed account still requires a private APP secret and valid optional admin secret", () => {
  for (const secret of [undefined, "short", "replace-with-a-long-private-secret-2026"])
    assert.equal(failed({ ...validEnv(), APP_SESSION_SECRET: secret, ADMIN_SESSION_SECRET: "a".repeat(32) }, "session-secret"), true);
  for (const secret of ["short", "change-me-private-admin-secret-2026"])
    assert.equal(failed({ ...validEnv(), ADMIN_SESSION_SECRET: secret }, "admin-session-secret"), true);
  assert.equal(evaluateProductionConfig({ ...validEnv(), ADMIN_SESSION_SECRET: "a".repeat(32) }).passed, true);
});

test("concept store release disables merchant signup credit grants", () => {
  for (const value of [undefined, "", "false"])
    assert.equal(evaluateProductionConfig({ ...validEnv(), MERCHANT_SIGNUP_ENABLED: value }).passed, true);
  for (const value of ["true", "TRUE", " false", true, null])
    assert.equal(failed({ ...validEnv(), MERCHANT_SIGNUP_ENABLED: value }, "merchant-signup-disabled"), true);
});

test("normal release requires closed spatial admissions and reports only safe metadata", () => {
  const env = validEnv(),
    report = evaluateProductionConfig(env);
  assert.equal(report.passed, true);
  assert.equal(report.revision.credible, true);
  assert.equal(report.revision.identityVerified, false);
  const serialized = JSON.stringify(report);
  for (const value of Object.values(env).filter(
    (value) =>
      value.startsWith("private-") ||
      value.startsWith("mongodb:") ||
      value.startsWith("sha256:"),
  ))
    assert.equal(serialized.includes(value), false);
  assert.equal(serialized.includes(contentHash), false);
});

for (const [name, expected, id] of [
  ["DEMO_MODE", "false", "demo-disabled"],
  ["AI_MOCK_MODE", "false", "mocks-disabled"],
  ["OPENAI_IMAGE_ENABLED", "true", "image-provider-enabled"],
]) {
  test(`rejects malformed or missing ${name} instead of inferring ${expected}`, () => {
    for (const value of [
      undefined,
      "",
      "TRUE",
      "False",
      "0",
      "1",
      true,
      false,
      `"${expected}"`,
      ` ${expected}`,
      `${expected}\n`,
    ])
      assert.equal(
        failed({ ...validEnv(), [name]: value }, id),
        true,
        `${name}: ${String(value)}`,
      );
  });
}

test("accepts only an absent or truly empty spatial organization list", () => {
  for (const value of [undefined, "", "   "])
    assert.equal(
      evaluateProductionConfig({
        ...validEnv(),
        SPATIAL_ORGANIZATION_IDS: value,
      }).passed,
      true,
    );
  for (const value of [
    "organization",
    "org-one,org-two",
    "*",
    ",",
    ",,",
    "[]",
    '""',
    "false",
    true,
    null,
  ])
    assert.equal(
      failed(
        { ...validEnv(), SPATIAL_ORGANIZATION_IDS: value },
        "spatial-admissions-disabled",
      ),
      true,
    );
});

test("no environment override can approve an unqualified spatial allowlist", () => {
  assert.equal(
    evaluateProductionConfig({
      ...validEnv(),
      SPATIAL_ORGANIZATION_IDS: "internal-org",
      SPATIAL_PREFLIGHT_OVERRIDE: "true",
      ALLOW_UNQUALIFIED_SPATIAL: "true",
    }).passed,
    false,
  );
});

test("durable mode is mandatory and exact", () => {
  for (const mode of [
    undefined,
    "",
    "web",
    "Durable",
    " durable",
    "durable\n",
    true,
  ])
    assert.equal(
      failed(
        { ...validEnv(), RENDER_EXECUTION_MODE: mode },
        "durable-required",
      ),
      true,
    );
});

test("production stage capture cannot be enabled or ambiguously configured", () => {
  for (const value of [undefined, "", "false"])
    assert.equal(
      evaluateProductionConfig({ ...validEnv(), RENDER_STAGE_CAPTURE: value })
        .passed,
      true,
    );
  for (const value of ["true", "False", "0", true])
    assert.equal(
      failed(
        { ...validEnv(), RENDER_STAGE_CAPTURE: value },
        "capture-disabled",
      ),
      true,
    );
});

test("all automatic migration flags must be absent or explicitly off", () => {
  for (const name of [
    "APPLY_IMAGE_PIPELINE_MIGRATION",
    "APPLY_ASSET_VISIBILITY_MIGRATION",
    "APPLY_FUTURE_MIGRATION",
  ]) {
    assert.equal(
      evaluateProductionConfig({ ...validEnv(), [name]: "false" }).passed,
      true,
    );
    for (const value of ["true", "TRUE", "0", " false", true])
      assert.equal(
        failed(
          { ...validEnv(), [name]: value },
          "automatic-migrations-disabled",
        ),
        true,
      );
  }
});

test("explicit frozen-package identity takes precedence over a different Git HEAD", () => {
  const report = evaluateProductionConfig({
    ...validEnv(),
    VERCEL_GIT_COMMIT_SHA: gitHash,
  });
  assert.equal(report.passed, true);
  assert.deepEqual(report.revision, {
    source: "explicit",
    kind: "content-sha256",
    credible: true,
    identityVerified: false,
  });
});

test("invalid explicit revisions cannot fall back to valid Git metadata", () => {
  for (const value of [
    "",
    "local",
    "latest",
    "main",
    "release-v1",
    "sha256:abc",
    "deadbee",
    "0".repeat(40),
    "f".repeat(64),
    `sha256:${"0".repeat(64)}`,
    `sha256:${"f".repeat(64)}`,
    null,
    42,
  ]) {
    assert.equal(
      failed(
        {
          ...validEnv(),
          RENDER_WORKER_REVISION: value,
          VERCEL_GIT_COMMIT_SHA: gitHash,
        },
        "credible-revision",
      ),
      true,
    );
  }
});

test("full Git identity is accepted only under the shared immutable revision contract", () => {
  for (const revision of [gitHash, contentHash]) {
    assert.equal(
      evaluateProductionConfig({
        ...validEnv(),
        RENDER_WORKER_REVISION: revision,
      }).passed,
      true,
    );
    const env = validEnv();
    delete env.RENDER_WORKER_REVISION;
    env.VERCEL_GIT_COMMIT_SHA = revision;
    assert.equal(evaluateProductionConfig(env).passed, true);
  }
  const absent = validEnv();
  delete absent.RENDER_WORKER_REVISION;
  assert.equal(failed(absent, "credible-revision"), true);
  assert.equal(
    failed({ ...absent, VERCEL_GIT_COMMIT_SHA: "main" }, "credible-revision"),
    true,
  );
});

test("model requests cannot send credentials to a custom or malformed endpoint", () => {
  for (const endpoint of [
    "http://api.openai.com/v1",
    "https://attacker.invalid/v1",
    "https://api.openai.com@attacker.invalid/v1",
    "https://user:secret@api.openai.com/v1",
    "https://api.openai.com/v1?secret=credential",
    "https://api.openai.com/v1/extra",
  ])
    assert.equal(
      failed(
        { ...validEnv(), OPENAI_BASE_URL: endpoint },
        "official-model-endpoint",
      ),
      true,
    );
  assert.equal(
    evaluateProductionConfig({
      ...validEnv(),
      OPENAI_BASE_URL: "https://api.openai.com/v1/",
    }).passed,
    true,
  );
});

function validIndexes() {
  const result = {};
  for (const expected of PRODUCTION_REQUIRED_INDEXES)
    (result[expected.collection] ??= []).push({
      name: expected.name,
      key: expected.key,
      ...expected.options,
    });
  return result;
}

test("release indexes require runtime names, exact keys and safety options without writing anything", () => {
  const indexes = validIndexes(),
    before = JSON.stringify(indexes);
  assert.equal(evaluateProductionIndexes(indexes).passed, true);
  assert.equal(JSON.stringify(indexes), before);
  assert.equal(evaluateProductionIndexes({}).passed, false);
  assert.equal(evaluateProductionIndexes(null).passed, false);
  assert.equal(
    indexes.assets.find((item) => item.key.expiresAt)?.name,
    "asset_expiration_lookup",
  );
  assert.equal(
    indexes.renders.find((item) => item.key.id)?.name,
    "organizationId_1_id_1",
  );
});

for (const change of [
  "missing",
  "non-unique",
  "partial",
  "hidden",
  "ttl",
  "reordered",
  "renamed-expiration",
  "renamed-default",
  "name-collision",
]) {
  test(`rejects ${change} critical indexes`, () => {
    const indexes = validIndexes();
    const identity = indexes.renders.find(
      (item) => item.name === "organizationId_1_id_1",
    );
    if (change === "missing") indexes.renders = [];
    if (change === "non-unique") identity.unique = false;
    if (change === "partial")
      identity.partialFilterExpression = { status: "queued" };
    if (change === "hidden") identity.hidden = true;
    if (change === "ttl")
      indexes.assets.push({ key: { expiresAt: 1 }, expireAfterSeconds: 0 });
    if (change === "reordered") identity.key = { id: 1, organizationId: 1 };
    if (change === "renamed-expiration")
      indexes.assets.find((item) => item.key.expiresAt).name =
        "custom_expiration_lookup";
    if (change === "renamed-default") identity.name = "custom_identity";
    if (change === "name-collision") {
      identity.name = "custom_identity";
      indexes.renders.push({
        name: "organizationId_1_id_1",
        key: { id: 1 },
        unique: true,
      });
    }
    assert.equal(evaluateProductionIndexes(indexes).passed, false);
  });
}

test("a queued/processing/legacy/spatial/unknown job prevents a revision change", () => {
  const empty = Object.fromEntries(
    DRAINAGE_COUNT_FIELDS.map((name) => [name, 0]),
  );
  assert.equal(evaluateProductionDrainage(empty).passed, true);
  for (const name of DRAINAGE_COUNT_FIELDS) {
    assert.equal(
      evaluateProductionDrainage({ ...empty, [name]: 1 }).passed,
      false,
      name,
    );
    assert.equal(
      evaluateProductionDrainage({ ...empty, [name]: "0" }).passed,
      false,
    );
  }
  assert.equal(evaluateProductionDrainage({}).passed, false);
  assert.equal(evaluateProductionDrainage(null).passed, false);
  assert.equal(
    evaluateProductionDrainage({ ...empty, queued: -1 }).passed,
    false,
  );
});

test("CLI rejects unsafe configuration before network and never prints private values", () => {
  const env = {
    ...process.env,
    ...validEnv(),
    SPATIAL_ORGANIZATION_IDS: "private-organization",
  };
  const guard =
    "globalThis.fetch=()=>{console.error('NETWORK_SHOULD_NOT_BE_CALLED');throw Error('network forbidden')};";
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      `data:text/javascript,${encodeURIComponent(guard)}`,
      resolve("apps/web/scripts/production-preflight.mjs"),
      "--runtime",
    ],
    { env, encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL admissions spatiales/);
  const printed = result.stdout + result.stderr;
  for (const secret of [
    "private-organization",
    "private-provider-key",
    "private-password",
    "private-admin-hash",
    "private-db.invalid",
    "NETWORK_SHOULD_NOT_BE_CALLED",
  ])
    assert.equal(printed.includes(secret), false, secret);
});
