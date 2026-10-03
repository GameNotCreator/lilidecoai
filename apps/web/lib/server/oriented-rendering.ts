import "server-only";
import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import sharp from "sharp";
import { renderViewSnapshotSchema, type QualityDecision } from "@lili/types";
import { serverConfig } from "./config";
import { collections } from "./mongodb";
import { ORIENTED_HARMONIZATION_PROMPT_VERSION, type ImageProviderResponseObservation } from "@lili/ai-router";
import { privateVisibility, readAsset, storeAsset } from "./assets";
import { durableStep } from "./durable-steps";
import { DurableExecutionError, renderDeadline } from "./durable-context";
import { advanceRender, completeRender } from "./render-lifecycle";
import { requireAcceptedQuality } from "./render-quality";
import { getRoomGeometry } from "./spatial-planning";
import { analyzeSpatialRoom } from "./spatial-scene-cache";
import { spatialVisionAllowance } from "./ai/openai-vision-cost";
import { MyArchitectAIImageProvider } from "./ai/myarchitectai";
import { reviewOrientedCandidate } from "./ai/oriented-review";
import {
  assertSnapshotDeliverable,
  verifyPreparedViewAssets,
} from "./prepared-views";
import {
  buildOrientedPlacementPlan,
  type OrientedPlacementPlan,
} from "./oriented-selection";
import {
  composeOrientedView,
  harmonizeOrientedLayers,
} from "./oriented-composite";
import { decideOrientedQuality } from "./oriented-quality";
import {
  orientedProviderCall,
  recordOrientedImageResponse,
} from "./oriented-provider-execution";
import { renderUsageTotals, renderBudgetUsd } from "./provider-usage";
import type { ProductDocument, RenderDocument, SceneDocument } from "./types";
import type { RenderInput } from "./render-request";

const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
async function pngAsset(db: Db, id: string) {
  const asset = await readAsset(db, id);
  if (!asset)
    throw new DurableExecutionError(
      "Une source du rendu a expiré.",
      "permanent",
    );
  return sharp(asset.buffer).rotate().png().toBuffer();
}
function reviewPlan(plan: OrientedPlacementPlan) {
  return {
    fingerprint: plan.planFingerprint,
    point: plan.anchor,
    bounds: plan.visibleBounds,
    dimensions: plan.spatial.projection,
    orientation: plan.localOrientation,
    uncertainty: plan.orientationUncertainty,
    limitations: plan.view.review?.limits,
    unknownFaces: plan.view.review?.unknownFaces,
    metricVerified: false,
  };
}
export async function runOrientedRender(
  db: Db,
  render: RenderDocument,
  scene: SceneDocument,
  product: ProductDocument,
  input: RenderInput,
) {
  const snapshots = render.execution!.preparedViews!.map((v) =>
    renderViewSnapshotSchema.parse(v),
  );
  const deadlineMs = renderDeadline(render.createdAt.getTime());
  const model = render.engineVersions!.visionModel;
  const allowance = (maxOutputTokens: number) =>
    spatialVisionAllowance({
      policy: render.engineVersions?.visionCostPolicy,
      model,
      maxOutputTokens,
    }).estimatedCostUsd;
  const reviewCost = allowance(6000),
    imageCost = serverConfig.myArchitectAIEditCostUsd;
  const room = await pngAsset(db, scene.assetId);
  await advanceRender(db, render.id, {
    $set: { pipelineState: "analyzing_scene" },
  });
  const analysis = await durableStep(db, "oriented-room", "analysis", () =>
    getRoomGeometry(db, scene, room, model, deadlineMs, () =>
      orientedProviderCall(
        db,
        render,
        {
          key: "oriented-analysis",
          provider: "openai",
          model,
          policy: "analysis",
          allowanceUsd: allowance(9000),
          reserveAfterUsd: imageCost + 2 * reviewCost,
          deadlineMs,
        },
        () => analyzeSpatialRoom(room, model, deadlineMs),
      ),
    ),
  );
  await advanceRender(db, render.id, {
    $set: { pipelineState: "computing_geometry" },
  });
  const plan = await durableStep(
    db,
    "oriented-selection",
    "analysis",
    async () => {
      const meta = await sharp(room).metadata();
      const view = snapshots[0]!.view;
      return buildOrientedPlacementPlan({
        scene: analysis.value,
        fingerprint: analysis.fingerprint,
        width: meta.width!,
        height: meta.height!,
        point: render.placementPoint!,
        kind:
          render.surfaceType === "floor"
            ? "floor"
            : render.surfaceType === "shelf"
              ? "shelf"
              : "table",
        size: {
          widthCm: product.widthCm,
          heightCm: product.heightCm,
          depthCm: product.depthCm,
        },
        yawDegrees: input.orientedYawDegrees,
        views: snapshots.map((s) => s.view),
        organizationId: render.organizationId,
        productId: product.id,
        variantId: input.orientedVariantId ?? null,
        sourceFingerprint: view.sourceFingerprint,
        geometryFingerprint: view.geometryFingerprint,
      });
    },
  );
  const snapshot = snapshots.find(
    (s) => s.view.id === plan.view.id && s.view.revision === plan.view.revision,
  );
  if (
    input.orientedPlanFingerprint &&
    input.orientedPlanFingerprint !== plan.planFingerprint
  )
    throw new DurableExecutionError(
      "Le catalogue ou la pose ont changé. Recalculez l’aperçu avant de demander le rendu.",
      "permanent",
    );
  if (!snapshot)
    throw new DurableExecutionError(
      "La vue choisie ne figure pas dans les sources admises.",
      "permanent",
    );
  await assertSnapshotDeliverable(db, snapshot);
  await verifyPreparedViewAssets(db, plan.view);
  const [viewImage, viewAlpha] = await Promise.all([
    readAsset(db, plan.view.image!.assetId),
    readAsset(db, plan.view.alpha!.assetId),
  ]);
  if (!viewImage || !viewAlpha)
    throw new DurableExecutionError("Vue préparée inaccessible.", "permanent");
  // Only compressed images are checkpointed. Raw layers are cheap, deterministic
  // derivations from the frozen plan and must never masquerade as encoded assets.
  const layers = await composeOrientedView({
    scene: room,
    viewImage: viewImage.buffer,
    viewAlpha: viewAlpha.buffer,
    plan,
  });
  const composite = await durableStep(
    db,
    "oriented-composition",
    "analysis",
    async () => ({
      assetId: (
        await storeAsset(db, {
          organizationId: render.organizationId,
          kind: "render",
          visibility: privateVisibility(render.publicSessionId),
          buffer: layers.previewPng,
          contentType: "image/png",
          expiresAt: scene.expiresAt,
        })
      ).id,
    }),
  );
  const evidence: NonNullable<RenderDocument["orientedEvidence"]> = {
    version: "oriented-v1",
    selectedViewId: plan.view.id,
    snapshotFingerprint: snapshot.snapshotFingerprint,
    origin: plan.view.origin,
    metricVerified: false,
    limitations: [
      "Échelle estimée.",
      ...(plan.view.review?.limits ?? []),
      ...(plan.view.review?.unknownFaces ?? []),
    ],
    plan,
  };
  await advanceRender(db, render.id, {
    $set: {
      compositeAssetId: composite.assetId,
      orientedEvidence: evidence,
      pipelineState: "generating_final",
    },
  });
  const originals = await Promise.all(
    plan.view.sources.map(async (source) => ({
      assetId: source.assetId,
      buffer: await pngAsset(db, source.assetId),
    })),
  );
  const prepared = await pngAsset(db, plan.view.image!.assetId);
  const provider = new MyArchitectAIImageProvider();
  let repairInstructions = "";
  for (let attempt = 0; attempt <= 1; attempt++) {
    let result = await orientedProviderCall(
      db,
      render,
      {
        key: `oriented-image-${attempt}`,
        provider: "myarchitectai",
        model: provider.model,
        policy: "image",
        allowanceUsd: imageCost,
        reserveAfterUsd: 2 * reviewCost,
        deadlineMs: deadlineMs - 120_000,
        promptVersion: ORIENTED_HARMONIZATION_PROMPT_VERSION,
      },
      () =>
        provider.harmonize({
          composition: {
            data: layers.previewPng,
            mimeType: "image/png",
            role: "composition",
          },
          instructions: repairInstructions,
          deadlineMs: deadlineMs - 120_000,
          onProviderResponse: (observation) =>
            recordOrientedImageResponse(
              db,
              render,
              `oriented-image-${attempt}`,
              observation,
            ),
        }),
      (observation) =>
        provider.downloadHarmonizationResponse({
          observation,
          composition: {
            data: layers.previewPng,
            mimeType: "image/png",
            role: "composition",
          },
          deadlineMs: deadlineMs - 120_000,
        }),
    );
    if (result.error?.code === "image_download_failed" && result.usage?.providerOutcome === "succeeded") {
      result = await durableStep(db, `oriented-download-${attempt}`, "analysis", async () => {
        const intent = await collections(db).renderAttempts.findOne({ id: `${render.id}:oriented-image-${attempt}`, organizationId: render.organizationId });
        const observation = intent?.usage?.providerResponse as ImageProviderResponseObservation | undefined;
        if (!observation || observation.outcome !== "succeeded")
          throw new DurableExecutionError("La référence privée de téléchargement est indisponible.", "permanent");
        const recovered = await provider.downloadHarmonizationResponse({ observation, composition: { data: layers.previewPng, mimeType: "image/png", role: "composition" }, deadlineMs: deadlineMs - 120_000 });
        if (recovered.error?.code === "image_download_failed")
          throw new DurableExecutionError("Le téléchargement de l’image payée sera repris, sans nouvelle génération.", "retry");
        if (recovered.status === "succeeded") await collections(db).renderAttempts.updateOne({ id: intent!.id }, { $set: { status: "succeeded", usageOutcome: "succeeded", "usage.downloadRecovered": true } });
        return recovered;
      });
    }
    if (result.status !== "succeeded" || !result.images[0])
      throw new DurableExecutionError(
        result.error?.message ?? "Harmonisation indisponible.",
        result.usage?.providerOutcome === "unknown"
          ? "provider_unknown"
          : "permanent",
      );
    const raw = Buffer.from(result.images[0].data);
    const rawPng = await sharp(raw).png().toBuffer();
    const baseEvidence = {
      originalAssetIds: originals.map((s) => s.assetId),
      preparedImageSha256: plan.view.image!.sha256,
      planFingerprint: plan.planFingerprint,
      resultSha256: hash(rawPng),
      providerOutputReviewed: true,
    };
    await advanceRender(db, render.id, {
      $set: { pipelineState: "quality_check" },
    });
    const inspect = (stage: "raw" | "final", candidate: Buffer) =>
      orientedProviderCall(
        db,
        render,
        {
          key: `oriented-${stage}-review-${attempt}`,
          provider: "openai",
          model,
          policy: "analysis",
          allowanceUsd: reviewCost,
          reserveAfterUsd: stage === "raw" ? reviewCost : 0,
          deadlineMs,
        },
        () =>
          reviewOrientedCandidate({
            stage,
            model,
            deadlineMs,
            room,
            prepared,
            candidate,
            originals,
            plan: reviewPlan(plan),
            evidence: { ...baseEvidence, resultSha256: hash(candidate) },
          }),
      );
    const rawReview = await inspect("raw", rawPng);
    if (
      ["identity", "angle", "geometry", "background"].some(
        (k) =>
          rawReview.criteria[k as keyof typeof rawReview.criteria].status !==
          "pass",
      )
    ) {
      const decision: QualityDecision = {
        version: "oriented-quality-v1",
        status: "rejected",
        score: null,
        feedback:
          "Le résultat fournisseur change le produit, sa pose ou le cadrage. Il a été refusé avant restauration.",
        checks: [],
      };
      await advanceRender(db, render.id, {
        $set: {
          qualityDecision: decision,
          orientedEvidence: { ...evidence, checks: rawReview },
        },
      });
      requireAcceptedQuality(decision, false);
    }
    const restored = await durableStep(
      db,
      `oriented-restoration-${attempt}`,
      "analysis",
      () =>
        harmonizeOrientedLayers({
          layers,
          generated: raw,
          shadowMethod: attempt === 0 ? "local" : "provider_luminance",
        }),
    );
    const review = await inspect("final", restored.png);
    const spent = (await renderUsageTotals(db, render.id)).estimatedCostUsd;
    const verdict = decideOrientedQuality({
      plan,
      layers: layers.evidence,
      restoration: restored.report,
      review,
      identityRevoked: false,
      repairAttempts: attempt,
      repairBudgetAvailable:
        spent + imageCost + 2 * reviewCost <= renderBudgetUsd(),
      repairDeadlineAvailable: deadlineMs - Date.now() > 180_000,
    });
    const decision: QualityDecision = {
      version: verdict.policyVersion,
      status:
        verdict.decision === "indeterminate" ? "unavailable" : verdict.decision,
      score: verdict.decision === "accepted" ? 1 : null,
      feedback:
        verdict.decision === "accepted"
          ? "Rendu contrôlé pour cet aperçu interne. Échelle et parties reconstruites estimées."
          : verdict.reasons.join(" ").slice(0, 300),
      checks: Object.entries(verdict.criteria).map(([name, c]) => ({
        name,
        score: c.status === "pass" ? 1 : 0,
        reason: c.observations.join(" "),
      })),
    };
    evidence.checks = {
      rawReview,
      review,
      verdict,
      restoration: restored.report,
    };
    await advanceRender(db, render.id, {
      $set: {
        qualityDecision: decision,
        qualityChecks: decision.checks,
        orientedEvidence: evidence,
      },
    });
    if (verdict.repair && attempt === 0) {
      repairInstructions =
        "Reduce and soften only the contact shadow. Keep product, pose and room unchanged.";
      continue;
    }
    requireAcceptedQuality(decision, false);
    await assertSnapshotDeliverable(db, snapshot);
    const output = await durableStep(
      db,
      "oriented-final",
      "analysis",
      async () => ({
        assetId: (
          await storeAsset(db, {
            organizationId: render.organizationId,
            kind: "render",
            visibility: privateVisibility(render.publicSessionId),
            buffer: restored.png,
            contentType: "image/png",
            expiresAt: scene.expiresAt,
          })
        ).id,
      }),
    );
    await completeRender(db, render, {
      resultAssetId: output.assetId,
      orientedEvidence: evidence,
      qualityDecision: decision,
      qualityScore: decision.score,
      qualityChecks: decision.checks,
      provider: result.provider,
      model: result.model,
      estimatedCostUsd: spent,
      latencyMs: Date.now() - render.createdAt.getTime(),
      updatedAt: new Date(),
    });
    return;
  }
}
