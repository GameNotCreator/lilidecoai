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
test("production performs a read-only preflight, compilation, then refreshes preflight", async () => {
  const h = harness();
  await runVercelBuild(h.options);
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.calls[0][1], [
    "scripts/production-preflight.mjs",
    "--runtime",
  ]);
  assert.deepEqual(h.calls[1][1], ["run", "build"]);
  assert.deepEqual(h.calls[2][1], ["scripts/production-preflight.mjs", "--runtime"]);
});
test("hybrid production verifies the selected provider before any runtime checks or compilation", async () => {
  const missing = harness({ SIMPLE_POINT_IMAGE_PROVIDER: "myarchitectai" });
  await assert.rejects(runVercelBuild(missing.options), /selected-image-provider-configured/);
  assert.equal(missing.calls.length, 0);
  const available = harness({ SIMPLE_POINT_IMAGE_PROVIDER: "myarchitectai", MYARCHITECTAI_API_KEY: "fixture-private-key" });
  await runVercelBuild(available.options);
  assert.deepEqual(available.calls.map(call => call[1]), [["scripts/production-preflight.mjs", "--runtime"], ["run", "build"], ["scripts/production-preflight.mjs", "--runtime"]]);
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
  assert.equal(h.calls.length, 4);
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
test("failed compilation stops without a second preflight", async () => {
  const h = harness();
  h.options.execute = async (command, args) => {
    h.calls.push([command, args]);
    if (args[0] === "run") throw new Error("build failed");
  };
  await assert.rejects(runVercelBuild(h.options), /build failed/);
  assert.deepEqual(h.calls.map(call => call[1]), [["scripts/production-preflight.mjs", "--runtime"], ["run", "build"]]);
});
test("a failed final preflight blocks completion even after a successful build", async () => {
  const h = harness();
  h.options.execute = async (command, args) => {
    h.calls.push([command, args]);
    if (h.calls.length === 3) throw new Error("active work appeared during build");
  };
  await assert.rejects(runVercelBuild(h.options), /active work appeared during build/);
  assert.deepEqual(h.calls.map(call => call[1]), [["scripts/production-preflight.mjs", "--runtime"], ["run", "build"], ["scripts/production-preflight.mjs", "--runtime"]]);
});
test("preview compilation never invokes production resource checks", async () => {
  const h = harness({ VERCEL_ENV: "preview" });
  await runVercelBuild(h.options);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0][1], ["run", "build"]);
});
