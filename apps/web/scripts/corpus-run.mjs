/**
 * Runs the reference corpus against a live instance — audit ticket PRO-007,
 * phase 0 "Référence".
 *
 * What this is: a harness. It drives real cases through the real pipeline,
 * keeps every intermediate image and every version that produced them, and
 * writes a report that says where a case failed.
 *
 * What it is NOT: a measurement of photographic quality. That comes from the
 * photographs and the measurements a human supplies, and from a human looking
 * at the results. A run over an empty corpus proves nothing, a run in mock mode
 * proves nothing about images, and this script refuses to pretend otherwise —
 * every report states the mode it ran in, read back from the server rather than
 * assumed from this process's environment.
 *
 *   node apps/web/scripts/corpus-run.mjs <baseUrl> [--budget-usd 2] [--case id]
 *
 * The instance must have RENDER_STAGE_CAPTURE=true for per-stage artifacts;
 * without it the run still works and the report says which stages are missing.
 */
import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runClaim,
  stageSignals,
  validateCase,
  verdictSheet,
} from "./corpus-signals.mjs";
import { eligibleSplit, sourceDigest, SPLITS } from "./corpus-comparison.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = resolve(HERE, "../../../corpus");
const CASES_DIR = join(CORPUS_DIR, "cases");
const RUNS_DIR = join(CORPUS_DIR, "runs");

const args = process.argv.slice(2);
const baseUrl = args[0];
if (!baseUrl || baseUrl.startsWith("--")) {
  console.error(
    "Usage : node apps/web/scripts/corpus-run.mjs <baseUrl> [--budget-usd N] [--case id]",
  );
  process.exit(1);
}
const base = new URL(baseUrl);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
/**
 * Hard ceiling for the whole run, in USD. The per-render budget cannot bound a
 * corpus: twenty cases each inside their own ceiling still spend twenty times
 * it. Deliberately small by default — raise it knowingly.
 */
const budgetUsd = Number(flag("budget-usd", "1"));
assert.ok(
  Number.isFinite(budgetUsd) && budgetUsd > 0,
  "--budget-usd doit être un nombre positif",
);
const onlyCase = flag("case", null);
const split = flag("split", "pilot");
assert.ok(SPLITS.includes(split), "--split : pilot, tuning ou holdout");
assert.ok(split !== "holdout" || args.includes("--final-validation"), "Le jeu réservé nécessite --final-validation et ne sert jamais au réglage.");

/** The run's own timestamp, used for its directory name. */
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(RUNS_DIR, runId);

let cookie = "";
async function request(path, options = {}) {
  const response = await fetch(new URL(path, base), {
    ...options,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(options.headers ?? {}),
    },
    redirect: "manual",
    signal: AbortSignal.timeout(300_000),
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  for (const value of setCookie) {
    const pair = value.split(";")[0];
    if (pair) cookie = cookie ? `${cookie}; ${pair}` : pair;
  }
  return response;
}

async function json(path, options = {}) {
  const response = await request(path, options);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${path} → ${response.status}: ${body.slice(0, 300)}`);
  }
  return body ? JSON.parse(body) : null;
}

/**
 * The mode is read from the server, never from this process. `aiMockMode` is
 * derived and fails toward mock, so a missing key silently makes a run
 * synthetic — and a synthetic run must never be filed as a measurement.
 */
async function serverMode() {
  const health = await json("/v1/health");
  return {
    mockMode: Boolean(health?.imagePipeline?.mockMode),
    activeModel: health?.imagePipeline?.activeDemoModel ?? null,
    database: health?.database ?? null,
    storage: health?.storage ?? null,
  };
}

async function loadCases() {
  let files = [];
  try {
    // `_name.json` is a template, not a case.
    files = (await readdir(CASES_DIR)).filter(
      (name) => name.endsWith(".json") && !name.startsWith("_"),
    );
  } catch {
    return [];
  }
  const cases = [];
  for (const file of files) {
    const parsed = JSON.parse(await readFile(join(CASES_DIR, file), "utf8"));
    parsed.__file = file;
    cases.push(parsed);
  }
  return cases.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/** The upload is refused without a declared type, so it is read from the name. */
const MIME_BY_EXTENSION = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

async function uploadFile(path, file, fields) {
  const name = file.split(/[\\/]/).pop();
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  const type = MIME_BY_EXTENSION[extension];
  if (!type) {
    throw new Error(`${name} : format non accepté (JPEG, PNG ou WebP attendu).`);
  }
  const form = new FormData();
  form.set("file", new Blob([await readFile(file)], { type }), name);
  for (const [key, value] of Object.entries(fields ?? {})) form.set(key, value);
  return json(path, { method: "POST", body: form });
}

async function saveArtifact(url, target) {
  const response = await request(url);
  if (!response.ok) return { url, saved: false, status: response.status };
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(target, bytes);
  return { url, saved: true, bytes: bytes.length, file: target };
}

/**
 * Reads the render back until it reaches a terminal state. A real render runs
 * in a deferred task and finishes after the response; even a synchronous one
 * answers with an object that predates its own later writes.
 */
async function pollRender(renderId, fallback) {
  const deadline = Date.now() + 7_260_000;
  let last = fallback;
  let consecutiveErrors = 0;
  while (Date.now() < deadline) {
    try {
      last = await json(`/v1/renders/${renderId}`);
      consecutiveErrors = 0;
    } catch (reason) {
      // A transient GET failure used to end the poll and file the pre-poll
      // object as the result: status "processing", cost 0 — while the render
      // kept spending. Retry, and only after repeated failures give up, with
      // the outcome marked unknown rather than invented.
      consecutiveErrors += 1;
      if (consecutiveErrors >= 5) {
        return { ...last, status: "unknown", pollError: String(reason) };
      }
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      continue;
    }
    if (["succeeded", "failed", "cancelled", "deleted"].includes(last.status)) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  // Ten minutes past maxDuration: the render is not going to answer in this
  // run. Say so instead of reporting the last snapshot as final.
  return { ...last, status: "unknown", pollError: "timeout" };
}

async function runCase(item) {
  const caseDir = join(runDir, String(item.id));
  await mkdir(caseDir, { recursive: true });
  const started = Date.now();

  await json("/v1/auth/guest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });

  const dims = item.product.dimensionsCm;
  const product = await json("/v1/products", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      temporary: true,
      name: item.product.name,
      description: item.product.description ?? "Cas de référence PRO-007.",
      objectType: item.product.objectType ?? "other",
      widthCm: dims.width,
      heightCm: dims.height,
      depthCm: dims.depth,
      material: item.product.material ?? "Matière visible sur la photo",
      generationInstructions:
        "Conserver fidèlement la forme, les couleurs et tous les détails visibles.",
      placementType: item.product.placementType ?? "floor",
      lightingProfile: {},
      buyUrl: null,
    }),
  });
  await uploadFile(
    `/v1/products/${product.id}/assets`,
    join(CASES_DIR, item.product.file),
    { viewType: "front" },
  );
  const prepared = await json(`/v1/products/${product.id}/prepare`, {
    method: "POST",
  });
  await json(`/v1/products/${product.id}/anchor`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      anchorType: "bottom_center",
      xNormalized: 0.5,
      yNormalized: 1,
    }),
  });

  const scene = await uploadFile(
    "/v1/scenes",
    join(CASES_DIR, item.room.file),
    { consent: "true" },
  );

  const first = item.placements[0];
  const render = await json("/v1/renders/final", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workflow: "simple_point",
      mode: "insert",
      simplePlacements: item.placements.map((placement) => ({
        productId: product.id,
        placementPoint: placement.point,
        dimensionPair: placement.dimensionPair,
        placementKind: placement.kind ?? "standing",
      })),
      placement: {
        sceneId: scene.id,
        productId: product.id,
        mode: "insert",
        surfaceType: item.surfaceType ?? "floor",
        xNormalized: first.point.x,
        yNormalized: first.point.y,
      },
      placementPoint: first.point,
      surfaceType: item.surfaceType ?? "floor",
      outputQuality: "final",
      preserveBackground: true,
      idempotencyKey: `corpus:${runId}:${item.id}`,
    }),
  });

  // The POST answers with the in-memory render, which predates the writes the
  // pipeline makes as it goes — the captured stages among them. A real render
  // is also deferred and finishes after the response. Both reasons say the
  // same thing: read the persisted document back.
  const final = await pollRender(render.id, render);

  const artifacts = [];
  const save = async (url, name) => {
    if (url) artifacts.push(await saveArtifact(url, join(caseDir, name)));
  };
  await save(final.compositeUrl, "composite.webp");
  await save(final.resultUrl, "result.webp");
  for (const [stage, assetId] of Object.entries(final.stages ?? {})) {
    await save(`/api/assets/${assetId}`, `stage-${stage}.bin`);
  }

  const cost = final?.usageTotals?.estimatedCostUsd ?? 0;
  const referenceFiles = {};
  for (const [role, file] of Object.entries({ room: item.room.file, product: item.product.file, reference: item.groundTruth?.referencePhoto })) {
    if (!file) continue;
    const name = `source-${role}${extname(file)}`;
    await copyFile(join(CASES_DIR, file), join(caseDir, name));
    referenceFiles[role] = name;
  }
  const record = {
    caseId: item.id,
    split: item.split ?? "pilot",
    sourceDigest: await sourceDigest(item, CASES_DIR),
    referenceFiles,
    stratum: item.stratum,
    provenance: item.provenance,
    expectation: item.expectation ?? null,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    status: final.status,
    error: final.error ?? null,
    // The engine that produced this, resolved at runtime. A comparison across
    // two different values here is a comparison of two different engines.
    engineVersions: final.engineVersions ?? null,
    cutoutMetadata: prepared?.cutout ?? null,
    usageTotals: final.usageTotals ?? null,
    estimatedCostUsd: cost,
    signals: stageSignals(final, item),
    stagesCaptured: Object.keys(final.stages ?? {}),
    artifacts,
    renderId: final.id,
  };
  await writeFile(
    join(caseDir, "render.json"),
    `${JSON.stringify(final, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(caseDir, "case.json"),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
  // The sheet a human fills in. Without it the taxonomy stays prose in a
  // README and no failure ever gets classified — which is the deliverable.
  await writeFile(join(caseDir, "verdict.md"), verdictSheet(record), "utf8");
  return { record, cost };
}

const mode = await serverMode();
const cases = (await loadCases()).filter(
  (item) => eligibleSplit(item, split) && (!onlyCase || String(item.id) === onlyCase),
);

await mkdir(runDir, { recursive: true });

const records = [];
let spent = 0;
let stoppedForBudget = false;

for (const item of cases) {
  const problems = validateCase(item);
  if (problems.length) {
    records.push({ caseId: item.id ?? item.__file, status: "invalid", problems });
    console.error(`REFUSÉ ${item.id ?? item.__file} : ${problems.join(" ; ")}`);
    continue;
  }
  if (!mode.mockMode && spent >= budgetUsd) {
    stoppedForBudget = true;
    records.push({ caseId: item.id, status: "skipped_budget" });
    console.error(`ARRÊT BUDGET avant ${item.id} (${spent.toFixed(3)} USD)`);
    continue;
  }
  try {
    const digest = await sourceDigest(item, CASES_DIR);
    const { record, cost } = await runCase(item);
    assert.equal(record.sourceDigest, digest, "Les sources ont changé pendant le rendu");
    spent += cost;
    records.push(record);
    console.log(
      `${record.status.toUpperCase()} ${item.id} — qualité ${record.signals.quality ?? "?"} — ${cost.toFixed(3)} USD`,
    );
  } catch (reason) {
    records.push({
      caseId: item.id,
      stratum: item.stratum,
      sourceDigest: await sourceDigest(item, CASES_DIR).catch(() => null),
      status: "error",
      error: reason instanceof Error ? reason.message : String(reason),
    });
    console.error(`ERREUR ${item.id} : ${reason}`);
  }
}

const report = {
  runId,
  split,
  baseUrl: base.origin,
  startedAt: runId,
  server: mode,
  // Stated first and unmissably: a mock run says nothing about image quality.
  measures: runClaim({ mockMode: mode.mockMode, caseCount: cases.length }),
  budgetUsd,
  spentUsd: Number(spent.toFixed(4)),
  stoppedForBudget,
  caseCount: cases.length,
  cases: records,
};
await writeFile(
  join(runDir, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);

// A readable index beside the JSON: the JSON feeds a later aggregate, this is
// for the person who has to look at twenty images and decide.
const rows = records.map((entry) => {
  const signals = entry.signals ?? {};
  const cutout = signals.cutoutSynthetic
    ? "**synthétique**"
    : (signals.cutoutSources ?? ["—"]).join(",");
  const scale = signals.scaleFallbackFired
    ? "**repli**"
    : (signals.scaleSources ?? ["—"]).join(",");
  return `| ${entry.caseId} | ${entry.stratum ?? "—"} | ${entry.status} | ${signals.quality ?? "—"} | ${cutout} | ${scale} | ${(entry.estimatedCostUsd ?? 0).toFixed(3)} |`;
});
await writeFile(
  join(runDir, "report.md"),
  [
    `# Corpus — run ${runId}`,
    "",
    `Instance : ${base.origin}`,
    `Mode : ${mode.mockMode ? "SIMULÉ (images synthétiques)" : `réel (${mode.activeModel ?? "?"})`}`,
    `Ce run mesure : ${report.measures}`,
    `Dépense : ${report.spentUsd} / ${budgetUsd} USD${stoppedForBudget ? " — ARRÊTÉ SUR BUDGET" : ""}`,
    "",
    "| Cas | Strate | Statut | Qualité | Détourage | Échelle | Coût |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    "",
    "Remplissez `verdict.md` dans chaque dossier de cas, puis agrégez avec",
    "`node apps/web/scripts/corpus-aggregate.mjs <dossier du run>`.",
    "",
  ].join("\n"),
  "utf8",
);

console.log(`\nRapport : ${join(runDir, "report.md")}`);
if (cases.length === 0) {
  console.log(
    "\nCorpus VIDE : aucun cas dans corpus/cases. Ce run ne mesure rien.\n" +
      "Voir corpus/README.md pour ajouter un cas.",
  );
} else if (mode.mockMode) {
  console.log(
    "\nMODE SIMULÉ : les images sont synthétiques. Ce run vérifie le harnais,\n" +
      "pas la qualité des rendus.",
  );
}
