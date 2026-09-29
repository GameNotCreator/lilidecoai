import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, open, unlink } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const defaultManifest = resolve(root, "docs/data/lilideco-catalogue-2026-09-29.json");

export function importPlan(manifest) {
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.products)) throw new Error("Format de catalogue invalide");
  const seen = new Set();
  return manifest.products.map((product) => {
    if (!/^\d+$/.test(product.sourceId) || seen.has(product.sourceId)) throw new Error("Identifiant source invalide ou dupliqué");
    seen.add(product.sourceId);
    const dimensions = product.dimensions;
    const missing = ["widthCm", "heightCm", "depthCm"].filter((key) => !Number.isFinite(dimensions?.[key]) || dimensions[key] <= 0);
    const local = resolve(root, product.localImage);
    const pathFromRoot = relative(root, local);
    if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) throw new Error("Image hors du projet");
    const source = new URL(product.sourceUrl);
    if (source.origin !== "https://ileycom.com" || !source.pathname.includes("/produit/")) throw new Error("Source produit invalide");
    if (!Number.isFinite(product.price) || product.price < 0 || manifest.currency !== "TND") throw new Error("Prix/devise invalide");
    if (product.visualizationBlockedReason !== undefined && product.visualizationBlockedReason !== null && (typeof product.visualizationBlockedReason !== "string" || product.visualizationBlockedReason.length > 500)) throw new Error("Motif de blocage de visualisation invalide");
    return {
      sourceId: product.sourceId,
      sku: `BLD-${product.sourceId}`,
      sourceUrl: product.sourceUrl,
      image: local,
      disposition: missing.length ? "awaiting-measurements" : "draft",
      reasons: [...missing.map((key) => `Mesure manquante : ${key}`), ...product.unknowns],
      payload: missing.length ? null : {
        name: product.name,
        description: `${product.description}\n\nDisponibilité à confirmer auprès de ByLiliDeco.`,
        objectType: product.objectType,
        placementType: product.placementType,
        material: product.material,
        visualizationBlockedReason: product.visualizationBlockedReason?.trim() || null,
        ...dimensions,
        sku: `BLD-${product.sourceId}`,
        brand: "ByLiliDeco",
        collection: "La sélection ByLiliDeco",
        tags: product.tags,
        // The existing application contract stores all prices in hundredths.
        // Do not use ISO minor digits here: its renderer always divides by 100.
        priceCents: Math.round(product.price * 100),
        currency: manifest.currency,
        // A source snapshot is not an inventory feed for this store.
        stock: null,
        buyUrl: null,
      },
    };
  });
}

export function localOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("L’import accepte seulement une origine HTTP locale sans chemin ni identifiants");
  }
  return url.origin;
}

export async function importDrafts({ origin, plan, password, fetchImpl = fetch, onProgress = () => {} }) {
  const base = localOrigin(origin);
  let cookie = "";
  const request = async (path, options = {}) => {
    const response = await fetchImpl(`${base}${path}`, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
      headers: { Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...options.headers },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Import interrompu : ${response.status} ${path} ${text.slice(0, 300)}`);
    if (path === "/api/admin/session") {
      const cookies = response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie")].filter(Boolean);
      cookie = cookies.map((entry) => entry.split(";", 1)[0]).join("; ");
      if (!cookie) throw new Error("La session administrateur n’a pas retourné de cookie");
    }
    return text ? JSON.parse(text) : null;
  };
  const jsonPost = (path, data) => request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  if (!password) throw new Error("Définir LILIDECO_IMPORT_ADMIN_PASSWORD pour l’import local");
  await jsonPost("/api/admin/session", { username: "LiliDeco", password });
  const inventory = [];
  for (let page = 1; page <= 500; page++) {
    const batch = await request(`/api/admin/products?status=all&pageSize=100&page=${page}`);
    if (!Array.isArray(batch.items) || !Number.isInteger(batch.pageCount) || batch.pageCount > 500) throw new Error("Pagination du catalogue invalide ou trop grande");
    inventory.push(...batch.items);
    if (page >= batch.pageCount) break;
  }
  const results = [];
  for (const item of plan) {
    if (!item.payload) { results.push({ sourceId: item.sourceId, status: item.disposition, reasons: item.reasons }); continue; }
    const legacySku = `ILEYCOM-${item.sourceId}`;
    const matches = inventory.filter((product) => product.sku === item.sku || product.sku === legacySku || product.buyUrl === item.sourceUrl);
    if (matches.length > 1) throw new Error(`Doublons existants pour ${item.sku} : contrôle manuel requis`);
    let product = matches[0];
    if (product && (![item.sku, legacySku].includes(product.sku) || (product.buyUrl && product.buyUrl !== item.sourceUrl))) throw new Error(`Collision d’identité pour ${item.sku}`);
    if (product && product.status !== "draft" && product.status !== "processing") {
      const result = { sourceId: item.sourceId, id: product.id, status: "preserved-existing", productStatus: product.status };
      results.push(result); onProgress(result); continue;
    }
    const created = !product;
    // Existing product fields are never overwritten: manual backoffice edits win.
    if (!product) product = await jsonPost("/api/admin/products", item.payload);
    const hasImage = Boolean(product.assetUrl || product.views?.length);
    let uploaded = false;
    if (!hasImage) {
      const bytes = await readFile(item.image);
      const form = new FormData();
      const type = item.image.endsWith(".webp") ? "image/webp" : "image/jpeg";
      form.set("file", new Blob([bytes], { type }), item.image.split(/[\\/]/).at(-1));
      form.set("viewType", "front");
      product = await request(`/api/admin/products/${product.id}/views`, { method: "POST", body: form });
      uploaded = true;
    }
    // Photo upload moves a new record to processing; imported records stay drafts.
    // An existing processing record may be owned by a human preparation operation.
    if (created || uploaded) product = await jsonPost(`/api/admin/products/${product.id}/actions`, { action: "unpublish" });
    const result = { sourceId: item.sourceId, id: product.id, status: created ? "created-draft" : "reused", imageUploaded: uploaded, productStatus: product.status, reasons: item.reasons };
    results.push(result); onProgress(result);
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const option = (key, fallback) => {
    const i = args.indexOf(key);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const allowed = new Set(["--apply", "--dry-run", "--origin", "--manifest", "--report", "--local-database-confirmed"]);
  for (let i = 0; i < args.length; i++) {
    if (!allowed.has(args[i])) throw new Error(`Argument inconnu : ${args[i]}`);
    if (["--origin", "--manifest", "--report"].includes(args[i])) { if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error("Valeur d’argument manquante"); i++; }
  }
  if (args.includes("--apply") && args.includes("--dry-run")) throw new Error("Choisir apply ou dry-run");
  const manifestPath = resolve(option("--manifest", defaultManifest));
  const manifestBytes = await readFile(manifestPath);
  const plan = importPlan(JSON.parse(manifestBytes));
  // Pre-read every eligible image before any mutation. Missing files cannot create half a lot.
  const images = await Promise.all(plan.filter((p) => p.payload).map(async (p) => ({ sourceId: p.sourceId, sha256: createHash("sha256").update(await readFile(p.image)).digest("hex") })));
  const report = { at: new Date().toISOString(), manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"), mode: args.includes("--apply") ? "apply" : "dry-run", aiCalls: 0, publishes: 0, images, plan: plan.map(({ image, payload, ...p }) => ({ ...p, image: relative(root, image), ...(payload ? { dimensions: { widthCm: payload.widthCm, heightCm: payload.heightCm, depthCm: payload.depthCm }, priceCents: payload.priceCents, currency: payload.currency, stock: payload.stock } : {}) })) };
  if (args.includes("--apply")) {
    if (!args.includes("--local-database-confirmed")) throw new Error("Confirmer que le serveur local utilise une base locale dédiée avec --local-database-confirmed");
    const origin = localOrigin(option("--origin", "http://127.0.0.1:3100"));
    const lockPath = resolve(root, "artifacts/catalogue-lilideco-2026-09-29/import.lock");
    await mkdir(dirname(lockPath), { recursive: true });
    const lock = await open(lockPath, "wx");
    try { report.results = await importDrafts({ origin, plan, password: process.env.LILIDECO_IMPORT_ADMIN_PASSWORD }); }
    finally { await lock.close(); await unlink(lockPath); }
  }
  const reportPath = resolve(option("--report", resolve(root, `artifacts/catalogue-lilideco-2026-09-29/import-${report.mode}.json`)));
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ mode: report.mode, draftCandidates: plan.filter((p) => p.payload).length, awaitingMeasurements: plan.filter((p) => !p.payload).length, reportPath, results: report.results, aiCalls: 0 }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
