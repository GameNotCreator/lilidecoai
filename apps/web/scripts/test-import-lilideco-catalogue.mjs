import assert from "node:assert/strict";
import test from "node:test";
import { importDrafts, importPlan, localOrigin } from "./import-lilideco-catalogue.mjs";
import { readFile } from "node:fs/promises";

const sourceManifest = JSON.parse(await readFile(new URL("../../../docs/data/lilideco-catalogue-2026-09-29.json", import.meta.url)));
// Exercise upload/idempotency with a committed public product fixture, without
// requiring the private research artifact folder in a fresh checkout.
const manifest = { ...sourceManifest, products: sourceManifest.products.map((product) => ({
  ...product, localImage: "apps/web/tests/fixtures/catalogue/grenade-noire-blanche.jpg",
})) };
test("missing dimensions stay pending; known source observations never become inventory", () => {
  const rows = importPlan(manifest);
  assert.equal(rows.filter((row) => row.payload).length, 4);
  assert.equal(rows.filter((row) => !row.payload).length, 5);
  assert.ok(rows.filter((row) => row.payload).every((row) => row.payload.stock === null));
  assert.equal(rows[0].payload.priceCents, 11500);
  assert.match(rows[0].payload.description, /Disponibilité à confirmer auprès de ByLiliDeco/);
  assert.doesNotMatch(JSON.stringify(rows[0].payload), /ileycom/i);
  assert.equal(rows[0].payload.sku, "BLD-375567");
  assert.equal(rows[0].payload.buyUrl, null);
  assert.match(rows[0].payload.visualizationBlockedReason, /céramique claire/);
  assert.ok(rows.filter((row) => row.payload).every((row) => row.payload.visualizationBlockedReason));
  assert.equal(rows.find((row) => row.sourceId === "248771").payload, null);
});
test("only literal loopback HTTP origins are admitted", () => {
  for (const url of ["https://production.example", "http://127.0.0.1.evil.test", "http://user:pass@localhost", "http://localhost/api", "http://localhost/?next=prod"]) assert.throws(() => localOrigin(url));
  assert.equal(localOrigin("http://127.0.0.1:3120"), "http://127.0.0.1:3120");
});
test("duplicate ids and image path traversal are rejected before calls", () => {
  assert.throws(() => importPlan({ ...manifest, products: [manifest.products[0], manifest.products[0]] }));
  assert.throws(() => importPlan({ ...manifest, products: [{ ...manifest.products[0], localImage: "../../../secret.jpg" }] }));
  assert.throws(() => importPlan({ ...manifest, products: [{ ...manifest.products[0], visualizationBlockedReason: "x".repeat(501) }] }));
});
function fakeApi(initial = []) {
  const inventory = [...initial];
  const mutations = [];
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    const answer = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Origin, "http://127.0.0.1:3120");
    if (path === "/api/admin/session") return answer({}, 201, { "set-cookie": "session=test; HttpOnly; SameSite=Strict" });
    assert.equal(options.headers.Cookie, "session=test");
    if (options.method !== "POST") return answer({ items: inventory, pageCount: 1 });
    mutations.push(path);
    if (path === "/api/admin/products") {
      const row = { ...JSON.parse(options.body), id: `id-${inventory.length}`, status: "draft" };
      inventory.push(row);
      return answer(row, 201);
    }
    const id = path.split("/")[4];
    const row = inventory.find((p) => p.id === id);
    if (path.endsWith("/views")) { row.assetUrl = "/asset/test"; row.status = "processing"; return answer(row, 201); }
    assert.equal(JSON.parse(options.body).action, "unpublish");
    row.status = "draft";
    return answer(row);
  };
  return { inventory, mutations, fetchImpl };
}
test("a second run does not create, upload, publish or overwrite edited records", async () => {
  const api = fakeApi();
  const options = { origin: "http://127.0.0.1:3120", password: "test", plan: importPlan(manifest), fetchImpl: api.fetchImpl };
  const first = await importDrafts(options);
  assert.equal(first.filter((row) => row.status === "created-draft").length, 4);
  const count = api.mutations.length;
  api.inventory[0].name = "Titre modifié dans le backoffice";
  const second = await importDrafts(options);
  assert.equal(second.filter((row) => row.status === "reused").length, 4);
  assert.equal(api.mutations.length, count);
  assert.equal(api.inventory[0].name, "Titre modifié dans le backoffice");
});
test("existing published records remain intact and source collisions stop import", async () => {
  const plan = importPlan(manifest).slice(0, 1);
  const api = fakeApi([{ ...plan[0].payload, id: "published", status: "ready", assetUrl: "/asset" }]);
  const result = await importDrafts({ origin: "http://127.0.0.1:3120", password: "test", plan, fetchImpl: api.fetchImpl });
  assert.equal(result[0].status, "preserved-existing");
  assert.equal(api.mutations.length, 0);
  api.inventory[0].sku = "MANUALLY-IMPORTED";
  api.inventory[0].buyUrl = plan[0].sourceUrl;
  await assert.rejects(importDrafts({ origin: "http://127.0.0.1:3120", password: "test", plan, fetchImpl: api.fetchImpl }), /Collision/);
});
test("legacy partner references are reused without duplicate products", async () => {
  const plan = importPlan(manifest).slice(0, 1);
  const api = fakeApi([{ ...plan[0].payload, sku: `ILEYCOM-${plan[0].sourceId}`, buyUrl: plan[0].sourceUrl, id: "legacy", status: "ready", assetUrl: "/asset" }]);
  const result = await importDrafts({ origin: "http://127.0.0.1:3120", password: "test", plan, fetchImpl: api.fetchImpl });
  assert.equal(result[0].id, "legacy");
  assert.equal(result[0].status, "preserved-existing");
  assert.equal(api.mutations.length, 0);
});
