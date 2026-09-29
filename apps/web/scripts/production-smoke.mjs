import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
export const DEFAULT_IMAGE_MODEL = "gpt-image-2.5-sunburst";
class SmokeError extends Error {
  constructor(code) { super(code); this.code = code; }
}

/** Storage/authentication checks only; no vision, image or render API calls. */
export async function runProductionSmoke({
  baseUrl, bypassToken, expectedImageModel = DEFAULT_IMAGE_MODEL,
  expectedExecutionMode, fetcher = globalThis.fetch, log = () => {}, timeoutMs = 45_000,
} = {}) {
  const report = { status: "running", passed: 0, paidGenerationCalls: 0, paidVisionCalls: 0, cleanup: { status: "not-needed" } };
  const verify = (name, condition) => {
    if (!condition) throw new SmokeError(name);
    report.passed++;
    log("OK " + name);
  };
  let base;
  try { base = new URL(baseUrl); } catch { throw new SmokeError("invalid-base-url"); }
  verify("HTTPS sans identifiants dans l'URL", base.protocol === "https:" && !base.username &&
    !base.password && !base.search && !base.hash && base.pathname === "/");
  verify("délai borné", Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 45_000);
  if (bypassToken !== undefined) verify("protection Vercel bornée", base.hostname.endsWith(".vercel.app") &&
    typeof bypassToken === "string" && bypassToken.length > 0 && bypassToken.length <= 8192 && !/[\r\n]/.test(bypassToken));
  const request = async (path, options = {}) => {
    const url = new URL(path, base);
    if (url.origin !== base.origin || url.username || url.password) throw new SmokeError("foreign-request-refused");
    const headers = new Headers(options.headers);
    if (bypassToken) headers.set("x-vercel-protection-bypass", bypassToken);
    if (!["GET", "HEAD"].includes(options.method ?? "GET")) headers.set("Origin", base.origin);
    try {
      return await fetcher(url, { ...options, headers, signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    } catch { throw new SmokeError("transport-failed"); }
  };
  const json = async response => {
    try { return await response.json(); } catch { throw new SmokeError("invalid-response-json"); }
  };
  let first, sceneId, imagePath, failure, privacyVerified = false;
  try {
    const healthResponse = await request("/v1/health");
    verify("santé HTTP", healthResponse.status === 200);
    const health = await json(healthResponse);
    verify("MongoDB et stockage configurés", health.database === "mongodb" && health.storage === "cloudinary");
    verify("authentification et IA de production", health.authentication === "required" &&
      health.imagePipeline?.mockMode === false && health.imagePipeline.activeDemoModel === expectedImageModel);
    if (expectedExecutionMode) verify("mode du worker", health.imagePipeline.executionMode === expectedExecutionMode);
    for (const path of ["/", "/panier", "/visualiser", "/login"])
      verify("page " + path, (await request(path)).status === 200);
    for (const path of ["/v1/products", "/v1/renders", "/v1/credits", "/api/admin/overview", "/api/cron/purge", "/api/cron/render-worker"])
      verify("accès anonyme refusé " + path, [401, 403].includes((await request(path)).status));
    verify("ancien accès invité fermé", (await request("/v1/auth/guest", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    })).status === 403);
    const catalogResponse = await request("/api/storefront/products");
    verify("catalogue public accessible sans session", catalogResponse.status === 200);
    const catalog = await json(catalogResponse);
    verify("contrat du catalogue boutique", typeof catalog.store?.name === "string" &&
      Array.isArray(catalog.products) && typeof catalog.visualization?.available === "boolean" &&
      catalog.products.every(product => UUID.test(product.id) && typeof product.visualizationAvailable === "boolean"));
    verify("catalogue sans cache périmé", catalogResponse.headers.get("cache-control") === "no-store");
    report.catalogProductCount = catalog.products.length;
    report.visualizationAvailable = catalog.visualization.available;
    async function session() {
      const response = await request("/api/storefront/session", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      verify("session boutique créée", response.status === 201);
      verify("session non mise en cache", response.headers.get("cache-control") === "no-store");
      const body = await json(response);
      verify("jeton boutique présent", typeof body.accessToken === "string" && /^[a-z\d_.-]+$/i.test(body.accessToken));
      const setCookies = response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
      const cookies = setCookies.filter(cookie => cookie.startsWith("lili_storefront_session="));
      verify("cookie boutique unique", cookies.length === 1);
      const [pair, ...attributes] = cookies[0].split(";").map(value => value.trim());
      const lower = attributes.map(value => value.toLowerCase());
      verify("cookie boutique sécurisé", pair === "lili_storefront_session=" + body.accessToken &&
        ["httponly", "secure", "samesite=lax", "path=/", "max-age=86400"].every(value => lower.includes(value)) &&
        !lower.some(value => value.startsWith("domain=")));
      return { token: body.accessToken, cookie: pair };
    }
    first = await session();
    const second = await session();
    verify("sessions indépendantes", first.token !== second.token);
    const firstHeaders = { Cookie: first.cookie };
    const secondHeaders = { Authorization: "Bearer " + second.token };
    const capabilities = await request("/v1/render-capabilities", { headers: firstHeaders });
    verify("capacités boutique accessibles", capabilities.status === 200);
    verify("moteur spatial fermé aux visiteurs", (await json(capabilities)).spatial === false);
    verify("catalogue marchand interdit à la session boutique", (await request("/v1/products", { headers: firstHeaders })).status === 403);
    verify("admin interdit à la session boutique", (await request("/v1/admin/overview", { headers: firstHeaders })).status === 403);
    const bytes = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#dedede" } }).png().toBuffer();
    const form = new FormData();
    form.set("consent", "true");
    form.set("file", new Blob([bytes], { type: "image/png" }), "production-smoke-synthetic.png");
    const upload = await request("/v1/scenes", { method: "POST", headers: firstHeaders, body: form });
    verify("envoi d'une scène synthétique", upload.status === 201);
    report.cleanup = { status: "unconfirmed" };
    const scene = await json(upload);
    verify("identifiant de scène borné", typeof scene.id === "string" && UUID.test(scene.id));
    sceneId = scene.id; // Only the newly minted synthetic scene is eligible for cleanup.
    report.syntheticSceneId = sceneId;
    const expiry = Date.parse(scene.expiresAt);
    verify("expiration de la scène enregistrée", Number.isFinite(expiry) && expiry > Date.now());
    report.expiresAt = new Date(expiry).toISOString();
    let imageUrl;
    try { imageUrl = new URL(scene.imageUrl, base); } catch { throw new SmokeError("invalid-image-url"); }
    verify("photo servie par la même origine", imageUrl.origin === base.origin && !imageUrl.username &&
      !imageUrl.password && !imageUrl.search && !imageUrl.hash &&
      imageUrl.pathname.startsWith("/api/assets/") && UUID.test(imageUrl.pathname.slice("/api/assets/".length)));
    imagePath = imageUrl.pathname;
    const ownImage = await request(imagePath, { headers: firstHeaders });
    verify("image lisible par sa session", ownImage.status === 200 && ownImage.headers.get("content-type")?.startsWith("image/"));
    verify("image privée non mise en cache public", ownImage.headers.get("cache-control") === "private, no-store");
    verify("image interdite sans session", (await request(imagePath)).status === 403);
    verify("image interdite à une autre session", (await request(imagePath, { headers: secondHeaders })).status === 403);
    verify("scène invisible à une autre session", (await request("/v1/scenes/" + sceneId, { headers: secondHeaders })).status === 404);
    privacyVerified = true;
  } catch (error) {
    failure = error instanceof SmokeError ? error : new SmokeError("smoke-check-failed");
  } finally {
    if (sceneId && first) {
      // A release may only expire scenes: DELETE 404 is not deletion evidence.
      report.cleanup = { status: "unconfirmed" };
      try {
        const headers = { Cookie: first.cookie };
        const response = await request("/v1/scenes/" + sceneId, { method: "DELETE", headers });
        report.cleanup.deleteStatus = response.status;
        const remaining = await request("/v1/scenes/" + sceneId, { headers });
        const image = imagePath ? await request(imagePath, { headers }) : null;
        if ([404, 410].includes(remaining.status) && image && [404, 410].includes(image.status)) {
          report.cleanup.status = "deleted";
        } else if (!image) {
          report.cleanup.detail = "Suppression complète non confirmée : la photo n’a pas pu être vérifiée.";
          log(report.cleanup.detail);
        } else {
          report.cleanup.status = "retention-only";
          report.cleanup.detail = privacyVerified
            ? "La scène synthétique reste privée jusqu’à son expiration."
            : "Scène synthétique conservée ; isolation ou expiration non entièrement validées.";
          log(report.cleanup.detail);
        }
      } catch {
        report.cleanup.detail = report.expiresAt
          ? "Nettoyage non confirmé ; la scène synthétique conserve son expiration."
          : "Nettoyage et expiration de la scène synthétique non confirmés.";
        log(report.cleanup.detail);
      }
    }
  }
  report.status = failure ? "failed" : "passed";
  if (failure) { failure.report = report; throw failure; }
  return report;
}

async function main() {
  try {
    const report = await runProductionSmoke({
      baseUrl: process.argv[2],
      bypassToken: process.argv[3] ? readFileSync(process.argv[3], "utf8").trim() : undefined,
      expectedImageModel: process.env.SMOKE_EXPECTED_IMAGE_MODEL || DEFAULT_IMAGE_MODEL,
      expectedExecutionMode: process.env.SMOKE_EXPECTED_EXECUTION_MODE,
      log: message => console.log(message),
    });
    console.log(JSON.stringify(report));
  } catch (error) {
    console.error(JSON.stringify({ ...(error instanceof SmokeError ? error.report : undefined), status: "failed",
      code: error instanceof SmokeError ? error.code : "smoke-could-not-complete", paidGenerationCalls: 0, paidVisionCalls: 0 }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
