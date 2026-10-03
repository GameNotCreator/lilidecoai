import "server-only";
import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import type { ProviderAttemptResult, ImageProviderResponseObservation } from "@lili/ai-router";
import { PREPARED_VIEW_PROMPT_VERSION } from "@lili/ai-router";
import { preparedProductViewSchema, prepareViewRequestSchema, retryPreparedViewMatteRequestSchema, type PreparedProductView,
  type PreparedViewOrientation } from "@lili/types";
import { AdminProductError, findProduct } from "./admin-products";
import { readAsset, storeAsset } from "./assets";
import { MyArchitectAIImageProvider, MYARCHITECTAI_CONFIGURATION_VERSION } from "./ai/myarchitectai";
import { preparedCollections, preparedHash, preparedSources, ensurePreparedViewIndexes, assertPreparedProduct } from "./prepared-views";
import { prepareViewMatte, PREPARED_MATTE_VERSION } from "./prepared-view-matte";
import { acquireOrientedProviderSlot } from "./oriented-provider-execution";
import { transaction } from "./durable-queue";
import { DurableExecutionError } from "./durable-context";
import { serverConfig } from "./config";
import type { ProductDocument } from "./types";

export interface PreparedViewTask {
  id: string; organizationId: string; productId: string; variantId: string | null; viewId: string;
  businessKey: string; idempotencyKey: string; state: "queued" | "preparing" | "needs_review" | "failed" | "unknown";
  requestedOrientation: PreparedViewOrientation; sourceFingerprint: string; geometryFingerprint: string;
  sources: PreparedProductView["sources"]; sourceAssetId: string; origin: PreparedProductView["origin"];
  attempts: number; configurationFingerprint: string;
  lease?: { token: string; expiresAt: Date };
  provider: { state: "not_sent" | "sent" | "succeeded" | "rejected" | "unknown"; calls: number;
    reservedUsd: number; costUsd: number; accountedUsd?: number; observation?: ImageProviderResponseObservation };
  budget: { maxCalls: 1; maxCostUsd: number; costPerCallUsd: number };
  checkpoint: { rawAssetId: string; imageAssetId: string; alphaAssetId: string; rawStored?: boolean; rawSha256?: string };
  executionMode?: "matte_only";
  failureStage?: "matte";
  matteRunAttempts?: number;
  stagedAssetIds?: string[];
  matteRetries?: Array<{ requestId: string; actorId: string; requestedAt: Date; expectedRevision: number;
    previousFailure: string; previousConfigurationFingerprint: string; configurationFingerprint: string;
    previousMaskVersion: string; requestedMaskVersion: string }>;
  failure?: string; retiredAssetsExpireAt?: Date; createdAt: Date; updatedAt: Date;
}
interface MatteRetryRequest {
  _id: string; organizationId: string; productId: string; viewId: string; taskId: string;
  expectedRevision: number; expectedProductRevision: string;
}
const MAX_EXPLICIT_MATTE_RETRIES = 5;
const PRESETS = {
  front: { azimuthDeg: 0, elevationDeg: 5, rollDeg: 0 },
  three_quarter: { azimuthDeg: 30, elevationDeg: 30, rollDeg: 0 },
  top: { azimuthDeg: 0, elevationDeg: 60, rollDeg: 0 },
} satisfies Record<string, PreparedViewOrientation>;
const csv = (value: string | undefined) => (value ?? "").split(",").map(v => v.trim()).filter(Boolean);
function preparationEnabled(organizationId: string, productId: string) {
  return process.env.ORIENTED_PREPARATION_ENABLED === "true" &&
    csv(process.env.ORIENTED_PREPARATION_ORGANIZATION_IDS).includes(organizationId) &&
    csv(process.env.ORIENTED_PREPARATION_PRODUCT_IDS).includes(productId);
}
function budgetPolicy() {
  return { maxCalls: 1 as const, maxCostUsd: Number(process.env.ORIENTED_PREPARATION_MAX_COST_USD ?? 0),
    costPerCallUsd: Number(process.env.ORIENTED_PREPARATION_PROVIDER_COST_USD ?? 0) };
}
const configurationFingerprint = () => preparedHash(JSON.stringify({
  version: "prepared-view-v2/matte-recovery-v1", mask: PREPARED_MATTE_VERSION, prompt: PREPARED_VIEW_PROMPT_VERSION,
  provider: MYARCHITECTAI_CONFIGURATION_VERSION, providerCost: serverConfig.myArchitectAIEditCostUsd,
  providerTimeout: serverConfig.myArchitectAITimeoutMs,
  mattingService: serverConfig.mattingUrl ?? null, mattingTimeout: serverConfig.mattingTimeoutMs,
}));
function initialView(task: PreparedViewTask): PreparedProductView {
  return preparedProductViewSchema.parse({ schemaVersion: 1, id: task.viewId, organizationId: task.organizationId,
    productId: task.productId, variantId: task.variantId, revision: 1, sourceFingerprint: task.sourceFingerprint,
    geometryFingerprint: task.geometryFingerprint, sources: task.sources, origin: task.origin, state: "queued",
    image: null, alpha: null, visibleBounds: null, anchor: null, physicalHeightSegment: null,
    orientation: { convention: "camera-product-degrees-v1", requested: task.requestedOrientation, estimated: null, coverage: null },
    review: null, versions: { preparation: "prepared-view-v2", mask: PREPARED_MATTE_VERSION,
      prompt: task.origin === "photographed" ? "catalogue-photograph-v1" : PREPARED_VIEW_PROMPT_VERSION,
      providerConfiguration: task.origin === "photographed" ? "local" : MYARCHITECTAI_CONFIGURATION_VERSION },
    preparation: { taskId: task.id, costUsd: 0 }, createdAt: task.createdAt.toISOString(), updatedAt: task.createdAt.toISOString() });
}
export async function queuePreparedView(db: Db, organizationId: string, productId: string, input: unknown) {
  const request = prepareViewRequestSchema.parse(input);
  if (!preparationEnabled(organizationId, productId)) throw new AdminProductError("La préparation orientée est désactivée pour ce produit.", 403);
  const product = await findProduct(db, organizationId, productId);
  assertPreparedProduct(product, request.variantId);
  if (product.updatedAt.toISOString() !== request.expectedProductRevision)
    throw new AdminProductError("La fiche produit a changé. Rechargez-la.", 409);
  const current = await preparedSources(db, product, request.variantId);
  await ensurePreparedViewIndexes(db);
  const c = preparedCollections(db);
  const businessKey = preparedHash(JSON.stringify({ productId, variantId: request.variantId,
    sourceFingerprint: current.sourceFingerprint, preset: request.preset, preparation: "prepared-view-v2",
    prompt: PREPARED_VIEW_PROMPT_VERSION, matting: PREPARED_MATTE_VERSION }));
  const requests = db.collection<{ _id: string; businessKey: string }>("prepared_view_requests");
  const requestId = preparedHash(JSON.stringify({ organizationId, idempotencyKey: request.idempotencyKey }));
  try { await requests.updateOne({ _id: requestId }, { $setOnInsert: { businessKey } }, { upsert: true }); }
  catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === 11000)) throw error; }
  const binding = await requests.findOne({ _id: requestId });
  if (!binding || binding.businessKey !== businessKey) throw new AdminProductError("Clé de demande déjà utilisée pour une autre préparation.", 409);
  const priorKey = await c.tasks.findOne({ organizationId, idempotencyKey: request.idempotencyKey });
  if (priorKey && priorKey.businessKey !== businessKey) throw new AdminProductError("Clé de demande déjà utilisée pour une autre préparation.", 409);
  const exactPhotograph = current.sources.find(s => s.role === request.preset);
  const now = new Date();
  const task: PreparedViewTask = { id: randomUUID(), organizationId, productId, variantId: request.variantId,
    viewId: randomUUID(), businessKey, idempotencyKey: request.idempotencyKey, state: "queued",
    requestedOrientation: PRESETS[request.preset], ...current,
    sourceAssetId: exactPhotograph?.assetId ?? current.sources[0]!.assetId,
    origin: exactPhotograph ? "photographed" : "generated",
    attempts: 0, configurationFingerprint: configurationFingerprint(),
    provider: { state: "not_sent", calls: 0, reservedUsd: 0, costUsd: 0 }, budget: budgetPolicy(),
    checkpoint: { rawAssetId: randomUUID(), imageAssetId: randomUUID(), alphaAssetId: randomUUID() }, createdAt: now, updatedAt: now };
  if (task.origin === "generated" && (!Number.isFinite(task.budget.maxCostUsd) ||
      !Number.isFinite(task.budget.costPerCallUsd) || task.budget.costPerCallUsd <= 0 ||
      task.budget.maxCostUsd < task.budget.costPerCallUsd ||
      task.budget.costPerCallUsd < serverConfig.myArchitectAIEditCostUsd))
    throw new AdminProductError("Définissez un budget de préparation et un coût fournisseur valides avant la génération.", 422);
  try { await c.tasks.updateOne({ organizationId, businessKey }, { $setOnInsert: task }, { upsert: true }); }
  catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === 11000)) throw error; }
  const saved = await c.tasks.findOne({ organizationId, businessKey });
  if (!saved) throw new AdminProductError("Conflit de demande de préparation.", 409);
  await c.views.updateOne({ organizationId, id: saved.viewId }, { $setOnInsert: initialView(saved) }, { upsert: true });
  return { preparationId: saved.id, viewId: saved.viewId, state: saved.state,
    reused: saved.id !== task.id, providerOutcome: saved.provider.state };
}
function knownMatteSource(task: PreparedViewTask) {
  return (task.origin === "generated" && task.provider.state === "succeeded" && task.provider.calls === 1) ||
    (task.origin === "photographed" && task.provider.state === "not_sent" && task.provider.calls === 0);
}
async function validateMatteRetry(db: Db, task: PreparedViewTask) {
  if (!preparationEnabled(task.organizationId, task.productId)) throw new AdminProductError("La préparation orientée est désactivée pour ce produit.", 403);
  if (task.state !== "failed" || task.failureStage !== "matte")
    throw new AdminProductError("Seul un échec de détourage identifié peut être repris.", 409);
  if (task.retiredAssetsExpireAt) throw new AdminProductError("Cette préparation a été retirée avec son produit.", 409);
  if (!knownMatteSource(task)) throw new AdminProductError("L’issue fournisseur doit être connue avant toute reprise du détourage.", 409);
  if ((task.matteRetries?.length ?? 0) >= MAX_EXPLICIT_MATTE_RETRIES)
    throw new AdminProductError("La limite de reprises du détourage est atteinte.", 409);
  if (!task.checkpoint.rawStored || !task.checkpoint.rawSha256)
    throw new AdminProductError("La préparation ne possède pas d’image brute figée et vérifiable.", 409);
  const view = await preparedCollections(db).views.findOne({ organizationId: task.organizationId, productId: task.productId, id: task.viewId });
  if (!view || view.state !== "failed" || view.image || view.alpha || view.review || view.reviewHistory?.length || view.revocation)
    throw new AdminProductError("La vue a été revue, retirée ou modifiée ; son détourage ne peut pas être remplacé.", 409);
  if (view.origin === "generated" && view.versions.prompt === "prepared-view-v1.0.0")
    throw new AdminProductError("Cette vue utilise une convention d’angle obsolète ; elle ne peut pas être reprise.", 409);
  const product = await findProduct(db, task.organizationId, task.productId);
  const current = await preparedSources(db, product, task.variantId);
  if (current.sourceFingerprint !== task.sourceFingerprint || current.geometryFingerprint !== task.geometryFingerprint)
    throw new AdminProductError("Les photographies, la variante ou les dimensions ont changé. Cette préparation ne peut pas être reprise.", 409);
  const raw = await readAsset(db, task.checkpoint.rawAssetId);
  if (!raw || raw.asset.organizationId !== task.organizationId || raw.asset.visibility !== "private" ||
      raw.asset.kind !== "product_view" || raw.asset.purgeClaimedAt ||
      (raw.asset.expiresAt && raw.asset.expiresAt <= new Date()) || preparedHash(raw.buffer) !== task.checkpoint.rawSha256)
    throw new AdminProductError("L’image brute a expiré, a changé ou est indisponible. Aucune nouvelle génération ne sera lancée.", 409);
  return { view, product };
}
/** Advisory UI status. The mutation repeats every check and fences the task and view. */
export async function preparedMatteRetryAvailability(db: Db, task: PreparedViewTask): Promise<{ eligible: boolean; reason: string | null }> {
  try { await validateMatteRetry(db, task); return { eligible: true, reason: null }; }
  catch (error) {
    if (!(error instanceof AdminProductError)) throw error;
    return { eligible: false, reason: error.message };
  }
}
/** Explicitly re-run only segmentation on verified stored bytes, retaining the paid image intention. */
export async function retryPreparedViewMatte(db: Db, organizationId: string, productId: string, viewId: string,
  actorId: string, input: unknown) {
  const request = retryPreparedViewMatteRequestSchema.parse(input);
  const c = preparedCollections(db);
  const task = await c.tasks.findOne({ organizationId, productId, viewId });
  if (!task) throw new AdminProductError("Préparation introuvable.", 404);
  const requests = db.collection<MatteRetryRequest>("prepared_matte_retry_requests");
  const requestId = preparedHash(JSON.stringify({ organizationId, idempotencyKey: request.idempotencyKey }));
  const existing = await requests.findOne({ _id: requestId });
  const response = (saved: PreparedViewTask, reused: boolean) => ({ preparationId: saved.id, viewId: saved.viewId,
    state: saved.state, reused, providerOutcome: saved.provider.state });
  const sameRequest = (saved: MatteRetryRequest) => saved.productId === productId && saved.viewId === viewId &&
    saved.taskId === task.id && saved.expectedRevision === request.expectedRevision &&
    saved.expectedProductRevision === request.expectedProductRevision;
  if (existing) {
    if (!sameRequest(existing)) throw new AdminProductError("Clé de demande déjà utilisée pour une autre reprise.", 409);
    return response(task, true);
  }
  let validated: Awaited<ReturnType<typeof validateMatteRetry>>;
  try {
    validated = await validateMatteRetry(db, task);
    if (validated.view.revision !== request.expectedRevision || validated.product.updatedAt.toISOString() !== request.expectedProductRevision)
      throw new AdminProductError("La vue ou la fiche produit a changé. Rechargez-la avant de reprendre le détourage.", 409);
  } catch (error) {
    // A simultaneous identical request may commit between the initial read and validation.
    const repeated = await requests.findOne({ _id: requestId });
    if (repeated && sameRequest(repeated)) {
      const saved = await c.tasks.findOne({ organizationId, productId, id: task.id });
      if (saved) return response(saved, true);
    }
    throw error;
  }
  const { view, product } = validated;
  const now = new Date();
  const fingerprint = configurationFingerprint();
  let reused = false;
  await transaction(db, async session => {
    const repeated = await requests.findOne({ _id: requestId }, { session });
    if (repeated) {
      if (!sameRequest(repeated)) throw new AdminProductError("Clé de demande déjà utilisée pour une autre reprise.", 409);
      reused = true;
      return;
    }
    const productFence = await db.collection<ProductDocument & { preparedPublicationFence?: number }>("products").updateOne({
      organizationId, id: productId, updatedAt: product.updatedAt, status: product.status,
      visualizationBlockedReason: product.visualizationBlockedReason === undefined ? { $exists: false } : product.visualizationBlockedReason,
    }, { $inc: { preparedPublicationFence: 1 } }, { session });
    if (!productFence.matchedCount) throw new AdminProductError("Le produit a changé pendant la demande de reprise.", 409);
    const updated = await c.views.updateOne({ organizationId, productId, id: viewId,
      revision: request.expectedRevision, state: "failed" }, { $set: { state: "queued", "versions.mask": PREPARED_MATTE_VERSION,
      updatedAt: now.toISOString() }, $inc: { revision: 1 }, $unset: { preparationLeaseToken: "" } }, { session });
    if (!updated.matchedCount) throw new AdminProductError("La vue a changé ; une reprise est peut-être déjà en cours.", 409);
    const claimed = await c.tasks.updateOne({ organizationId, productId, id: task.id, state: "failed", failureStage: "matte",
      "provider.state": task.provider.state, "provider.calls": task.provider.calls,
      "checkpoint.rawSha256": task.checkpoint.rawSha256, retiredAssetsExpireAt: { $exists: false },
    }, { $set: { state: "queued", executionMode: "matte_only", matteRunAttempts: 0,
      configurationFingerprint: fingerprint, updatedAt: now }, $unset: { lease: "", failure: "", failureStage: "" },
      $push: { matteRetries: { requestId, actorId, requestedAt: now, expectedRevision: request.expectedRevision,
        previousFailure: task.failure ?? "Détourage échoué", previousConfigurationFingerprint: task.configurationFingerprint,
        configurationFingerprint: fingerprint, previousMaskVersion: view.versions.mask, requestedMaskVersion: PREPARED_MATTE_VERSION } },
    }, { session });
    if (!claimed.matchedCount) throw new AdminProductError("La préparation a changé ; aucune reprise supplémentaire n’a été créée.", 409);
    await requests.insertOne({ _id: requestId, organizationId, productId, viewId, taskId: task.id,
      expectedRevision: request.expectedRevision, expectedProductRevision: request.expectedProductRevision }, { session });
  });
  const saved = await c.tasks.findOne({ organizationId, productId, id: task.id });
  if (!saved) throw new AdminProductError("Préparation introuvable après reprise.", 409);
  return response(saved, reused);
}
async function fencedUpdate(db: Db, task: PreparedViewTask, token: string, changes: Record<string, unknown>) {
  const result = await preparedCollections(db).tasks.updateOne({ id: task.id, organizationId: task.organizationId,
    "lease.token": token, "lease.expiresAt": { $gt: new Date() }, state: "preparing" },
  { $set: { ...changes, updatedAt: new Date() } });
  if (!result.matchedCount) throw new AdminProductError("Le bail de préparation a expiré.", 409);
}
async function registerPreparedAssets(db: Db, task: PreparedViewTask, token: string, ids: string[]) {
  const result = await preparedCollections(db).tasks.updateOne({ id: task.id, organizationId: task.organizationId,
    "lease.token": token, "lease.expiresAt": { $gt: new Date() }, state: "preparing" },
  { $push: { stagedAssetIds: { $each: ids } }, $set: { updatedAt: new Date() } });
  if (!result.matchedCount) throw new AdminProductError("Le bail a expiré avant l’écriture des actifs.", 409);
}
async function storePreparedRaw(db: Db, task: PreparedViewTask, token: string, product: ProductDocument,
  buffer: Buffer, contentType: string) {
  // A late upload from an expired worker can never replace the new worker's bytes.
  const rawAssetId = randomUUID();
  await registerPreparedAssets(db, task, token, [rawAssetId]);
  await storeAsset(db, { organizationId: task.organizationId, kind: "product_view", visibility: "organization",
    ...(product.expiresAt ? { expiresAt: product.expiresAt } : {}), buffer, contentType }, rawAssetId);
  const rawSha256 = preparedHash(buffer);
  await fencedUpdate(db, task, token, { "checkpoint.rawAssetId": rawAssetId, "checkpoint.rawStored": true, "checkpoint.rawSha256": rawSha256 });
  Object.assign(task.checkpoint, { rawAssetId, rawStored: true, rawSha256 });
  return readAsset(db, rawAssetId);
}
interface PreparedBudget { _id: string; accountedUsd: number; calls: number }
/** Own catalogue ledger. Unknown calls keep their allocation; no customer credits are touched. */
async function reservePreparedProviderCall(db: Db, task: PreparedViewTask, token: string) {
  const budgets = db.collection<PreparedBudget>("prepared_view_budgets");
  try { await budgets.updateOne({ _id: task.organizationId }, { $setOnInsert: { accountedUsd: 0, calls: 0 } }, { upsert: true }); }
  catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === 11000)) throw error; }
  await transaction(db, async session => {
    const reserved = await budgets.updateOne({ _id: task.organizationId,
      accountedUsd: { $lte: task.budget.maxCostUsd - task.budget.costPerCallUsd } },
    { $inc: { accountedUsd: task.budget.costPerCallUsd, calls: 1 } }, { session });
    if (!reserved.matchedCount) throw new AdminProductError("Budget total de préparation épuisé.", 422);
    const claimed = await preparedCollections(db).tasks.updateOne({ id: task.id, organizationId: task.organizationId,
      "lease.token": token, "lease.expiresAt": { $gt: new Date() }, state: "preparing",
      "provider.state": "not_sent", "provider.calls": 0 }, { $set: {
        "provider.state": "sent", "provider.calls": 1, "provider.reservedUsd": task.budget.costPerCallUsd,
        "provider.accountedUsd": task.budget.costPerCallUsd, updatedAt: new Date(),
      } }, { session });
    if (!claimed.matchedCount) throw new AdminProductError("Une intention fournisseur existe déjà ou le bail a expiré.", 409);
  });
}
async function recordPreparedProviderOutcome(db: Db, task: PreparedViewTask,
  state: PreparedViewTask["provider"]["state"], costUsd: number, observation?: ImageProviderResponseObservation) {
  if (!Number.isFinite(costUsd) || costUsd < 0) throw new Error("Coût fournisseur invalide");
  await transaction(db, async session => {
    const tasks = preparedCollections(db).tasks;
    const current = await tasks.findOne({ id: task.id, organizationId: task.organizationId, "provider.calls": 1 }, { session });
    if (!current) throw new Error("Intention fournisseur introuvable");
    const accountedUsd = state === "unknown" ? Math.max(costUsd, current.provider.reservedUsd) : costUsd;
    const previousAccountedUsd = current.provider.accountedUsd ?? current.provider.reservedUsd;
    await db.collection<PreparedBudget>("prepared_view_budgets").updateOne({ _id: task.organizationId },
      { $inc: { accountedUsd: accountedUsd - previousAccountedUsd } }, { session });
    await tasks.updateOne({ id: task.id, organizationId: task.organizationId }, { $set: {
      "provider.state": state, "provider.costUsd": costUsd, "provider.accountedUsd": accountedUsd,
      ...(observation ? { "provider.observation": observation } : {}),
      ...(state === "not_sent" || state === "rejected" ? { "provider.reservedUsd": 0 } : {}),
      updatedAt: new Date(),
    } }, { session });
  });
}
export async function runPreparedViewTask(db: Db, taskId: string) {
  const c = preparedCollections(db);
  const token = randomUUID();
  const task = await c.tasks.findOneAndUpdate({ id: taskId, state: { $in: ["queued", "preparing"] },
    $or: [{ lease: { $exists: false } }, { "lease.expiresAt": { $lte: new Date() } }] },
  { $set: { state: "preparing", lease: { token, expiresAt: new Date(Date.now() + 240_000) }, updatedAt: new Date() }, $inc: { attempts: 1, matteRunAttempts: 1 } },
  { returnDocument: "after" });
  if (!task) return { processed: false };
  let mattePhase = false;
  try {
    if (!preparationEnabled(task.organizationId, task.productId)) throw new AdminProductError("Préparation désactivée.", 403);
    if (task.configurationFingerprint !== configurationFingerprint()) throw new AdminProductError("Cette préparation nécessite le worker de sa version d’origine.", 409);
    const product = await findProduct(db, task.organizationId, task.productId);
    assertPreparedProduct(product, task.variantId);
    const current = await preparedSources(db, product, task.variantId);
    if (current.sourceFingerprint !== task.sourceFingerprint) throw new AdminProductError("Les photographies ont changé.", 409);
    if (task.executionMode === "matte_only" && current.geometryFingerprint !== task.geometryFingerprint)
      throw new AdminProductError("Les dimensions ont changé depuis la demande de reprise.", 409);
    // Repair an admission interrupted between persisting the task and its view.
    await c.views.updateOne({ organizationId: task.organizationId, id: task.viewId },
      { $setOnInsert: initialView(task) }, { upsert: true });
    await transaction(db, async session => {
      const owned = await c.tasks.updateOne({ id: task.id, organizationId: task.organizationId,
        "lease.token": token, "lease.expiresAt": { $gt: new Date() }, state: "preparing" },
      { $set: { updatedAt: new Date() } }, { session });
      if (!owned.matchedCount) throw new AdminProductError("Le bail a expiré avant la prise en charge de la vue.", 409);
      const claimedView = await c.views.updateOne({ organizationId: task.organizationId, id: task.viewId,
        state: { $in: ["queued", "preparing"] } }, { $set: { state: "preparing", preparationLeaseToken: token } }, { session });
      if (!claimedView.matchedCount) throw new AdminProductError("La vue a été retirée avant sa préparation.", 409);
    });
    let raw = await readAsset(db, task.checkpoint.rawAssetId);
    if (raw && (raw.asset.organizationId !== task.organizationId || raw.asset.visibility !== "private" || raw.asset.purgeClaimedAt ||
      (raw.asset.expiresAt && raw.asset.expiresAt <= new Date()) ||
      (task.checkpoint.rawSha256 && preparedHash(raw.buffer) !== task.checkpoint.rawSha256)))
      throw new AdminProductError("Actif intermédiaire invalide ou modifié.", 409);
    if (task.executionMode === "matte_only" && (!raw || raw.asset.kind !== "product_view" ||
        !task.checkpoint.rawStored || !task.checkpoint.rawSha256 || !knownMatteSource(task)))
      throw new AdminProductError("L’image brute vérifiée n’est plus disponible. La reprise du détourage interdit tout appel de génération ou de récupération fournisseur.", 409);
    if (!raw && task.origin === "generated") {
      if (task.provider.state === "succeeded" && task.provider.observation) {
        const source = await readAsset(db, task.sourceAssetId);
        if (!source) throw new AdminProductError("Source de reprise introuvable.", 409);
        const recovered = await new MyArchitectAIImageProvider().downloadPreparedResponse({
          observation: task.provider.observation, productImage: { data: source.buffer,
            mimeType: source.asset.contentType as "image/webp", role: "product_front" },
          requestedOrientation: task.requestedOrientation, deadlineMs: Date.now() + 90_000,
        });
        if (recovered.status !== "succeeded" || !recovered.images[0])
          throw new AdminProductError("La réponse privée du fournisseur n’est plus récupérable. Aucun nouvel envoi.", 422);
        raw = await storePreparedRaw(db, task, token, product, Buffer.from(recovered.images[0].data), recovered.images[0].mimeType);
      } else if (task.provider.state !== "not_sent" || task.provider.calls > 0) {
        await fencedUpdate(db, task, token, { state: task.provider.state === "succeeded" ? "failed" : "unknown",
          ...(task.provider.state === "succeeded" ? {} : { "provider.state": "unknown" }),
          failure: "Aucune nouvelle génération : réponse fournisseur déjà envoyée. Récupération ou rapprochement requis." });
        return { processed: true, outcome: "blocked_replay" };
      }
      if (!raw) {
      if (task.budget.costPerCallUsd <= 0 || task.budget.maxCostUsd < task.budget.costPerCallUsd)
        throw new AdminProductError("Budget de préparation insuffisant.", 422);
      const provider = new MyArchitectAIImageProvider();
      if (!provider.isAvailable()) throw new AdminProductError("Le fournisseur de préparation est indisponible.", 503);
      const source = await readAsset(db, task.sourceAssetId);
      if (!source) throw new AdminProductError("Source indisponible.", 409);
      const deadlineMs = Date.now() + 150_000;
      const release = await acquireOrientedProviderSlot(db, "myarchitectai", deadlineMs);
      let result: ProviderAttemptResult;
      let rateLimited = false;
      try {
        await reservePreparedProviderCall(db, task, token);
        task.provider.state = "sent";
        result = await provider.prepareView({
        productImage: { data: source.buffer, mimeType: source.asset.contentType as "image/webp", role: "product_front" },
        requestedOrientation: task.requestedOrientation, deadlineMs,
        onProviderResponse: async observation => {
          await recordPreparedProviderOutcome(db, task, "succeeded", observation.estimatedCostUsd, observation);
          task.provider.state = "succeeded"; task.provider.costUsd = observation.estimatedCostUsd;
          task.provider.observation = observation;
        },
      });
        rateLimited = result.error?.httpStatus === 429;
      } finally { await release(rateLimited); }
      const outcome = result.usage?.providerOutcome;
      const state = outcome === "not_sent" || outcome === "succeeded" || outcome === "rejected" ? outcome : "unknown";
      const costUsd = Math.max(task.provider.costUsd, result.estimatedCostUsd);
      await recordPreparedProviderOutcome(db, task, state, costUsd);
      task.provider.state = state; task.provider.costUsd = costUsd;
      if (result.status !== "succeeded" || !result.images[0]) throw new AdminProductError(result.error?.message ?? "Vue non reçue.", 422);
      await fencedUpdate(db, task, token, {});
      raw = await storePreparedRaw(db, task, token, product, Buffer.from(result.images[0].data), result.images[0].mimeType);
      }
    }
    if (!raw) {
      const source = await readAsset(db, task.sourceAssetId);
      if (!source) throw new AdminProductError("Photographie introuvable.", 409);
      raw = await storePreparedRaw(db, task, token, product, source.buffer, source.asset.contentType);
    }
    if (!raw) throw new AdminProductError("La vue intermédiaire est indisponible.", 409);
    mattePhase = true;
    const matte = await prepareViewMatte(raw.buffer);
    await fencedUpdate(db, task, token, { "provider.costUsd": task.provider.costUsd });
    const imageAssetId = randomUUID(), alphaAssetId = randomUUID();
    await registerPreparedAssets(db, task, token, [imageAssetId, alphaAssetId]);
    await storeAsset(db, { organizationId: task.organizationId, kind: "cutout", visibility: "organization",
      ...(product.expiresAt ? { expiresAt: product.expiresAt } : {}),
      buffer: matte.image, contentType: "image/webp" }, imageAssetId);
    await storeAsset(db, { organizationId: task.organizationId, kind: "mask", visibility: "organization",
      ...(product.expiresAt ? { expiresAt: product.expiresAt } : {}),
      buffer: matte.alpha, contentType: "image/png" }, alphaAssetId);
    // Fence immediately before publishing metadata; candidates remain private and unapproved.
    await fencedUpdate(db, task, token, {});
    const dimensions = { widthPx: matte.widthPx, heightPx: matte.heightPx };
    await transaction(db, async session => {
      const products = db.collection<ProductDocument & { preparedPublicationFence?: number }>("products");
      const currentProduct = await products.findOne({ id: task.productId, organizationId: task.organizationId }, { session });
      if (!currentProduct) throw new AdminProductError("Le produit a été supprimé pendant la préparation.", 409);
      assertPreparedProduct(currentProduct, task.variantId);
      if (task.executionMode === "matte_only" && currentProduct.updatedAt.getTime() !== product.updatedAt.getTime())
        throw new AdminProductError("La fiche produit a changé pendant la reprise du détourage.", 409);
      const productFence = await products.updateOne({ id: task.productId, organizationId: task.organizationId,
        status: currentProduct.status, updatedAt: currentProduct.updatedAt,
      }, { $inc: { preparedPublicationFence: 1 } }, { session });
      if (!productFence.matchedCount) throw new AdminProductError("Le produit a changé avant la publication du candidat.", 409);
      const owned = await c.tasks.updateOne({ id: task.id, organizationId: task.organizationId,
        "lease.token": token, "lease.expiresAt": { $gt: new Date() }, state: "preparing" },
      { $set: { state: "needs_review", "checkpoint.imageAssetId": imageAssetId, "checkpoint.alphaAssetId": alphaAssetId,
        updatedAt: new Date() } }, { session });
      if (!owned.matchedCount) throw new AdminProductError("Bail expiré avant validation du candidat.", 409);
    const updated = await c.views.updateOne({ id: task.viewId, organizationId: task.organizationId,
      state: "preparing", preparationLeaseToken: token },
      { $set: { state: "needs_review", image: { assetId: imageAssetId, sha256: preparedHash(matte.image), ...dimensions },
        alpha: { assetId: alphaAssetId, sha256: preparedHash(matte.alpha), ...dimensions },
        visibleBounds: matte.visibleBounds, anchor: matte.anchor, "preparation.costUsd": task.provider.costUsd,
        "versions.mask": matte.version,
        updatedAt: new Date().toISOString() }, $inc: { revision: 1 }, $unset: { preparationLeaseToken: "" } }, { session });
    if (!updated.matchedCount) throw new AdminProductError("La vue a été retirée pendant sa préparation.", 409);
    });
    return { processed: true, outcome: "needs_review" };
  } catch (error) {
    const unknown = task.provider.state === "sent" || task.provider.state === "unknown";
    const retry = !unknown && (task.executionMode === "matte_only" ? task.matteRunAttempts ?? 1 : task.attempts) < 3 &&
      (!(error instanceof AdminProductError) || (error instanceof DurableExecutionError && error.code === "retry"));
    let owned = false;
    await fencedUpdate(db, task, token, { state: unknown ? "unknown" : "failed",
      ...(retry ? { state: "queued", "lease.expiresAt": new Date(0) } : {}),
      ...(mattePhase ? { failureStage: "matte" } : {}),
      ...(unknown ? { "provider.state": "unknown" } : {}),
      failure: error instanceof Error ? error.message : "Préparation impossible." }).then(() => { owned = true; }).catch(() => undefined);
    if (owned && !retry) await c.views.updateOne({ id: task.viewId, organizationId: task.organizationId,
      $or: [{ state: "queued" }, { state: "preparing", preparationLeaseToken: token }] },
      { $set: { state: "failed", "preparation.costUsd": task.provider.costUsd, updatedAt: new Date().toISOString() } });
    const retired = await c.tasks.findOne({ id: task.id, organizationId: task.organizationId });
    if (retired?.retiredAssetsExpireAt) await db.collection("assets").updateMany({ organizationId: task.organizationId,
      id: { $in: [retired.checkpoint.rawAssetId, retired.checkpoint.imageAssetId, retired.checkpoint.alphaAssetId, ...(retired.stagedAssetIds ?? [])] }, expiresAt: { $exists: false },
    }, { $set: { visibility: "private", expiresAt: retired.retiredAssetsExpireAt } });
    return { processed: true, outcome: unknown ? "unknown" : retry ? "queued" : "failed" };
  }
}
export async function runPreparedViewTasks(db: Db, options: { limit?: number } = {}) {
  if (process.env.ORIENTED_PREPARATION_ENABLED !== "true") return { processed: 0 };
  await ensurePreparedViewIndexes(db);
  const tasks = await preparedCollections(db).tasks.find({ state: { $in: ["queued", "preparing"] },
    $or: [{ lease: { $exists: false } }, { "lease.expiresAt": { $lte: new Date() } }] }).sort({ createdAt: 1 })
    .limit(Math.min(3, Math.max(1, options.limit ?? 1))).toArray();
  let processed = 0;
  for (const task of tasks) if ((await runPreparedViewTask(db, task.id)).processed) processed++;
  return { processed };
}
