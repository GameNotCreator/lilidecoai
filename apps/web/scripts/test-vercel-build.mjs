import assert from "node:assert/strict";
import { test } from "node:test";
import { runVercelBuild } from "./vercel-build.mjs";

const git = "a".repeat(40);
const revision = `sha256:${"b".repeat(64)}`;
const base = {
  VERCEL_ENV: "production",
  MONGODB_URI: "mongodb://localhost:27017",
  MONGODB_DB: "test",
  OPENAI_API_KEY: "test",
  ADMIN_USERNAME: "test",
  ADMIN_PASSWORD_HASH: "test",
  APP_SESSION_SECRET: "s".repeat(32),
  CRON_SECRET: "c".repeat(32),
  DEMO_MODE: "false",
  AI_MOCK_MODE: "false",
  OPENAI_IMAGE_ENABLED: "true",
  RENDER_EXECUTION_MODE: "durable",
  VERCEL_GIT_COMMIT_SHA: git,
};
function harness(env = {}, hasManifest = false, verifyError) {
  const calls = [];
  return {
    calls,
    options: {
      env: { ...base, ...env },
      cwd: process.cwd(),
      manifestExists: async () => hasManifest,
      verify: async (options) => {
        calls.push(["verify", options]);
        if (verifyError) throw verifyError;
      },
      execute: async (command, args) => {
        calls.push([command, args]);
      },
    },
  };
}
test("production performs only a read-only preflight then compilation", async () => {
  const h = harness();
  await runVercelBuild(h.options);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[0][1], [
    "scripts/production-preflight.mjs",
    "--runtime",
  ]);
  assert.deepEqual(h.calls[1][1], ["run", "build"]);
});
for (const flag of [
  "APPLY_IMAGE_PIPELINE_MIGRATION",
  "APPLY_ASSET_VISIBILITY_MIGRATION",
  "APPLY_NEW_MIGRATION",
])
  test(`${flag} is refused before any subprocess`, async () => {
    const h = harness({ [flag]: "true" });
    await assert.rejects(
      runVercelBuild(h.options),
      /automatic-migrations-disabled/,
    );
    assert.equal(h.calls.length, 0);
  });
test("content package verifies exact revision before remote checks", async () => {
  const h = harness({ RENDER_WORKER_REVISION: revision }, true);
  await runVercelBuild(h.options);
  assert.equal(h.calls[0][0], "verify");
  assert.equal(h.calls[0][1].expectedRevision, revision);
  assert.equal(h.calls[0][1].allowBuildOutput, true);
  assert.equal(h.calls.length, 3);
});
test("a modified package stops before preflight", async () => {
  const h = harness(
    { RENDER_WORKER_REVISION: revision },
    true,
    new Error("fingerprint differs"),
  );
  await assert.rejects(runVercelBuild(h.options), /fingerprint differs/);
  assert.equal(h.calls.length, 1);
});
test("content revision without manifest is refused", async () => {
  const h = harness({ RENDER_WORKER_REVISION: revision });
  await assert.rejects(
    runVercelBuild(h.options),
    /requires a verified release manifest/,
  );
  assert.equal(h.calls.length, 0);
});
test("package cannot silently inherit Git revision", async () => {
  const h = harness({}, true);
  await assert.rejects(runVercelBuild(h.options), /explicit content revision/);
  assert.equal(h.calls.length, 0);
});
test("failed preflight prevents compilation", async () => {
  const h = harness();
  h.options.execute = async (command, args) => {
    h.calls.push([command, args]);
    throw new Error("preflight failed");
  };
  await assert.rejects(runVercelBuild(h.options), /preflight failed/);
  assert.equal(h.calls.length, 1);
});
test("preview compilation never invokes production resource checks", async () => {
  const h = harness({ VERCEL_ENV: "preview" });
  await runVercelBuild(h.options);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0][1], ["run", "build"]);
});
