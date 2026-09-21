import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import sharp from "sharp";

// No generation or analysis calls. One synthetic scene expires automatically.
const base = new URL(process.argv[2]);
assert.equal(base.protocol, "https:");
const bypassFile = process.argv[3];
if (bypassFile) assert.ok(base.hostname.endsWith(".vercel.app"));
const bypassHeaders = bypassFile
  ? { "x-vercel-protection-bypass": readFileSync(bypassFile, "utf8").trim() }
  : {};
let passed = 0;
const verify = (name, condition) => {
  assert.ok(condition, name);
  console.log(`OK ${name}`);
  passed += 1;
};
const request = (path, options = {}) =>
  fetch(new URL(path, base), {
    ...options,
    headers: { ...bypassHeaders, ...options.headers },
    signal: AbortSignal.timeout(45000),
    redirect: "manual",
  });
const healthResponse = await request("/v1/health");
verify("santé HTTP", healthResponse.status === 200);
const health = await healthResponse.json();
verify(
  "MongoDB et stockage configurés",
  health.database === "mongodb" && health.storage === "cloudinary",
);
verify(
  "authentification et IA de production",
  health.authentication === "required" &&
    health.imagePipeline.mockMode === false &&
    health.imagePipeline.activeDemoModel ===
      (process.env.SMOKE_EXPECTED_IMAGE_MODEL || "gpt-image-2"),
);
for (const path of ["/", "/demo", "/objet", "/login"])
  verify(`page ${path}`, (await request(path)).status === 200);
for (const path of [
  "/v1/products",
  "/v1/renders",
  "/v1/credits",
  "/api/admin/overview",
  "/api/cron/purge",
])
  verify(
    `accès anonyme refusé ${path}`,
    [401, 403].includes((await request(path)).status),
  );

async function guest() {
  const response = await request("/v1/auth/guest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  verify("session invitée créée", response.status === 201);
  const body = await response.json();
  const cookie = response.headers.get("set-cookie");
  verify(
    "cookie invité sécurisé",
    cookie?.includes("HttpOnly") && cookie.includes("Secure"),
  );
  return { Authorization: `Bearer ${body.accessToken}` };
}
const first = await guest();
const second = await guest();
verify(
  "catalogue accessible avec session",
  (await request("/v1/products", { headers: first })).status === 200,
);
verify(
  "admin interdit à l'invité",
  [401, 403].includes(
    (await request("/v1/admin/overview", { headers: first })).status,
  ),
);
const bytes = await sharp({
  create: { width: 800, height: 600, channels: 3, background: "#dedede" },
})
  .png()
  .toBuffer();
const form = new FormData();
form.set("consent", "true");
form.set(
  "file",
  new Blob([bytes], { type: "image/png" }),
  "production-smoke-synthetic.png",
);
const upload = await request("/v1/scenes", {
  method: "POST",
  headers: first,
  body: form,
});
verify("envoi d'une scène synthétique", upload.status === 201);
const scene = await upload.json();
verify(
  "expiration de la scène enregistrée",
  Number.isFinite(Date.parse(scene.expiresAt)) &&
    Date.parse(scene.expiresAt) > Date.now(),
);
const imagePath = new URL(scene.imageUrl, base);
assert.equal(imagePath.origin, base.origin);
const ownImage = await request(imagePath, { headers: first });
verify(
  "image lisible par sa session",
  ownImage.status === 200 &&
    ownImage.headers.get("content-type")?.startsWith("image/"),
);
verify(
  "image privée non mise en cache public",
  ownImage.headers.get("cache-control") === "private, no-store",
);
verify(
  "image interdite sans session",
  [401, 403].includes((await request(imagePath)).status),
);
verify(
  "image interdite à une autre session",
  (await request(imagePath, { headers: second })).status === 403,
);
verify(
  "scène invisible à une autre session",
  (await request(`/v1/scenes/${scene.id}`, { headers: second })).status === 404,
);
console.log(
  JSON.stringify({
    passed,
    syntheticSceneId: scene.id,
    expiresAt: scene.expiresAt,
    paidGenerationCalls: 0,
  }),
);
