import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import sharp from "sharp";
import type { Db } from "mongodb";
import { serverConfig } from "./config";
import { collections } from "./mongodb";
import { readAsset, storeAsset, assetUrl } from "./assets";
import { admitPreparedViews } from "./prepared-views";
import { validateOrientedAdmission } from "./oriented-policy";
import { buildOrientedPlacementPlan } from "./oriented-selection";
import { composeOrientedView } from "./oriented-composite";
import { getRoomGeometry } from "./spatial-planning";
import { analyzeSpatialRoom } from "./spatial-scene-cache";
import {
  spatialVisionAllowance,
  spatialVisionAdmissionPolicy,
  estimateVisionUsage,
  visionObservation,
} from "./ai/openai-vision-cost";
import { acquireOrientedProviderSlot } from "./oriented-provider-execution";
import type { SceneDocument } from "./types";

export const orientedPreviewRequestSchema = z
  .object({
    productId: z.string().uuid(),
    variantId: z.string().min(1).max(160).nullable().default(null),
    point: z
      .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
      .strict(),
    surfaceType: z.enum(["floor", "tabletop", "shelf"]),
    yawDegrees: z.number().min(-180).max(180).default(0),
  })
  .strict();
/** Scene-level vision expense belongs to the internal preview budget. Cache
 * reuse is free; an unobserved request is never re-issued by moving the point. */
export async function previewOrientedPlacement(
  db: Db,
  scene: SceneDocument,
  body: unknown,
) {
  const input = orientedPreviewRequestSchema.parse(body);
  const original = await collections(db).products.findOne({
    id: input.productId,
    organizationId: scene.organizationId,
  });
  if (!original)
    throw Object.assign(new Error("Produit introuvable."), { status: 404 });
  const product = validateOrientedAdmission(
    {
      engine: "oriented",
      placement: { sceneId: scene.id, productId: input.productId },
      idempotencyKey: "preview",
      orientedVariantId: input.variantId,
      surfaceType: input.surfaceType,
    },
    original,
    {
      enabled: serverConfig.orientedOrganizationIds.includes(
        scene.organizationId,
      ),
      productIds: serverConfig.orientedProductIds,
      publicSessionId: scene.publicSessionId,
    },
  );
  const snapshots = await admitPreparedViews(
    db,
    scene.organizationId,
    original,
    input.variantId,
  );
  const asset = await readAsset(db, scene.assetId);
  if (
    !asset ||
    scene.status === "deleted" ||
    scene.expiresAt.getTime() <= Date.now()
  )
    throw Object.assign(new Error("Photo expirée."), { status: 410 });
  const room = await sharp(asset.buffer).rotate().png().toBuffer();
  const model = serverConfig.openaiVisionModel;
  const deadlineMs = Date.now() + 90_000;
  const analysis = await getRoomGeometry(
    db,
    scene,
    room,
    model,
    deadlineMs,
    async () => {
      if (!serverConfig.openaiApiKey || serverConfig.aiMockMode)
        throw Object.assign(
          new Error("L’analyse de pièce n’est pas configurée."),
          { status: 503 },
        );
      const allowance = spatialVisionAllowance({
        ...spatialVisionAdmissionPolicy(model),
        policy: spatialVisionAdmissionPolicy(model).visionCostPolicy,
        model,
        maxOutputTokens: 9000,
      }).estimatedCostUsd;
      const budget = Number(process.env.ORIENTED_PREVIEW_MAX_COST_USD ?? 0);
      if (!Number.isFinite(budget) || allowance > budget || budget <= 0)
        throw Object.assign(
          new Error(
            "Le budget d’analyse des aperçus internes n’est pas configuré ou est insuffisant.",
          ),
          { status: 402 },
        );
      const key = createHash("sha256")
        .update(
          JSON.stringify([
            scene.organizationId,
            scene.id,
            createHash("sha256").update(room).digest("hex"),
            model,
          ]),
        )
        .digest("hex");
      const ledger = db.collection<{
        _id: string;
        outcome: string;
        estimatedCostUsd: number;
        organizationId: string;
        expiresAt: Date;
        createdAt: Date;
      }>("oriented_preview_usage");
      const release = await acquireOrientedProviderSlot(
        db,
        "openai",
        deadlineMs,
      );
      try {
        try {
          await ledger.insertOne({
            _id: key,
            organizationId: scene.organizationId,
            outcome: "unknown",
            estimatedCostUsd: allowance,
            expiresAt: scene.expiresAt,
            createdAt: new Date(),
          });
        } catch (reason) {
          if (
            reason &&
            typeof reason === "object" &&
            "code" in reason &&
            reason.code === 11000
          )
            throw Object.assign(
              new Error(
                "Une analyse a déjà été envoyée. Sa reprise nécessite un résultat conservé.",
              ),
              { status: 409 },
            );
          throw reason;
        }
        try {
          const result = await analyzeSpatialRoom(room, model, deadlineMs);
          await ledger.updateOne(
            { _id: key },
            {
              $set: {
                outcome: "succeeded",
                estimatedCostUsd: estimateVisionUsage(
                  visionObservation(result),
                  allowance,
                ).estimatedCostUsd,
              },
            },
          );
          return result;
        } catch (reason) {
          if (visionObservation(reason))
            await ledger.updateOne(
              { _id: key },
              {
                $set: {
                  outcome: "rejected",
                  estimatedCostUsd: estimateVisionUsage(
                    visionObservation(reason),
                    allowance,
                  ).estimatedCostUsd,
                },
              },
            );
          throw reason;
        }
      } finally {
        await release();
      }
    },
  );
  const dimensions = await sharp(room).metadata(),
    first = snapshots[0]!.view;
  const plan = buildOrientedPlacementPlan({
    scene: analysis.value,
    fingerprint: analysis.fingerprint,
    width: dimensions.width!,
    height: dimensions.height!,
    point: input.point,
    kind: input.surfaceType === "tabletop" ? "table" : input.surfaceType,
    size: {
      widthCm: product.widthCm,
      heightCm: product.heightCm,
      depthCm: product.depthCm,
    },
    yawDegrees: input.yawDegrees,
    views: snapshots.map((s) => s.view),
    organizationId: scene.organizationId,
    productId: product.id,
    variantId: input.variantId,
    sourceFingerprint: first.sourceFingerprint,
    geometryFingerprint: first.geometryFingerprint,
  });
  const image = await readAsset(db, plan.view.image!.assetId),
    alpha = await readAsset(db, plan.view.alpha!.assetId);
  if (!image || !alpha)
    throw Object.assign(new Error("Vue préparée inaccessible."), {
      status: 410,
    });
  const layers = await composeOrientedView({
    scene: room,
    viewImage: image.buffer,
    viewAlpha: alpha.buffer,
    plan,
  });
  const preview = await storeAsset(db, {
    organizationId: scene.organizationId,
    kind: "render",
    visibility: "organization",
    buffer: layers.previewPng,
    contentType: "image/png",
    expiresAt: scene.expiresAt,
  });
  return {
    previewUrl: assetUrl(preview.id),
    planFingerprint: plan.planFingerprint,
    selectedViewId: plan.view.id,
    scaleEstimated: true,
    reconstructed: plan.view.origin === "generated",
    approvedRender: false,
    limitations: plan.view.review?.limits ?? [],
    unknownFaces: plan.view.review?.unknownFaces ?? [],
  };
}
