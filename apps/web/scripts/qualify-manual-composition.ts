/** Real-provider qualification, isolated MongoDB and private local asset bytes.
 * Dry by default. A run identifier is claimed once, before any paid request.
 * Started/unknown markers are evidence and must never be removed to retry.
 *
 * node --conditions=react-server --import tsx apps/web/scripts/qualify-manual-composition.ts
 *   --source-root=<existing-primary-checkout> --case=standing
 * Add --execute --run-id=<new-reviewed-id> only when the implementation is ready.
 */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve, join, isAbsolute } from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import sharp from "sharp";
import type { Db, MongoClient } from "mongodb";
import type { CutoutMetadata } from "@lili/types";
import type { ProductDocument, RenderDocument } from "../lib/server/types";

type Point = { x: number; y: number };
type Box = { xMin: number; yMin: number; xMax: number; yMax: number };
type Case = {
  id: string; name: string; kind: "standing" | "flat" | "wall";
  scene: string; sceneId: string; source: string; cutout?: string; mask?: string;
  metadata?: string; objectType: string; dimensions: [number, number, number];
  placement: { box: Box; plane?: [Point, Point, Point, Point] };
  point: Point; replacement?: Box; limitations: string[];
};
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const options = new Map(process.argv.slice(2).map(arg => {
  const split = arg.indexOf("=");
  return split < 0 ? [arg, "true"] : [arg.slice(0, split), arg.slice(split + 1)];
}));
const sourceRoot = resolve(options.get("--source-root") ?? runtimeRoot);
const caseId = options.get("--case") ?? "standing";
const runId = options.get("--run-id");
const execute = options.has("--execute");
const admitOnly = options.has("--admit-only");
const evidenceRoot = join(sourceRoot, "artifacts/manual-composition-2026-10-04");
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const json = (file: string, value: unknown, exclusive = false) =>
  writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: exclusive ? "wx" : "w" });
const fixture = (file: string) => {
  const result = resolve(sourceRoot, file);
  if (isAbsolute(file) || !result.startsWith(sourceRoot + "/") && !result.startsWith(sourceRoot + "\\"))
    throw new Error("Fixture must belong to the existing source checkout.");
  return result;
};

const cases: Case[] = [
  {
    id: "standing", name: "Panier en jute sur parquet", kind: "standing",
    scene: "artifacts/manual-composition-2026-10-04/fixtures/living-room-tim-collins.jpg", sceneId: "living-room-tim-collins",
    source: "apps/web/tests/fixtures/catalogue/panier-stored-source.webp",
    mask: "apps/web/tests/fixtures/catalogue/panier-stored-mask.png",
    objectType: "other", dimensions: [40, 40, 40],
    placement: { box: { xMin: 0.255, yMin: 0.63, xMax: 0.385, yMax: 0.88 } },
    point: { x: 0.32, y: 0.88 }, limitations: ["Visual scale only; no measured room dimension."],
  },
  {
    id: "replacement", name: "Grenade sur console après retrait du globe", kind: "standing",
    scene: "artifacts/manual-composition-2026-10-04/fixtures/living-room-tim-collins.jpg", sceneId: "living-room-tim-collins",
    source: "apps/web/tests/fixtures/catalogue/grenade-stored-source.webp",
    mask: "apps/web/tests/fixtures/catalogue/grenade-stored-solid-mask.png",
    objectType: "vase", dimensions: [10, 20, 10],
    placement: { box: { xMin: 0.437, yMin: 0.475, xMax: 0.482, yMax: 0.562 } },
    point: { x: 0.4595, y: 0.562 },
    replacement: { xMin: 0.439, yMin: 0.507, xMax: 0.480, yMax: 0.565 },
    limitations: ["The console, painting and adjacent fruit bowl must remain intact.", "The globe and its support are the explicitly selected old object."],
  },
  {
    id: "floor", name: "Tapis HALVED projeté sur le parquet", kind: "flat",
    scene: "artifacts/manual-composition-2026-10-04/fixtures/empty-room-aismallard-1280.jpg", sceneId: "empty-room-aismallard",
    source: "testpratiques/sources/tapis.jpg", cutout: "testpratiques/objets/tapis/D/detourage.webp",
    metadata: "testpratiques/objets/tapis/D/produit-heberge.json",
    objectType: "rug", dimensions: [170, 2, 240],
    placement: { box: { xMin: 0.08, yMin: 0.08, xMax: 0.92, yMax: 0.92 },
      plane: [{ x: 0.42, y: 0.72 }, { x: 0.64, y: 0.74 }, { x: 0.92, y: 0.98 }, { x: 0.14, y: 0.94 }] },
    point: { x: 0.53, y: 0.79 },
    limitations: ["Four photo corners define a selected floor patch; box coordinates are in that patch's UV plane.",
      "Catalogue dimensions are exploratory fixture values, not a metric calibration."],
  },
  {
    id: "wall", name: "Miroir LINDBYN sur le mur en perspective", kind: "wall",
    scene: "artifacts/manual-composition-2026-10-04/fixtures/living-room-tim-collins.jpg", sceneId: "living-room-tim-collins",
    source: "testpratiques/sources/miroir.jpg", cutout: "testpratiques/objets/miroir/D/detourage.webp",
    metadata: "testpratiques/objets/miroir/D/produit-heberge.json",
    objectType: "mirror", dimensions: [80, 80, 3],
    placement: { box: { xMin: 0.20, yMin: 0.40, xMax: 0.70, yMax: 0.94 },
      plane: [{ x: 0.72, y: 0.12 }, { x: 0.96, y: 0.06 }, { x: 0.96, y: 0.40 }, { x: 0.72, y: 0.46 }] },
    point: { x: 0.828, y: 0.3208 },
    limitations: ["Four corners follow a perspective wall patch.", "Mirror reflection must match the scene after the photographic edit.",
      "Dimensions do not establish a measured scale or a physical installation."],
  },
];

async function runtimeManifest() {
  const entries: { path: string; sha256: string }[] = [];
  for (const folder of ["apps/web/lib", "packages/types/src", "packages/geometry/src", "packages/ai-router/src"])
    for (const name of await readdir(join(runtimeRoot, folder), { recursive: true }))
      if (/\.(ts|tsx|mjs)$/.test(name)) {
        const file = `${folder}/${name.replaceAll("\\", "/")}`;
        entries.push({ path: file, sha256: hash(await readFile(join(runtimeRoot, file))) });
      }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: runtimeRoot, encoding: "utf8" }).trim();
  return { baseCommit: commit, sourceSha256: hash(JSON.stringify(entries)), entries };
}

/** Captures call metadata only; no keys, request headers, image payloads or response credentials. */
async function installGuard(dir: string, paidCallsAllowed: boolean) {
  const originalFetch = globalThis.fetch;
  const counts = { image: 0, vision: 0 };
  let unknown = false;
  let inFlight = false;
  globalThis.fetch = async (input, init) => {
    if (!paidCallsAllowed) throw new Error("Admission-only qualification forbids every provider request.");
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (unknown || inFlight) throw new Error("An uncertain or simultaneous call blocks further paid requests.");
    if (url.origin !== "https://api.openai.com" || init?.method !== "POST" ||
      !["/v1/images/edits", "/v1/responses"].includes(url.pathname))
      throw new Error("Qualification refuses unaccounted network requests.");
    const kind = url.pathname === "/v1/images/edits" ? "image" : "vision";
    if (counts[kind] >= 2) throw new Error("Qualification provider call ceiling reached.");
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    const form = init.body instanceof FormData ? init.body : null;
    if (kind === "image" && (!form || form.get("model") !== "gpt-image-2.5-sunburst"))
      throw new Error("Unexpected image request/model.");
    if (kind === "vision" && (!body || body.model !== "gpt-6-astra" || body.tools?.length || body.background))
      throw new Error("Unexpected vision request/model.");
    const prefix = join(dir, `provider-${String(counts.image + counts.vision + 1).padStart(2, "0")}`);
    const start = Date.now();
    await json(`${prefix}.started.json`, { at: new Date(), kind, endpoint: url.pathname,
      model: kind === "image" ? form!.get("model") : body.model,
      ...(form ? { prompt: String(form.get("prompt")), quality: form.get("quality"), size: form.get("size"),
        maskProvided: form.has("mask"), imageCount: form.getAll("image[]").length + Number(form.has("image")) } : {}),
      maximumCalls: { image: 2, vision: 2 }, perRenderEstimatedBudgetUsd: 5 }, true);
    counts[kind]++;
    inFlight = true;
    process.stdout.write(JSON.stringify({ event: "provider-start", kind, call: counts.image + counts.vision }) + "\n");
    try {
      const response = await originalFetch(input, { ...init, redirect: "error" });
      // A complete read distinguishes a received HTTP response from a lost image stream.
      await response.clone().arrayBuffer();
      await json(`${prefix}.settled.json`, { at: new Date(), status: response.status,
        requestId: response.headers.get("x-request-id"), durationMs: Date.now() - start }, true);
      return response;
    } catch {
      unknown = true;
      await json(`${prefix}.unknown.json`, { at: new Date(), durationMs: Date.now() - start,
        reservationRetained: true, automaticReplayAllowed: false }, true);
      throw new Error("Provider outcome uncertain; inspect persistent evidence before further paid calls.");
    } finally { inFlight = false; }
  };
  return { restore: () => { globalThis.fetch = originalFetch; }, counts, isUnknown: () => unknown };
}

async function capture(db: Db, dir: string, render: RenderDocument) {
  const { readAsset } = await import("../lib/server/assets");
  const ids = new Set<string>([render.compositeAssetId, render.resultAssetId,
    ...Object.values(render.stages ?? {})].filter((value): value is string => typeof value === "string"));
  const assets: { id: string; filename: string; sha256: string; stages: string[] }[] = [];
  for (const id of ids) {
    const item = await readAsset(db, id);
    if (!item) continue;
    const extension = item.asset.contentType.includes("png") ? "png" : item.asset.contentType.includes("jpeg") ? "jpg" : "webp";
    const stages = Object.entries(render.stages ?? {}).filter(([, value]) => value === id).map(([key]) => key);
    const label = id === render.resultAssetId ? "result" : id === render.compositeAssetId ? "composite" : stages[0] ?? "preview";
    const filename = `${label}.${extension}`;
    await writeFile(join(dir, filename), item.buffer);
    assets.push({ id, filename, sha256: hash(item.buffer), stages });
  }
  await json(join(dir, "assets.json"), assets);
  return assets;
}

async function main() {
  const c = cases.find(item => item.id === caseId);
  if (!c) throw new Error("Case must be standing, replacement, floor or wall.");
  if ((execute || admitOnly) && (!runId || !/^[a-z0-9-]{1,80}$/.test(runId))) throw new Error("Isolated execution requires a fresh --run-id.");
  const dir = join(evidenceRoot, execute || admitOnly ? runId! : `prepared-${caseId}`);
  await mkdir(dir, { recursive: true });
  const inputFiles = [c.scene, c.source, c.cutout, c.mask, c.metadata].filter((value): value is string => Boolean(value));
  const inputs = [];
  for (const file of inputFiles) {
    const bytes = await readFile(fixture(file));
    const meta = /\.json$/.test(file) ? undefined : await sharp(bytes).metadata();
    inputs.push({ path: file, sha256: hash(bytes), bytes: bytes.length,
      ...(meta ? { width: meta.width, height: meta.height, hasAlpha: meta.hasAlpha } : {}) });
  }
  const sources = JSON.parse(await readFile(fixture("testpratiques/sources.json"), "utf8")) as { id: string; sha256: string; photoProvenance: string; usage: string; credit: string }[];
  sources.push(...JSON.parse(await readFile(fixture("artifacts/manual-composition-2026-10-04/fixtures/sources.json"), "utf8")));
  const roomProvenance = sources.find(item => item.id === c.sceneId);
  if (!roomProvenance || roomProvenance.sha256 !== inputs[0]!.sha256) throw new Error("Room fixture provenance/hash mismatch.");
  const code = await runtimeManifest();
  const plan = { version: 1, case: c, inputs, roomProvenance, code, paidCallsSent: false,
    executionMode: "isolated-local-durable", storage: "private local MongoDB bytes", maximumDurationMs: 180_000,
    maximumProviderCalls: { images: 2, vision: 2 }, perRenderEstimatedBudgetUsd: 5,
    physicalPhoneTested: false, physicalDimensionsVerified: false, publicFixtureInserted: false };
  // Claim before writing manifests: a repeated identifier must preserve the
  // original run's evidence as well as prevent another provider request.
  if (execute || admitOnly) await json(join(dir, "execution.started.json"), {
    at: new Date(), runId, codeSha256: code.sourceSha256, automaticReplayAllowed: false,
  }, true);
  await json(join(dir, "prepared.json"), plan);
  if (!execute && !admitOnly) {
    process.stdout.write(JSON.stringify({ event: "prepared-no-paid-calls", case: c.id,
      codeSha256: code.sourceSha256, inputs: inputs.length, evidence: dir }) + "\n");
    return;
  }
  const key = parseEnv(await readFile(fixture(".vercel/testpratiques-openai.env"), "utf8")).OPENAI_API_KEY?.trim();
  if (!key) throw new Error("The existing isolated OpenAI provider key is unavailable.");
  Object.assign(process.env, {
    NODE_ENV: "test", AI_MOCK_MODE: "false", DEMO_MODE: "false", OPENAI_IMAGE_ENABLED: "true",
    OPENAI_API_KEY: key, OPENAI_MODEL: "gpt-image-2.5-sunburst", STOREFRONT_IMAGE_MODEL: "gpt-image-2.5-sunburst",
    OPENAI_VISION_MODEL: "gpt-6-astra", OPENAI_QUALITY: "high", OPENAI_BASE_URL: "https://api.openai.com/v1",
    OPENAI_VISION_REASONING: "medium", OPENAI_SERVICE_TIER: "default", OPENAI_MAX_COST_USD: "5", RENDER_MAX_COST_USD: "5",
    GOOGLE_AI_API_KEY: "", GEMINI_API_KEY: "", CLOUDINARY_URL: "", CLOUDINARY_CLOUD_NAME: "",
    CLOUDINARY_API_KEY: "", CLOUDINARY_API_SECRET: "", MATTING_URL: "", MATTING_TOKEN: "",
    MYARCHITECTAI_API_KEY: "", SIMPLE_POINT_IMAGE_PROVIDER: "openai", RENDER_EXECUTION_MODE: "durable",
    RENDER_STAGE_CAPTURE: "true", RENDER_WORKER_REVISION: `sha256:${code.sourceSha256}`, IMAGE_PIPELINE_MODE: "openai",
  });
  // The isolated QA dependency lives in the root devDependencies. A production
  // web build must not resolve or bundle it merely to typecheck this script.
  const { MongoMemoryReplSet } = createRequire(import.meta.url)("mongodb-memory-server") as {
    MongoMemoryReplSet: {
      create(options: { replSet: { count: number; storageEngine: string; ip: string } }):
        Promise<{ getUri(): string; stop(): Promise<boolean> }>;
    };
  };
  const repl = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger", ip: "127.0.0.1" } });
  let client: MongoClient | undefined;
  let guard: Awaited<ReturnType<typeof installGuard>> | undefined;
  let db: Db | undefined;
  let renderId: string | undefined;
  try {
    process.env.MONGODB_URI = repl.getUri();
    process.env.MONGODB_DB = "manual_composition_qualification";
    const { serverConfig } = await import("../lib/server/config");
    if (serverConfig.aiMockMode || !serverConfig.openaiApiKey || serverConfig.cloudinaryUrl || serverConfig.cloudinaryApiSecret)
      throw new Error("Qualification config failed isolation/real-provider checks.");
    const { database, mongoClient, collections } = await import("../lib/server/mongodb");
    const { storeAsset } = await import("../lib/server/assets");
    const { prepareAdminProduct } = await import("../lib/server/admin-product-preparation");
    const { createRender } = await import("../lib/server/rendering");
    const { runWorkerOnce } = await import("../lib/server/render-worker");
    const { renderRequestSchema, renderSchema } = await import("@lili/types");
    const { renderResponse } = await import("../lib/server/serializers");
    client = await mongoClient(); db = await database();
    const rows = collections(db);
    const now = new Date(), expiresAt = new Date(Date.now() + 86_400_000);
    const organizationId = randomUUID(), publicSessionId = `storefront:${randomUUID()}`;
    const room = await readFile(fixture(c.scene));
    const source = await readFile(fixture(c.source));
    const roomMeta = await sharp(room).metadata();
    const sceneId = randomUUID(), productId = randomUUID();
    await rows.organizations.insertOne({ id: organizationId, name: "Private qualification fixture", slug: `qualification-${organizationId}`, createdAt: now });
    const roomAsset = await storeAsset(db, { organizationId, kind: "scene", visibility: { ownerSessionId: publicSessionId },
      buffer: room, contentType: "image/jpeg", expiresAt });
    const sourceMeta = await sharp(source).metadata();
    const sourceType = sourceMeta.format === "webp" ? "image/webp" : "image/jpeg";
    const productAsset = await storeAsset(db, { organizationId, kind: "product", visibility: "organization", buffer: source, contentType: sourceType });
    await rows.scenes.insertOne({ id: sceneId, organizationId, publicSessionId, assetId: roomAsset.id, status: "uploaded",
      widthPx: roomMeta.width!, heightPx: roomMeta.height!, analysis: {}, consentAt: now, createdAt: now, expiresAt });
    const product: ProductDocument = { id: productId, organizationId, name: c.name,
      description: "Private qualification fixture; visual estimated size only.", objectType: c.objectType,
      sku: null, widthCm: c.dimensions[0], heightCm: c.dimensions[1], depthCm: c.dimensions[2],
      material: "Original fixture material", placementType: c.kind === "wall" ? "wall" : c.id === "replacement" ? "table" : "floor",
      generationInstructions: "", lightingProfile: {}, buyUrl: null, status: "draft", assetId: productAsset.id, views: [], createdAt: now, updatedAt: now };
    if (c.cutout) {
      const bytes = await readFile(fixture(c.cutout));
      const document = JSON.parse(await readFile(fixture(c.metadata!), "utf8")) as { cutout: CutoutMetadata };
      const alpha = await sharp(bytes).ensureAlpha().extractChannel("alpha").raw().toBuffer();
      if (alpha.filter(value => value <= 10).length < alpha.length * 0.01 || alpha.filter(value => value >= 245).length < alpha.length * 0.01)
        throw new Error("Fixture matte lacks meaningful transparency or solid product coverage.");
      const asset = await storeAsset(db, { organizationId, kind: "cutout", visibility: "organization", buffer: bytes, contentType: "image/webp" });
      product.cutoutAssetId = asset.id; product.cutout = document.cutout;
    }
    await rows.products.insertOne(product);
    if (c.mask) await prepareAdminProduct(db, organizationId, productId, {
      buffer: await readFile(fixture(c.mask)), sourceAssetId: productAsset.id, sourceSha256: hash(source),
    });
    await rows.products.updateOne({ id: productId }, { $set: { status: "ready" } });
    await rows.wallets.insertOne({ organizationId, balance: 10, reserved: 0, holds: [], processedKeys: [], updatedAt: now });
    const body = renderRequestSchema.parse({ engine: "legacy", workflow: "simple_point", mode: "insert", outputQuality: "final",
      idempotencyKey: `qualification:${runId}`, preserveBackground: true,
      placement: { sceneId, productId, xNormalized: c.point.x, yNormalized: c.point.y }, placementPoint: c.point,
      ...(c.replacement ? { replaceExisting: true, replacementRegion: c.replacement } : {}),
      simplePlacements: [{ productId, placementPoint: c.point, placementKind: c.kind, manualPlacement: c.placement,
        dimensionPair: c.kind === "flat" ? { mode: "length_width", lengthCm: c.dimensions[2], widthCm: c.dimensions[0] }
          : { mode: "height_length", heightCm: c.dimensions[1], lengthCm: c.dimensions[0] } }],
    });
    await json(join(dir, "request.json"), body);
    await writeFile(join(dir, "source-room.jpg"), room);
    await writeFile(join(dir, `source-product.${sourceMeta.format === "webp" ? "webp" : "jpg"}`), source);
    const preparedProduct = await rows.products.findOne({ id: productId });
    if (!preparedProduct?.cutoutAssetId) throw new Error("Fixture preparation failed.");
    const { readAsset } = await import("../lib/server/assets");
    const cutout = await readAsset(db, preparedProduct.cutoutAssetId);
    if (!cutout) throw new Error("Prepared matte missing.");
    await writeFile(join(dir, "product-cutout.webp"), cutout.buffer);
    await json(join(dir, "product-preparation.json"), { cutout: preparedProduct.cutout, reusedOriginalPixels: true,
      sourceSha256: hash(source), cutoutSha256: hash(cutout.buffer), backofficeMaskPreparationExecuted: Boolean(c.mask) });
    // Local diagnostic previews use the exact production composition function.
    const { composeManualProducts } = await import("../lib/server/manual-composition");
    const montage = await composeManualProducts(room, roomMeta.width!, roomMeta.height!, [{ cutout: cutout.buffer,
      placement: c.placement, kind: c.kind, preparation: preparedProduct.cutout }]);
    await writeFile(join(dir, "montage-before-edit.webp"), montage.imageWebp);
    const quad = montage.manualPlacements[0]!.quad;
    const polygon = quad.map(point => `${point.x * roomMeta.width!},${point.y * roomMeta.height!}`).join(" ");
    const r = c.replacement;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${roomMeta.width}" height="${roomMeta.height}"><polygon points="${polygon}" fill="none" stroke="#22c55e" stroke-width="3"/>${r ? `<rect x="${r.xMin * roomMeta.width!}" y="${r.yMin * roomMeta.height!}" width="${(r.xMax - r.xMin) * roomMeta.width!}" height="${(r.yMax - r.yMin) * roomMeta.height!}" fill="none" stroke="#ef4444" stroke-width="3"/>` : ""}</svg>`;
    await writeFile(join(dir, "source-selection.webp"), await sharp(room).composite([{ input: Buffer.from(svg) }]).webp({ lossless: true }).toBuffer());
    await json(join(dir, "manual-placement.json"), montage.manualPlacements);
    // Private fixture bytes are readable only by this local qualification owner.
    await rows.assets.updateMany({ organizationId, id: { $in: [productAsset.id, preparedProduct.cutoutAssetId] } },
      { $set: { visibility: "private", ownerSessionId: publicSessionId } });
    guard = await installGuard(dir, execute);
    const startedAt = Date.now();
    const admitted = await createRender(db, organizationId, body, publicSessionId);
    renderId = admitted.id;
    const duplicate = await createRender(db, organizationId, body, publicSessionId);
    if (duplicate.id !== renderId || await rows.renders.countDocuments({ organizationId }) !== 1)
      throw new Error("Duplicate admission created another generation.");
    if (admitOnly) {
      const row = await rows.renders.findOne({ id: renderId });
      if (!row) throw new Error("Admission disappeared.");
      renderSchema.parse(renderResponse(row));
      const report = { at: new Date(), case: c.id, status: row.status, renderId,
        duplicateAdmissionId: duplicate.id, totalRenderDocuments: await rows.renders.countDocuments({ organizationId }),
        providerCalls: guard.counts, requestContractAccepted: true, responseContractAccepted: true,
        localOnly: true, publicFixtureInserted: false };
      await json(join(dir, "admission.json"), report, true);
      process.stdout.write(JSON.stringify({ event: "local-admission-no-provider-calls", ...report }) + "\n");
      return;
    }
    let responseChecks = 0;
    let responseFailures = 0;
    let pendingPoll: Promise<void> | undefined;
    const polling = setInterval(() => {
      if (pendingPoll) return;
      pendingPoll = rows.renders.findOne({ id: renderId }).then(async row => {
        if (!row) return;
        const validation = renderSchema.safeParse(renderResponse(row));
        if (validation.success) responseChecks++;
        else responseFailures++;
        await json(join(dir, "last-status.json"), { elapsedMs: Date.now() - startedAt, status: row.status, pipelineState: row.pipelineState });
      }).catch(() => { responseFailures++; }).finally(() => { pendingPoll = undefined; });
    }, 2_000);
    let claimed: boolean;
    try { claimed = await runWorkerOnce(db, "manual-composition-qualification"); }
    finally { clearInterval(polling); }
    await pendingPoll;
    const row = await rows.renders.findOne({ id: renderId });
    if (!row) throw new Error("Admitted render disappeared.");
    renderSchema.parse(renderResponse(row)); responseChecks++;
    const assets = await capture(db, dir, row);
    const wallet = await rows.wallets.findOne({ organizationId });
    const attempts = await rows.renderAttempts.find({ renderId }).toArray();
    await json(join(dir, "render.json"), row);
    await json(join(dir, "attempts.json"), attempts);
    const report = { version: 1, at: new Date(), case: c.id, renderId, claimed, durationMs: Date.now() - startedAt,
      status: row.status, pipelineState: row.pipelineState, error: row.error, qualityDecision: row.qualityDecision,
      qualityChecks: row.qualityChecks, usageTotals: row.usageTotals, engineVersions: row.engineVersions,
      providerCalls: guard.counts, unknownProviderOutcome: guard.isUnknown(), responseSchemaChecks: responseChecks,
      responseSchemaFailures: responseFailures,
      duplicateAdmissionId: duplicate.id, totalRenderDocuments: await rows.renders.countDocuments({ organizationId }),
      localWallet: { balance: wallet?.balance, reserved: wallet?.reserved }, creditCharged: row.creditCharged,
      assets, metricVerified: false, physicalPhoneTested: false, publicFixtureInserted: false,
      manuallyInspected: false, limits: [roomProvenance.photoProvenance, ...c.limitations] };
    await json(join(dir, "execution.json"), report, true);
    process.stdout.write(JSON.stringify({ event: "qualification-completed", ...report, assets: assets.map(asset => asset.filename) }) + "\n");
    if (row.status !== "succeeded" || responseFailures > 0) process.exitCode = 2;
  } catch (error) {
    if (db && renderId) {
      const row = await db.collection<RenderDocument>("renders").findOne({ id: renderId });
      if (row) { await json(join(dir, "render.json"), row); await capture(db, dir, row); }
    }
    await json(join(dir, "execution.error.json"), { at: new Date(), renderId,
      message: error instanceof Error ? error.message : "Qualification interrupted", automaticReplayAllowed: false }, true);
    throw error;
  } finally {
    guard?.restore(); await client?.close();
    const stopped = await repl.stop();
    await json(join(dir, "local-cleanup.json"), { at: new Date(), mongoStopped: stopped,
      storageUploadedToRemote: false, remoteDatabaseUsed: false }, true);
  }
}
main().catch(() => { console.error("Qualification stopped; inspect the persistent evidence. Provider secrets were not printed."); process.exitCode = 1; });
