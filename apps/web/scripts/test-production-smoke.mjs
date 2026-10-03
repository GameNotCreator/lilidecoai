import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_IMAGE_MODEL, runProductionSmoke } from "./production-smoke.mjs";

const baseUrl = "https://store.example.test";
const sceneId = "11111111-1111-4111-8111-111111111111";
const assetId = "22222222-2222-4222-8222-222222222222";
const productId = "33333333-3333-4333-8333-333333333333";
const firstToken = "first.secret.token";
const secondToken = "second.secret.token";
const scenePath = "/v1/scenes/" + sceneId;
const imagePath = "/api/assets/" + assetId;
const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers });
function fixture(options = {}) {
  const calls = [], logs = [];
  let sessions = 0, deleted = false;
  const fetcher = async (url, init) => {
    const method = init.method ?? "GET", path = url.pathname;
    calls.push({ url: String(url), path, method, headers: init.headers, redirect: init.redirect, body: init.body });
    assert.equal(init.redirect, "manual");
    assert.ok(init.signal instanceof AbortSignal);
    if (method !== "GET") assert.equal(init.headers.get("origin"), url.origin);
    if (options.failTransport) throw Error(firstToken);
    if (path === "/v1/health") return json({ database: "mongodb", storage: "cloudinary", authentication: "required",
      imagePipeline: { mockMode: false, activeDemoProvider: options.provider ?? "openai",
        activeDemoModel: options.model ?? (options.provider === "myarchitectai" ? "edit-by-prompt" : DEFAULT_IMAGE_MODEL),
        executionMode: "durable", ...(options.legacyVision ? {} : { visionConfigured: options.vision ?? true }),
        openAIConfigured: options.openAIConfigured ?? true, openAIEnabled: options.openAIEnabled ?? true,
        myArchitectAIConfigured: options.myArchitectAIConfigured ?? true } });
    if (["/", "/panier", "/visualiser", "/login"].includes(path)) return new Response("page");
    if (path === "/v1/auth/guest") return json({}, options.guestStatus ?? 403);
    if (path === "/api/storefront/products") {
      assert.equal(init.headers.has("cookie"), false);
      assert.equal(init.headers.has("authorization"), false);
      return json({ store: { name: "LiliDeco" },
        products: options.products ?? [{ id: productId, visualizationAvailable: true }],
        visualization: { available: options.visualizationAvailable ?? true } }, 200, { "cache-control": "no-store" });
    }
    if (path === "/api/storefront/session") {
      assert.equal(init.headers.has("cookie"), false); // Actually creates independent sessions.
      const token = sessions++ === 0 || options.sameSession ? firstToken : secondToken;
      return json({ accessToken: token }, 201, { "cache-control": "no-store",
        "set-cookie": "lili_storefront_session=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400" + (options.insecureCookie ? "" : "; Secure") });
    }
    const owner = init.headers.get("cookie") === "lili_storefront_session=" + firstToken;
    const other = init.headers.get("authorization") === "Bearer " + secondToken;
    if (path === "/v1/render-capabilities") {
      assert.ok(owner);
      return json({ spatial: options.spatial ?? false });
    }
    if (["/v1/products", "/v1/renders", "/v1/credits", "/api/admin/overview", "/api/cron/purge", "/api/cron/render-worker", "/v1/admin/overview"].includes(path))
      return json({}, owner ? 403 : 401);
    if (path === "/v1/scenes" && method === "POST") {
      assert.ok(owner);
      assert.equal(init.body.get("consent"), "true");
      assert.equal(init.body.get("file").name, "production-smoke-synthetic.png");
      return json({ id: options.sceneId ?? sceneId, imageUrl: options.imageUrl ?? imagePath,
        expiresAt: options.expired ? "2020-01-01T00:00:00Z" : new Date(Date.now() + 86_400_000).toISOString() }, 201);
    }
    if (path === imagePath && method === "GET") {
      if (deleted) return json({}, 404);
      if (owner || (other && options.leak)) return new Response("image", { headers: { "content-type": "image/webp", "cache-control": "private, no-store" } });
      return json({}, 403);
    }
    if (path === scenePath) {
      if (method === "DELETE") {
        assert.ok(owner);
        if (options.cleanupNetworkFailure) throw Error(secondToken);
        if (options.deleteSupported) { deleted = true; return new Response(null, { status: 204 }); }
        return json({ detail: "Route scène introuvable" }, 404);
      }
      return other || deleted ? json({}, 404) : json({ id: sceneId, status: "uploaded" });
    }
    throw Error("Unexpected transport request");
  };
  return { calls, logs, fetcher, log: message => logs.push(message) };
}

test("storefront protocol: independent safe sessions, cookie/bearer isolation, no paid endpoints", async () => {
  const stub = fixture();
  const report = await runProductionSmoke({ baseUrl, ...stub, expectedExecutionMode: "durable" });
  assert.equal(report.status, "passed");
  assert.equal(report.paidGenerationCalls, 0);
  assert.equal(report.paidVisionCalls, 0);
  assert.equal(report.catalogProductCount, 1);
  assert.equal(report.eligibleProductCount, 1);
  assert.deepEqual(report.cleanup, { status: "retention-only", deleteStatus: 404,
    detail: "La scène synthétique reste privée jusqu’à son expiration." });
  assert.ok(Date.parse(report.expiresAt) > Date.now());
  assert.deepEqual(stub.calls.filter(call => call.method !== "GET").map(call => [call.method, call.path]), [
    ["POST", "/v1/auth/guest"], ["POST", "/api/storefront/session"], ["POST", "/api/storefront/session"],
    ["POST", "/v1/scenes"], ["DELETE", scenePath],
  ]);
  assert.ok(stub.calls.every(call => call.url.startsWith(baseUrl + "/")));
  const publicOutput = JSON.stringify({ report, logs: stub.logs });
  assert.ok(!publicOutput.includes(firstToken) && !publicOutput.includes(secondToken));
});

test("available visualization with three ineligible catalogue products fails before sessions or uploads", async () => {
  const products = [1, 2, 3].map(index => ({ id: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`, visualizationAvailable: false }));
  const stub = fixture({ products, visualizationAvailable: true });
  await assert.rejects(runProductionSmoke({ baseUrl, ...stub }), error => {
    assert.equal(error.code, "visualisation annoncée disponible avec au moins un produit éligible");
    assert.equal(error.report.status, "failed");
    assert.equal(error.report.catalogProductCount, 3);
    assert.equal(error.report.eligibleProductCount, 0);
    assert.equal(error.report.visualizationAvailable, true);
    assert.equal(error.report.cleanup.status, "not-needed");
    return true;
  });
  assert.equal(stub.calls.some(call => ["/api/storefront/session", "/v1/scenes"].includes(call.path)), false);
});

test("an empty catalogue cannot promise available visualization", async () => {
  const stub = fixture({ products: [], visualizationAvailable: true });
  await assert.rejects(runProductionSmoke({ baseUrl, ...stub }), error => {
    assert.equal(error.report.catalogProductCount, 0);
    assert.equal(error.report.eligibleProductCount, 0);
    return error.code === "visualisation annoncée disponible avec au moins un produit éligible";
  });
});

test("deliberately unavailable visualization accepts an empty or entirely ineligible catalogue", async () => {
  for (const products of [[], [{ id: productId, visualizationAvailable: false }]]) {
    const stub = fixture({ products, visualizationAvailable: false });
    const report = await runProductionSmoke({ baseUrl, ...stub });
    assert.equal(report.status, "passed");
    assert.equal(report.visualizationAvailable, false);
    assert.equal(report.catalogProductCount, products.length);
    assert.equal(report.eligibleProductCount, 0);
  }
});

test("eligible product count reflects individual availability rather than catalogue size", async () => {
  const stub = fixture({ products: [
    { id: productId, visualizationAvailable: true },
    { id: "44444444-4444-4444-8444-444444444444", visualizationAvailable: false },
  ] });
  const report = await runProductionSmoke({ baseUrl, ...stub });
  assert.equal(report.status, "passed");
  assert.equal(report.catalogProductCount, 2);
  assert.equal(report.eligibleProductCount, 1);
});

test("hybrid smoke verifies MyArchitectAI plus OpenAI capability without any generation or analysis", async () => {
  const stub = fixture({ provider: "myarchitectai" });
  const report = await runProductionSmoke({ baseUrl, ...stub, expectedImageProvider: "myarchitectai", expectedExecutionMode: "durable" });
  assert.equal(report.status, "passed");
  assert.equal(report.imageProvider, "myarchitectai");
  assert.equal(report.imageModel, "edit-by-prompt");
  assert.equal(report.paidGenerationCalls, 0);
  assert.equal(report.paidVisionCalls, 0);
  assert.equal(stub.calls.some(call => /render|analysis|preview/.test(call.path) && call.method === "POST"), false);
});

test("provider, vision and hybrid prerequisites cannot be substituted by a matching model name", async () => {
  for (const options of [
    { provider: "openai", model: "edit-by-prompt" },
    { provider: "myarchitectai", vision: false },
    { provider: "myarchitectai", myArchitectAIConfigured: false },
    { provider: "myarchitectai", openAIConfigured: false },
    { provider: "myarchitectai", openAIEnabled: false },
  ]) {
    const stub = fixture(options);
    await assert.rejects(runProductionSmoke({ baseUrl, ...stub, expectedImageProvider: "myarchitectai" }));
    assert.equal(stub.calls.some(call => call.path === "/v1/scenes"), false);
  }
});

test("legacy OpenAI health can report vision through openAIConfigured", async () => {
  const stub = fixture({ legacyVision: true });
  assert.equal((await runProductionSmoke({ baseUrl, ...stub })).status, "passed");
});

test("cleanup is confirmed only when the scene and its image are no longer readable", async () => {
  const stub = fixture({ deleteSupported: true });
  const report = await runProductionSmoke({ baseUrl, ...stub });
  assert.equal(report.cleanup.status, "deleted");
  assert.equal(report.cleanup.deleteStatus, 204);
  assert.equal(stub.calls.filter(call => call.method === "DELETE").length, 1);
});

test("cleanup still runs after an isolation failure and preserves the original failure", async () => {
  const stub = fixture({ leak: true });
  await assert.rejects(runProductionSmoke({ baseUrl, ...stub }), error => {
    assert.equal(error.code, "image interdite à une autre session");
    assert.equal(error.report.status, "failed");
    assert.equal(error.report.cleanup.status, "retention-only");
    assert.match(error.report.cleanup.detail, /non entièrement validées/);
    return true;
  });
  assert.deepEqual(stub.calls.filter(call => call.method === "DELETE").map(call => call.path), [scenePath]);
});

test("unsupported cleanup never masquerades as a deleted scene; network cleanup failure stays explicit", async () => {
  const stub = fixture({ cleanupNetworkFailure: true });
  const report = await runProductionSmoke({ baseUrl, ...stub });
  assert.equal(report.status, "passed");
  assert.equal(report.cleanup.status, "unconfirmed");
  assert.ok(!JSON.stringify(report).includes(secondToken));
});

test("unsafe origins and bypass destinations are rejected without network calls", async () => {
  for (const invalid of [
    { baseUrl: "http://store.example.test" }, { baseUrl: "https://secret@store.example.test" },
    { baseUrl: baseUrl + "/?token=secret" }, { baseUrl, bypassToken: "secret" },
    { baseUrl: "https://preview.vercel.app", bypassToken: "bad\nheader" }, { baseUrl, timeoutMs: 45_001 },
    { baseUrl, expectedImageProvider: "other" },
  ]) {
    const stub = fixture();
    await assert.rejects(runProductionSmoke({ ...invalid, ...stub }));
    assert.equal(stub.calls.length, 0);
  }
});

test("Vercel bypass is kept in headers and never exposed in the report or logs", async () => {
  const stub = fixture();
  const report = await runProductionSmoke({ baseUrl: "https://preview.vercel.app", bypassToken: "private-bypass", ...stub });
  assert.ok(stub.calls.every(call => call.headers.get("x-vercel-protection-bypass") === "private-bypass"));
  assert.ok(!JSON.stringify({ report, logs: stub.logs }).includes("private-bypass"));
});

test("a foreign photo URL receives no credentials and cleanup only targets the newly created scene", async () => {
  const stub = fixture({ imageUrl: "https://foreign.example.test" + imagePath, deleteSupported: true });
  await assert.rejects(runProductionSmoke({ baseUrl, ...stub }), error => {
    assert.equal(error.code, "photo servie par la même origine");
    assert.equal(error.report.cleanup.status, "unconfirmed");
    return true;
  });
  assert.ok(stub.calls.every(call => call.url.startsWith(baseUrl + "/")));
  assert.deepEqual(stub.calls.filter(call => call.method === "DELETE").map(call => call.path), [scenePath]);
});

test("malformed scene identifiers cannot turn cleanup into a different mutation", async () => {
  const stub = fixture({ sceneId: "../renders/secret" });
  await assert.rejects(runProductionSmoke({ baseUrl, ...stub }), error => error.code === "identifiant de scène borné");
  assert.equal(stub.calls.filter(call => call.method === "DELETE").length, 0);
});

test("closed legacy guest, safe cookie, distinct sessions and spatial gate are required before upload", async () => {
  for (const options of [{ guestStatus: 201 }, { insecureCookie: true }, { sameSession: true }, { spatial: true }, { model: "gpt-image-2" }]) {
    const stub = fixture(options);
    await assert.rejects(runProductionSmoke({ baseUrl, ...stub }));
    assert.equal(stub.calls.some(call => call.path === "/v1/scenes"), false);
  }
});

test("expired synthetic scenes fail validation and still attempt owner cleanup", async () => {
  const stub = fixture({ expired: true });
  await assert.rejects(runProductionSmoke({ baseUrl, ...stub }), error => error.code === "expiration de la scène enregistrée");
  assert.equal(stub.calls.filter(call => call.method === "DELETE").length, 1);
});

test("transport errors cannot disclose headers, server bodies or tokens", async () => {
  const stub = fixture({ failTransport: true });
  await assert.rejects(runProductionSmoke({ baseUrl, ...stub }), error => {
    assert.equal(error.message, "transport-failed");
    assert.ok(!JSON.stringify(error).includes(firstToken));
    return true;
  });
});
