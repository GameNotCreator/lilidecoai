import { pathToFileURL } from "node:url";
import { PINNED_SPATIAL_MATTING } from "./check-spatial-matting.mjs";

const clean = (value) => typeof value === "string" ? value.trim().replace(/^(['"])(.*)\1$/, "$2") : "";
const positive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;
const list = (value) => clean(value).split(",").map((id) => id.trim()).filter(Boolean);

/** Configuration evidence only. Never return environment values or secrets. */
export function inspectOrientedConfiguration(env) {
  const checks = [];
  const add = (id, passed, action) => checks.push({ id, passed: Boolean(passed), action });
  add("vision", clean(env.OPENAI_API_KEY), "Configurer OPENAI_API_KEY côté serveur.");
  add("image", clean(env.MYARCHITECTAI_API_KEY), "Configurer MYARCHITECTAI_API_KEY côté serveur.");
  add("real-mode", clean(env.AI_MOCK_MODE) === "false", "Définir AI_MOCK_MODE=false pour les essais réels.");
  add("durable", env.RENDER_EXECUTION_MODE === "durable", "Utiliser RENDER_EXECUTION_MODE=durable et un worker compatible.");
  add("mask-service", clean(env.MATTING_URL) && clean(env.MATTING_TOKEN), "Configurer le service privé MATTING_URL et MATTING_TOKEN, puis qualifier son masque.");
  add("render-admission", list(env.ORIENTED_ORGANIZATION_IDS).length && list(env.ORIENTED_PRODUCT_IDS).length,
    "Renseigner les listes ORIENTED_ORGANIZATION_IDS et ORIENTED_PRODUCT_IDS pour le pilote interne choisi.");
  add("preparation-admission", env.ORIENTED_PREPARATION_ENABLED === "true" &&
    list(env.ORIENTED_PREPARATION_ORGANIZATION_IDS).length && list(env.ORIENTED_PREPARATION_PRODUCT_IDS).length,
    "Activer la préparation et ses deux listes explicites pour le catalogue du pilote.");
  add("shared-pilot", list(env.ORIENTED_ORGANIZATION_IDS).some((id) => list(env.ORIENTED_PREPARATION_ORGANIZATION_IDS).includes(id)) &&
    list(env.ORIENTED_PRODUCT_IDS).some((id) => list(env.ORIENTED_PREPARATION_PRODUCT_IDS).includes(id)),
    "Autoriser au moins une même boutique et un même produit pour préparer puis essayer le pilote.");
  add("preview-budget", positive(env.ORIENTED_PREVIEW_MAX_COST_USD), "Définir ORIENTED_PREVIEW_MAX_COST_USD après vérification du coût de vision.");
  add("render-budget", positive(env.RENDER_MAX_COST_USD), "Définir explicitement RENDER_MAX_COST_USD pour les essais.");
  const configuredCost = Number(clean(env.MYARCHITECTAI_EDIT_COST_USD));
  const providerCost = Number.isFinite(configuredCost) && configuredCost > 0 ? Math.min(5, configuredCost) : 0.03;
  const allocatedCost = Number(env.ORIENTED_PREPARATION_PROVIDER_COST_USD);
  add("preparation-budget", positive(env.ORIENTED_PREPARATION_MAX_COST_USD) &&
    positive(allocatedCost) && allocatedCost >= providerCost && Number(env.ORIENTED_PREPARATION_MAX_COST_USD) >= allocatedCost,
    "Définir le budget de préparation et une allocation par appel au moins égale au coût configuré du fournisseur.");
  return checks;
}

export function supportsTransactions(hello) {
  return Boolean(hello && (hello.setName || hello.msg === "isdbgrid") &&
    Number.isFinite(hello.logicalSessionTimeoutMinutes));
}

function privateServiceUrl(value) {
  try {
    const url = new URL(clean(value));
    if (url.username || url.password || (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) return null;
    return new URL("/health", url);
  } catch { return null; }
}

/** Read-only probes: hello and /health only, never image generation or mask inference. */
export async function probeOrientedServices(env, dependencies = {}) {
  const probes = [];
  let client;
  try {
    const MongoClient = dependencies.MongoClient ?? (await import("mongodb")).MongoClient;
    client = new MongoClient(clean(env.MONGODB_URI) || "mongodb://127.0.0.1:27017/lilidecoai", {
      serverSelectionTimeoutMS: 3_000, connectTimeoutMS: 3_000, socketTimeoutMS: 3_000,
    });
    await client.connect();
    const hello = await client.db("admin").command({ hello: 1 });
    probes.push({ id: "database-transactions", passed: supportsTransactions(hello),
      status: supportsTransactions(hello) ? "supported" : "standalone_or_no_sessions",
      action: "Utiliser une base MongoDB replica set/Atlas dédiée aux essais ; ne pas convertir la base active sans préparation." });
  } catch {
    probes.push({ id: "database-transactions", passed: false, status: "unreachable",
      action: "Vérifier la connexion MongoDB et les droits de lecture du compte serveur." });
  } finally { await client?.close().catch(() => {}); }
  const url = privateServiceUrl(env.MATTING_URL);
  if (!url) {
    probes.push({ id: "mask-health", passed: false, status: "not_configured_or_invalid_url",
      action: "Configurer un service privé HTTPS, ou HTTP sur loopback en local." });
  } else {
    try {
      const response = await (dependencies.fetcher ?? fetch)(url, {
        signal: AbortSignal.timeout(3_000), redirect: "error", cache: "no-store",
      });
      if (!response.ok || response.headers.get("content-type")?.split(";")[0] !== "application/json") {
        await response.body?.cancel();
        throw new Error("health unavailable");
      }
      // The health endpoint is small; do not buffer arbitrary service output.
      const reader = response.body?.getReader();
      if (!reader) throw new Error("missing health body");
      let size = 0;
      const chunks = [];
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 16_384) throw new Error("health body too large");
          chunks.push(part.value);
        }
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      const health = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const matches = health.ready === true && health.busy === false &&
        health.model === PINNED_SPATIAL_MATTING.model && health.modelSha256 === PINNED_SPATIAL_MATTING.modelSha256 &&
        health.runtime === PINNED_SPATIAL_MATTING.runtime;
      probes.push({ id: "mask-health", passed: matches, status: matches ? "ready" : "busy_or_identity_mismatch",
        action: "Vérifier le modèle et le runtime épinglés du service ; sa disponibilité ne qualifie pas la silhouette." });
    } catch {
      probes.push({ id: "mask-health", passed: false, status: "unavailable",
        action: "Vérifier le service privé de masque sans relancer de génération d’image." });
    }
  }
  return probes;
}

export async function orientedReadiness(env, { probe = false, dependencies } = {}) {
  const checks = inspectOrientedConfiguration(env);
  const services = probe ? await probeOrientedServices(env, dependencies) : [];
  return { schemaVersion: 1, inspectedAt: new Date().toISOString(),
    configurationComplete: checks.every((check) => check.passed),
    serviceProbesPerformed: probe, servicesAvailable: probe && services.every((service) => service.passed),
    checks, services, providerCalls: 0, maskInferences: 0, writes: 0,
    qualification: "unverified", publicActivation: false,
    remainingEvidence: ["Migration additive et worker compatible vérifiés sur la base cible.",
      "Vue détourée puis revue humaine réelle, identité et contact acceptés.",
      "Chaîne complète et corpus du pilote qualifiés, budget total maîtrisé.",
      "Stockage privé, isolation des accès et retour arrière vérifiés."] };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: node --env-file-if-exists=.env apps/web/scripts/oriented-readiness.mjs [--probe]\nDiagnostic JSON sans secrets ; --probe lit MongoDB et /health. Aucun appel image, aucune écriture. Code 2 : prérequis incomplets ; 0 : prérequis contrôlés présents, qualification encore nécessaire.");
    return;
  }
  if (args.some((arg) => arg !== "--probe")) throw new Error("Unknown argument");
  const report = await orientedReadiness(process.env, { probe: args.includes("--probe") });
  console.log(JSON.stringify(report, null, 2));
  if (!report.configurationComplete || (report.serviceProbesPerformed && !report.servicesAvailable)) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => { console.error("Diagnostic orienté interrompu. Aucune activation effectuée."); process.exitCode = 1; });
}
