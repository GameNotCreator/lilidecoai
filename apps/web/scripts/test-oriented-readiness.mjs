import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectOrientedConfiguration, orientedReadiness, probeOrientedServices, supportsTransactions } from "./oriented-readiness.mjs";
import { PINNED_SPATIAL_MATTING } from "./check-spatial-matting.mjs";

const env = {
  OPENAI_API_KEY: "private-vision-secret", MYARCHITECTAI_API_KEY: "private-image-secret", AI_MOCK_MODE: "false",
  RENDER_EXECUTION_MODE: "durable", MATTING_URL: "https://private-mask.example", MATTING_TOKEN: "private-mask-secret",
  ORIENTED_ORGANIZATION_IDS: "internal-org", ORIENTED_PRODUCT_IDS: "grenade", ORIENTED_PREPARATION_ENABLED: "true",
  ORIENTED_PREPARATION_ORGANIZATION_IDS: "internal-org", ORIENTED_PREPARATION_PRODUCT_IDS: "grenade",
  ORIENTED_PREVIEW_MAX_COST_USD: "1", RENDER_MAX_COST_USD: "2", ORIENTED_PREPARATION_MAX_COST_USD: "1",
  ORIENTED_PREPARATION_PROVIDER_COST_USD: "0.03",
};

test("configuration reports cannot leak secrets or claim render qualification", async () => {
  const report = await orientedReadiness(env);
  assert.equal(report.configurationComplete, true);
  assert.equal(report.servicesAvailable, false);
  assert.equal(report.qualification, "unverified");
  assert.equal(report.providerCalls, 0);
  assert.equal(report.writes, 0);
  const serialized = JSON.stringify(report);
  for (const secret of [env.OPENAI_API_KEY, env.MYARCHITECTAI_API_KEY, env.MATTING_TOKEN, env.MATTING_URL, env.ORIENTED_ORGANIZATION_IDS]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("closed defaults and underallocated provider calls fail readiness", () => {
  assert.equal(inspectOrientedConfiguration({}).every((check) => check.passed), false);
  for (const value of ["NaN", "Infinity", "-1", "0", "0.02"]) {
    assert.equal(inspectOrientedConfiguration({ ...env, ORIENTED_PREPARATION_PROVIDER_COST_USD: value })
      .find((check) => check.id === "preparation-budget").passed, false);
  }
  assert.equal(inspectOrientedConfiguration({ ...env, MYARCHITECTAI_EDIT_COST_USD: "0.1" })
    .find((check) => check.id === "preparation-budget").passed, false);
});

test("runtime mode and pilot allowlists cannot yield a false positive", () => {
  for (const mode of [" durable ", '"durable"', "web"]) {
    assert.equal(inspectOrientedConfiguration({ ...env, RENDER_EXECUTION_MODE: mode })
      .find((check) => check.id === "durable").passed, false);
  }
  assert.equal(inspectOrientedConfiguration({ ...env, ORIENTED_PREPARATION_PRODUCT_IDS: "different-product" })
    .find((check) => check.id === "shared-pilot").passed, false);
});

test("a reachable standalone database does not prove transaction support", () => {
  assert.equal(supportsTransactions({ logicalSessionTimeoutMinutes: 30 }), false);
  assert.equal(supportsTransactions({ setName: "test", logicalSessionTimeoutMinutes: 30 }), true);
  assert.equal(supportsTransactions({ msg: "isdbgrid", logicalSessionTimeoutMinutes: 30 }), true);
  assert.equal(supportsTransactions({ setName: "test" }), false);
});

test("probes only read hello and health and close their database connection", async () => {
  const calls = [];
  class FakeMongoClient {
    async connect() { calls.push("connect"); }
    db(name) { assert.equal(name, "admin"); return { command: async (command) => {
      assert.deepEqual(command, { hello: 1 }); calls.push("hello");
      return { setName: "test", logicalSessionTimeoutMinutes: 30 };
    } }; }
    async close() { calls.push("close"); }
  }
  const probes = await probeOrientedServices(env, { MongoClient: FakeMongoClient, fetcher: async (url, options) => {
    assert.equal(url.pathname, "/health");
    assert.equal(options.method, undefined);
    assert.equal(options.redirect, "error");
    calls.push("health");
    return Response.json({ ready: true, busy: false, model: PINNED_SPATIAL_MATTING.model,
      modelSha256: PINNED_SPATIAL_MATTING.modelSha256, runtime: PINNED_SPATIAL_MATTING.runtime });
  } });
  assert.equal(probes.every((probe) => probe.passed), true);
  assert.deepEqual(calls, ["connect", "hello", "close", "health"]);
});

test("failed probes sanitize errors and never call an invalid mask URL", async () => {
  class FailedMongoClient {
    async connect() { throw new Error(env.OPENAI_API_KEY); }
    async close() {}
  }
  const probes = await probeOrientedServices({ ...env, MATTING_URL: "http://external.example" }, {
    MongoClient: FailedMongoClient, fetcher: () => assert.fail("Unexpected request"),
  });
  assert.equal(probes.every((probe) => !probe.passed), true);
  assert.equal(JSON.stringify(probes).includes(env.OPENAI_API_KEY), false);
});
