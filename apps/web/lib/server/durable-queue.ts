import "server-only";
import { createHash } from "node:crypto";
import type { ClientSession, Db, Filter } from "mongodb";
import { serverConfig } from "./config";
import { collections } from "./mongodb";
import type { ProductDocument, RenderDocument, SceneDocument } from "./types";
import type { DurableExecution } from "./durable-types";
import {
  DURABLE_ENGINE_VERSION,
  durableContext,
  DurableExecutionError,
  executionFence,
} from "./durable-context";
import { requireAcceptedQuality } from "./render-quality";
import { renderWorkerRevision } from "../render-worker-revision.mjs";
import { assertSnapshotDeliverable } from "./prepared-views";
import { ORIENTED_HARMONIZATION_PROMPT_VERSION } from "@lili/ai-router";
import { ORIENTED_LAYER_POLICY } from "./oriented-layer-policy";
import { STOREFRONT_HYBRID_PROMPT_VERSION, STOREFRONT_VISUAL_HYBRID_PROMPT_VERSION, STOREFRONT_VISUAL_OPENAI_PROMPT_VERSION } from "./storefront-hybrid";
import {
  SIMPLE_POINT_PROVIDER_POLICY,
  SIMPLE_MYARCHITECTAI_PROMPT_VERSION,
} from "./simple-point-provider";
import {
  effectiveRenderDeadline,
  isTimedStorefrontRender,
  STOREFRONT_RENDER_MAX_MS,
  STOREFRONT_RENDER_DEADLINE_MESSAGE,
} from "./storefront-render-deadline";

export const LEASE_MS = 90_000;
export const MAX_JOB_ATTEMPTS = 12;
export function boundedSetting(
  name: string,
  fallback: number,
  max: number,
): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > max)
    throw new Error(`${name} doit être un entier entre 1 et ${max}.`);
  return value;
}
export function durableEnabled(): boolean {
  return process.env.RENDER_EXECUTION_MODE === "durable";
}

/** A deployment with different models/settings must drain on its original worker. */
export function workerFingerprint(): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        engine: DURABLE_ENGINE_VERSION,
        revision: renderWorkerRevision(process.env),
        model: serverConfig.openaiModel,
        storefrontImageModel: serverConfig.storefrontImageModel,
        storefrontHybridPrompt: STOREFRONT_HYBRID_PROMPT_VERSION,
        storefrontVisualPrompt: STOREFRONT_VISUAL_HYBRID_PROMPT_VERSION,
        storefrontVisualOpenAIPrompt: STOREFRONT_VISUAL_OPENAI_PROMPT_VERSION,
        vision: serverConfig.openaiVisionModel,
        quality: serverConfig.openaiQuality,
        serviceTier: serverConfig.openaiServiceTier,
        mock: serverConfig.aiMockMode,
        renderStageCapture: Boolean(serverConfig.renderStageCapture),
        enabled: serverConfig.openAIImageEnabled,
        openaiAvailable: Boolean(serverConfig.openaiApiKey),
        endpoint: serverConfig.openaiBaseUrl,
        googleAvailable: Boolean(serverConfig.googleApiKey),
        googlePreview: serverConfig.googlePreviewImageModel,
        googleFinal: serverConfig.googleFinalImageModel,
        googleEndpoint: serverConfig.googleApiBaseUrl,
        googleTimeout: serverConfig.googleTimeoutMs,
        googleMaxCost: serverConfig.googleMaxCostUsd,
        openaiMaxCost: serverConfig.openaiMaxCostUsd,
        simplePointImageProvider: serverConfig.simplePointImageProvider,
        simplePointProviderPolicy: SIMPLE_POINT_PROVIDER_POLICY,
        simpleMyArchitectAIPrompt: SIMPLE_MYARCHITECTAI_PROMPT_VERSION,
        myArchitectAIAvailable: Boolean(serverConfig.myArchitectAIApiKey),
        myArchitectAITimeout: serverConfig.myArchitectAITimeoutMs,
        myArchitectAIEditCost: serverConfig.myArchitectAIEditCostUsd,
        renderMaxCost: process.env.RENDER_MAX_COST_USD ?? null,
        orientedVersion: "oriented-v1",
        orientedLightPolicy: "oriented-light-v1",
        orientedLayerPolicy: ORIENTED_LAYER_POLICY,
        orientedHarmonizationPrompt: ORIENTED_HARMONIZATION_PROMPT_VERSION,
      }),
    )
    .digest("hex");
}

export function prepareExecution(
  scene: SceneDocument,
  products: ProductDocument[],
  render?: RenderDocument,
): DurableExecution {
  // Le contrat fige les sources et la configuration du worker ; son échéance
  // précède leur expiration déclarée. Le worker revérifie leur présence à la reprise.
  const now = new Date();
  const deadlineAt = new Date(
    Math.min(
      now.getTime() +
        boundedSetting("RENDER_DEADLINE_SECONDS", 1800, 7200) * 1000,
      scene.expiresAt.getTime() - 60_000,
      ...products.map((p) =>
        p.expiresAt ? p.expiresAt.getTime() - 60_000 : Infinity,
      ),
    ),
  );
  if (deadlineAt.getTime() - now.getTime() < 300_000)
    throw new DurableExecutionError(
      "Les sources arrivent à expiration. Réimportez-les.",
      "permanent",
    );
  if (render && isTimedStorefrontRender(render)) {
    deadlineAt.setTime(Math.min(deadlineAt.getTime(), render.createdAt.getTime() + STOREFRONT_RENDER_MAX_MS));
    if (deadlineAt.getTime() <= now.getTime())
      throw new DurableExecutionError(STOREFRONT_RENDER_DEADLINE_MESSAGE, "deadline");
  }
  return {
    version: DURABLE_ENGINE_VERSION,
    configFingerprint: workerFingerprint(),
    deadlineAt,
    availableAt: now,
    attempts: 0,
    steps: {},
    sourceAssetIds: [
      ...new Set([
        scene.assetId,
        ...products
          .flatMap((p) => [
            p.assetId,
            p.cutoutAssetId,
            ...(p.views ?? []).map((v) => v.assetId),
          ])
          .filter((id): id is string => Boolean(id)),
      ]),
    ],
    scene,
    products,
  };
}

export async function transaction<T>(
  db: Db,
  work: (session: ClientSession) => Promise<T>,
): Promise<T> {
  const session = db.client.startSession();
  try {
    return await session.withTransaction(() => work(session), {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
      readPreference: "primary",
    });
  } finally {
    await session.endSession();
  }
}

/** No fallback to standalone MongoDB: settlement requires real transactions. */
export async function assertDurableDatabase(db: Db): Promise<void> {
  const hello = await db.command({ hello: 1 });
  if (!hello.setName && hello.msg !== "isdbgrid")
    throw new Error(
      "Le worker nécessite MongoDB replica set ou Atlas (transactions).",
    );
  await db
    .collection("render_dispatch")
    .updateOne(
      { key: "global" },
      { $setOnInsert: { key: "global", revision: 0 } },
      { upsert: true },
    );
}

export async function claimRender(
  db: Db,
  workerId: string,
): Promise<RenderDocument | null> {
  return transaction(db, async (session) => {
    // Serialize only dispatch decisions; provider work runs outside transactions.
    // This shared write prevents write skew on both concurrency counters.
    await db
      .collection("render_dispatch")
      .updateOne({ key: "global" }, { $inc: { revision: 1 } }, { session });
    const c = collections(db);
    const now = new Date();
    const active: Filter<RenderDocument> = {
      status: "processing",
      "execution.leaseUntil": { $gt: now },
    };
    if (
      (await c.renders.countDocuments(active, { session })) >=
      boundedSetting("RENDER_GLOBAL_CONCURRENCY", 4, 64)
    )
      return null;
    const candidates = await c.renders
      .find(
        {
          status: { $in: ["queued", "processing"] },
          "execution.version": DURABLE_ENGINE_VERSION,
          "execution.configFingerprint": workerFingerprint(),
          "execution.deadlineAt": { $gt: now },
          "execution.availableAt": { $lte: now },
          "execution.attempts": { $lt: MAX_JOB_ATTEMPTS },
          $or: [
            { "execution.leaseUntil": { $exists: false } },
            { "execution.leaseUntil": { $lte: now } },
          ],
        },
        { session },
      )
      .sort({ "execution.availableAt": 1, createdAt: 1 })
      .limit(100)
      .toArray();
    for (const candidate of candidates) {
      if (
        (await c.renders.countDocuments(
          { ...active, organizationId: candidate.organizationId },
          { session },
        )) >= boundedSetting("RENDER_TENANT_CONCURRENCY", 2, 32)
      )
        continue;
      return c.renders.findOneAndUpdate(
        {
          id: candidate.id,
          organizationId: candidate.organizationId,
          status: candidate.status,
        },
        {
          $set: {
            status: "processing",
            "execution.token": crypto.randomUUID(),
            "execution.workerId": workerId,
            "execution.leaseUntil": new Date(now.getTime() + LEASE_MS),
            updatedAt: now,
          },
          $inc: { "execution.attempts": 1 },
        },
        { returnDocument: "after", session },
      );
    }
    return null;
  });
}

export async function heartbeat(
  db: Db,
  render: RenderDocument,
  token: string,
): Promise<boolean> {
  const now = new Date();
  const result = await collections(db).renders.updateOne(
    {
      id: render.id,
      organizationId: render.organizationId,
      status: "processing",
      "execution.token": token,
      "execution.leaseUntil": { $gt: now },
      "execution.deadlineAt": { $gt: now },
    },
    {
      $set: {
        "execution.leaseUntil": new Date(now.getTime() + LEASE_MS),
        updatedAt: now,
      },
    },
  );
  return result.matchedCount === 1;
}

export async function assertExecutionActive(
  db: Db,
  renderId: string,
): Promise<void> {
  const active = durableContext.getStore()?.render;
  if (active?.execution && active.execution.deadlineAt.getTime() <= Date.now())
    throw new DurableExecutionError(RENDER_DEADLINE_MESSAGE, "deadline");
  if (
    !(await collections(db).renders.findOne({
      id: renderId,
      status: "processing",
      ...executionFence(renderId),
    }))
  )
    throw new DurableExecutionError(
      "Ce traitement a été interrompu ou repris par un autre worker.",
      "lease_lost",
    );
}

export async function reserveDurableCredit(
  db: Db,
  render: RenderDocument,
): Promise<void> {
  await transaction(db, async (session) => {
    const c = collections(db);
    const active = await c.renders.updateOne(
      { id: render.id, status: "processing", ...executionFence(render.id) },
      { $set: { updatedAt: new Date() } },
      { session },
    );
    if (!active.matchedCount)
      throw new DurableExecutionError("Rendu interrompu.", "lease_lost");
    const key = `render:${render.id}`;
    if (
      await c.wallets.findOne(
        { organizationId: render.organizationId, "holds.key": key },
        { session },
      )
    )
      return;
    const held = await c.wallets.updateOne(
      { organizationId: render.organizationId, balance: { $gte: 1 } },
      {
        $inc: { balance: -1, reserved: 1 },
        $push: { holds: { key, reservedAt: new Date() } },
        $set: { updatedAt: new Date() },
      },
      { session },
    );
    if (!held.matchedCount)
      throw new DurableExecutionError("Crédits insuffisants.", "permanent");
  });
}

export async function validateExecutionSources(
  db: Db,
  render: RenderDocument,
): Promise<void> {
  const execution = render.execution!;
  const c = collections(db);
  const scene = await c.scenes.findOne({
    id: render.sceneId,
    organizationId: render.organizationId,
    ...(render.publicSessionId
      ? { publicSessionId: render.publicSessionId }
      : {}),
  });
  if (
    !scene ||
    scene.status === "deleted" ||
    scene.expiresAt.getTime() <= Date.now()
  )
    throw new DurableExecutionError(
      "Photo de la pièce expirée ou supprimée.",
      "permanent",
    );
  for (const id of execution.sourceAssetIds) {
    const asset = await c.assets.findOne({
      id,
      organizationId: render.organizationId,
    });
    if (
      !asset ||
      asset.purgeClaimedAt ||
      (asset.expiresAt && asset.expiresAt.getTime() <= Date.now()) ||
      (render.publicSessionId &&
        asset.visibility !== "published" &&
        asset.ownerSessionId !== render.publicSessionId)
    )
      throw new DurableExecutionError(
        "Une source du rendu est inaccessible ou expirée.",
        "permanent",
      );
  }
}

/** Wallet, journal and delivery are one commit; cancellation conflicts on render. */
export async function completeDurableRender(
  db: Db,
  render: RenderDocument,
  update: Partial<RenderDocument>,
): Promise<boolean> {
  if (!update.qualityDecision || !update.resultAssetId)
    throw new DurableExecutionError("Résultat vérifié manquant.", "permanent");
  requireAcceptedQuality(update.qualityDecision, serverConfig.aiMockMode);
  return transaction(db, async (session) => {
    const c = collections(db);
    if (render.engine === "oriented") {
      const selected = render.execution?.preparedViews?.find(snapshot =>
        snapshot.snapshotFingerprint === update.orientedEvidence?.snapshotFingerprint);
      if (!selected) throw new DurableExecutionError("Vue admise manquante à la livraison.", "permanent");
      await assertSnapshotDeliverable(db, selected, { session });
    }
    const changed = await c.renders.updateOne(
      { id: render.id, status: "processing", ...executionFence(render.id) },
      {
        $set: {
          ...update,
          status: "succeeded",
          pipelineState: "completed",
          creditCharged: true,
          updatedAt: new Date(),
        },
        $unset: {
          "execution.token": "",
          "execution.leaseUntil": "",
          error: "",
          "execution.errorCode": "",
        },
      },
      { session },
    );
    if (!changed.matchedCount)
      throw new DurableExecutionError(
        "La finalisation a perdu son bail.",
        "lease_lost",
      );
    const asset = await c.assets.findOne(
      {
        id: update.resultAssetId,
        organizationId: render.organizationId,
        expiresAt: { $gt: new Date() },
      },
      { session },
    );
    if (
      !asset ||
      (render.publicSessionId &&
        asset.ownerSessionId !== render.publicSessionId)
    )
      throw new DurableExecutionError(
        "Résultat expiré ou inaccessible.",
        "permanent",
      );
    const key = `render:${render.id}`;
    const wallet = await c.wallets.findOneAndUpdate(
      { organizationId: render.organizationId, "holds.key": key },
      {
        $inc: { reserved: -1 },
        $pull: { holds: { key } },
        $set: { updatedAt: new Date() },
      },
      { session, returnDocument: "after" },
    );
    if (!wallet)
      throw new DurableExecutionError(
        "Réservation de crédit manquante.",
        "permanent",
      );
    await c.creditTransactions.updateOne(
      { organizationId: render.organizationId, idempotencyKey: key },
      {
        $setOnInsert: {
          id: crypto.randomUUID(),
          organizationId: render.organizationId,
          idempotencyKey: key,
          type: "render_capture",
          amount: -1,
          status: "captured",
          balanceAfter: wallet.balance,
          createdAt: new Date(),
        },
      },
      { session, upsert: true },
    );
    return true;
  });
}

export async function endDurableRender(
  db: Db,
  render: RenderDocument,
  status: "failed" | "cancelled" | "deleted",
  error?: string,
  errorCode?: string,
  fenced = false,
): Promise<RenderDocument | null> {
  return transaction(db, async (session) => {
    const c = collections(db);
    const changed = await c.renders.findOneAndUpdate(
      {
        id: render.id,
        organizationId: render.organizationId,
        ...(status === "deleted"
          ? { status: { $ne: "deleted" as const } }
          : {
              status: {
                $in: ["queued", "processing"] as RenderDocument["status"][],
              },
            }),
        ...(fenced ? executionFence(render.id) : {}),
      },
      {
        $set: {
          status,
          ...(status === "deleted"
            ? {}
            : {
                pipelineState:
                  status === "failed"
                    ? ("failed" as const)
                    : ("refunded" as const),
              }),
          updatedAt: new Date(),
          ...(error ? { error } : {}),
          // Historical inline shop jobs have no durable execution envelope.
          // Creating a partial one would make their polling response unreadable.
          ...(errorCode && render.execution ? { "execution.errorCode": errorCode } : {}),
          ...(status === "cancelled" ? { cancelledAt: new Date() } : {}),
        },
        $unset: { "execution.token": "", "execution.leaseUntil": "" },
      },
      { session, returnDocument: "after" },
    );
    if (!changed) return null;
    const key = `render:${render.id}`;
    const wallet = await c.wallets.findOneAndUpdate(
      { organizationId: render.organizationId, "holds.key": key },
      {
        $inc: { balance: 1, reserved: -1 },
        $pull: { holds: { key } },
        $set: { updatedAt: new Date() },
      },
      { session, returnDocument: "after" },
    );
    if (wallet)
      await c.creditTransactions.updateOne(
        {
          organizationId: render.organizationId,
          idempotencyKey: `${key}:release`,
        },
        {
          $setOnInsert: {
            id: crypto.randomUUID(),
            organizationId: render.organizationId,
            idempotencyKey: `${key}:release`,
            type: "render_release",
            amount: 1,
            status: "released",
            balanceAfter: wallet.balance,
            createdAt: new Date(),
          },
        },
        { session, upsert: true },
      );
    return changed;
  });
}

export async function retryDurableRender(
  db: Db,
  render: RenderDocument,
  error: string,
  yielded = false,
): Promise<void> {
  // Un yield conserve le crédit/checkpoints et rend sa tentative d'acquisition.
  // Une vraie erreur conserve cette tentative et attend le délai exponentiel.
  const delayMs = Math.min(
    120_000,
    5_000 * 2 ** Math.min(render.execution!.attempts - 1, 5),
  );
  const availableAt = new Date(Date.now() + (yielded ? 0 : delayMs));
  if (isTimedStorefrontRender(render) && availableAt.getTime() >= effectiveRenderDeadline(render)) {
    await endDurableRender(db, render, "failed", STOREFRONT_RENDER_DEADLINE_MESSAGE, "deadline");
    return;
  }
  await collections(db).renders.updateOne(
    { id: render.id, status: "processing", ...executionFence(render.id) },
    {
      $set: {
        status: "queued",
        "execution.availableAt": availableAt,
        "execution.lastError": error.slice(0, 500),
        updatedAt: new Date(),
      },
      $unset: { "execution.token": "", "execution.leaseUntil": "" },
      ...(yielded ? { $inc: { "execution.attempts": -1 } } : {}),
    },
  );
}

export async function expireDurableRenders(db: Db): Promise<number> {
  const expired = await collections(db)
    .renders.find({
      status: { $in: ["queued", "processing"] },
      execution: { $exists: true },
      $or: [
        { "execution.deadlineAt": { $lte: new Date() } },
        {
          engine: { $nin: ["spatial", "oriented"] },
          publicSessionId: { $regex: "^storefront:" },
          "requestSnapshot.input.workflow": "simple_point",
          createdAt: { $lte: new Date(Date.now() - STOREFRONT_RENDER_MAX_MS) },
        },
        {
          "execution.attempts": { $gte: MAX_JOB_ATTEMPTS },
          "execution.leaseUntil": { $lte: new Date() },
        },
        { "execution.attempts": { $gte: MAX_JOB_ATTEMPTS }, status: "queued" },
      ],
    })
    .limit(200)
    .toArray();
  let count = 0;
  for (const render of expired)
    if (
      await endDurableRender(
        db,
        render,
        "failed",
        isTimedStorefrontRender(render) ? STOREFRONT_RENDER_DEADLINE_MESSAGE : RENDER_DEADLINE_MESSAGE,
        "deadline",
      )
    )
      count++;
  return count;
}

export const RENDER_DEADLINE_MESSAGE =
  "Le délai ou le nombre de reprises est dépassé. Aucun crédit n’est débité.";

/** Reconcile one owned render without making a polling request run the worker. */
export async function reconcileRenderDeadline(
  db: Db,
  render: RenderDocument,
): Promise<RenderDocument> {
  if ((!render.execution && !isTimedStorefrontRender(render)) || !["queued", "processing"].includes(render.status) ||
      effectiveRenderDeadline(render) > Date.now()) return render;
  return await endDurableRender(db, render, "failed", isTimedStorefrontRender(render) ? STOREFRONT_RENDER_DEADLINE_MESSAGE : RENDER_DEADLINE_MESSAGE, "deadline") ??
    await collections(db).renders.findOne({ id: render.id, organizationId: render.organizationId }) ?? render;
}
