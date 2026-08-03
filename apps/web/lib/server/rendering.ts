import "server-only";

import { selectOutputSize, validatePlacementFit } from "@lili/geometry";
import type { Db } from "mongodb";
import sharp from "sharp";

import { readAsset, storeAsset } from "./assets";
import { serverConfig } from "./config";
import { captureCredit } from "./credits";
import { collections } from "./mongodb";
import { renderResponse } from "./serializers";
import type { ProductDocument, RenderDocument, SceneDocument } from "./types";

interface PlacementInput {
  [key: string]: unknown;
  sceneId: string;
  productId: string;
  calibrationId?: string;
  mode?: string;
  surfaceType?: string;
  xNormalized?: number;
  yNormalized?: number;
  scale?: number;
  rotationDegrees?: number;
  lighting?: {
    direction?: string;
    temperature?: string;
    hardness?: string;
  };
}

interface NormalizedBox {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

interface PerspectiveAnalysis {
  distance: "close" | "medium" | "far";
  framing: "close-up" | "normal" | "wide";
  surfaceBounds: NormalizedBox;
  occlusion: "none" | "front-edge" | "partial";
  evidence: string;
}

interface ResolvedPlacement extends PlacementInput {
  mode: string;
  surfaceType: string;
  xNormalized: number;
  yNormalized: number;
  scale: number;
  rotationDegrees: number;
  confidence: number;
  rationale: string;
  operation: "place" | "replace";
  occupiedObject: string | null;
  replacementBox: NormalizedBox | null;
  fitBounds?: NormalizedBox;
  obstacleRemoved?: boolean;
  pipelineStage?: string;
  perspective: PerspectiveAnalysis;
  source: "manual" | "openai-vision" | "automatic-fallback";
}

interface SceneInspection {
  imageClear: boolean;
  clarityScore: number;
  targetVisible: boolean;
  supportVisible: boolean;
  obstacleAtPoint: boolean;
  obstacleName: string | null;
  obstacleBox: NormalizedBox | null;
  evidence: string;
}

interface RenderInput {
  placement: PlacementInput;
  idempotencyKey: string;
  quality?: string;
}

interface ResolvedRenderInput extends Omit<RenderInput, "placement"> {
  placement: ResolvedPlacement;
}

interface Composition {
  buffer: Buffer;
  mask: Buffer;
  left: number;
  top: number;
  width: number;
  height: number;
  sceneWidth: number;
  sceneHeight: number;
}

interface QualityReview {
  accepted: boolean;
  score: number;
  replacementComplete: boolean;
  scaleAndPerspectivePlausible: boolean;
  scaleCorrectionFactor: number;
  photorealistic: boolean;
  duplicateProduct: boolean;
  artifactsPresent: boolean;
  feedback: string;
}

export type DeferRenderTask = (task: () => Promise<void>) => void;

export async function createRender(
  db: Db,
  organizationId: string,
  input: RenderInput,
  publicSessionId?: string,
  deferTask?: DeferRenderTask,
) {
  if (!input.idempotencyKey || input.idempotencyKey.length > 160) {
    throw new RenderError("Clé d’idempotence invalide", 422);
  }
  const c = collections(db);
  const existing = await c.renders.findOne({
    organizationId,
    idempotencyKey: input.idempotencyKey,
    ...(publicSessionId ? { publicSessionId } : {}),
  });
  if (existing) return renderResponse(existing);

  const [scene, product] = await Promise.all([
    c.scenes.findOne({
      organizationId,
      id: input.placement.sceneId,
      ...(publicSessionId ? { publicSessionId } : {}),
    }),
    c.products.findOne({ organizationId, id: input.placement.productId }),
  ]);
  if (!scene || !product?.cutoutAssetId) {
    throw new RenderError("Scène ou produit introuvable", 404);
  }

  const renderId = crypto.randomUUID();
  const now = new Date();
  const requestedSize = selectOutputSize(scene.widthPx, scene.heightPx);
  const render: RenderDocument = {
    id: renderId,
    organizationId,
    sceneId: scene.id,
    productId: product.id,
    ...(input.placement.calibrationId
      ? { calibrationId: input.placement.calibrationId }
      : {}),
    idempotencyKey: input.idempotencyKey,
    status: "processing",
    provider: null,
    model: null,
    requestedSize,
    qualityScore: null,
    creditCharged: false,
    placement: input.placement,
    ...(publicSessionId ? { publicSessionId } : {}),
    createdAt: now,
    updatedAt: now,
  };
  await c.renders.insertOne(render);

  const startedAt = Date.now();
  if (serverConfig.openaiApiKey && deferTask) {
    const placement = {
      ...input.placement,
      pipelineStage: "inspecting_scene",
    };
    const update = {
      provider: "openai",
      model: serverConfig.openaiModel,
      placement,
      updatedAt: new Date(),
    };
    await c.renders.updateOne({ id: renderId }, { $set: update });
    deferTask(async () => {
      try {
        await runLayeredRender(
          db,
          organizationId,
          render,
          scene,
          product,
          input,
          requestedSize,
          startedAt,
        );
      } catch (error) {
        await recordRenderFailure(
          db,
          organizationId,
          renderId,
          startedAt,
          error,
        );
        console.error("Deferred layered render failed", error);
      }
    });
    return renderResponse({ ...render, ...update });
  }

  try {
    const resolvedPlacement = await resolvePlacement(
      db,
      scene,
      product,
      input.placement,
    );
    const resolvedInput: ResolvedRenderInput = {
      ...input,
      placement: resolvedPlacement,
    };
    await c.renders.updateOne(
      { id: renderId },
      { $set: { placement: resolvedPlacement, updatedAt: new Date() } },
    );
    const composition = await compose(db, scene, product, resolvedInput);
    return await finalizeRender(
      db,
      organizationId,
      render,
      scene,
      product,
      composition,
      resolvedInput,
      requestedSize,
      startedAt,
    );
  } catch (error) {
    await recordRenderFailure(db, organizationId, renderId, startedAt, error);
    throw error;
  }
}

async function runLayeredRender(
  db: Db,
  organizationId: string,
  render: RenderDocument,
  scene: SceneDocument,
  product: ProductDocument,
  input: RenderInput,
  requestedSize: RenderDocument["requestedSize"],
  startedAt: number,
): Promise<void> {
  const c = collections(db);
  const sceneAsset = await readAsset(db, scene.assetId);
  if (!sceneAsset) throw new RenderError("Photo de pièce introuvable", 404);
  const surfaceType = normalizeSurfaceType(
    input.placement.surfaceType ?? product.placementType,
  );
  const anchor = requireUserAnchor(input.placement);
  const setStage = async (
    pipelineStage: string,
    extra: Record<string, unknown> = {},
  ) => {
    await c.renders.updateOne(
      { id: render.id },
      {
        $set: {
          placement: { ...input.placement, pipelineStage, ...extra },
          updatedAt: new Date(),
        },
      },
    );
  };

  await setStage("inspecting_scene");
  const inspection = await openAIInspectScene(
    sceneAsset.buffer,
    sceneAsset.asset.contentType,
    anchor,
    surfaceType,
  );
  assertClearInspection(inspection);

  let workingScene = sceneAsset.buffer;
  let workingContentType = sceneAsset.asset.contentType;
  if (inspection.obstacleAtPoint && inspection.obstacleBox) {
    await setStage("removing_obstacle", {
      operation: "replace",
      occupiedObject: inspection.obstacleName,
      replacementBox: inspection.obstacleBox,
    });
    workingScene = await openAIRemoveObstacle(
      workingScene,
      inspection,
      requestedSize,
      `${input.idempotencyKey}-obstacle`,
    );
    workingContentType = "image/webp";
    const cleanedAsset = await storeAsset(db, {
      organizationId,
      kind: "render",
      buffer: await sharp(workingScene).webp({ quality: 92 }).toBuffer(),
      contentType: "image/webp",
      expiresAt: scene.expiresAt,
    });
    await c.renders.updateOne(
      { id: render.id },
      {
        $set: {
          resultAssetId: cleanedAsset.id,
          placement: {
            ...input.placement,
            pipelineStage: "analyzing_cleaned_scene",
            operation: "replace",
            occupiedObject: inspection.obstacleName,
            replacementBox: inspection.obstacleBox,
            obstacleRemoved: true,
          },
          updatedAt: new Date(),
        },
      },
    );
  } else {
    await setStage("analyzing_cleaned_scene", {
      operation: "place",
      obstacleRemoved: false,
    });
  }

  const placement = await openAICleanedPlacement(
    workingScene,
    workingContentType,
    scene,
    product,
    input.placement,
    surfaceType,
    inspection,
  );
  await setStage("validating_fit", placement);
  const fit = validatePlacementFit({
    imageWidth: scene.widthPx,
    imageHeight: scene.heightPx,
    productWidthCm: product.widthCm,
    productHeightCm: product.heightCm,
    xNormalized: placement.xNormalized,
    yNormalized: placement.yNormalized,
    scale: placement.scale,
    fitBounds: placement.fitBounds ?? placement.perspective.surfaceBounds,
    marginRatio: 0.006,
  });
  if (!fit.fits) throw placementTooSmallError();

  const resolvedInput: ResolvedRenderInput = {
    ...input,
    placement: { ...placement, pipelineStage: "composing_preview" },
  };
  const composition = await compose(
    db,
    scene,
    product,
    resolvedInput,
    workingScene,
  );
  const previewAsset = await storeAsset(db, {
    organizationId,
    kind: "render",
    buffer: composition.buffer,
    contentType: "image/webp",
    expiresAt: scene.expiresAt,
  });
  resolvedInput.placement.pipelineStage = "refining_final";
  await c.renders.updateOne(
    { id: render.id },
    {
      $set: {
        resultAssetId: previewAsset.id,
        placement: resolvedInput.placement,
        updatedAt: new Date(),
      },
    },
  );
  await finalizeRender(
    db,
    organizationId,
    render,
    scene,
    product,
    composition,
    resolvedInput,
    requestedSize,
    startedAt,
    workingScene,
  );
}

async function finalizeRender(
  db: Db,
  organizationId: string,
  render: RenderDocument,
  scene: SceneDocument,
  product: ProductDocument,
  composition: Composition,
  input: ResolvedRenderInput,
  requestedSize: RenderDocument["requestedSize"],
  startedAt: number,
  sourceSceneBuffer?: Buffer,
) {
  const c = collections(db);
  const generated = serverConfig.openaiApiKey
    ? await generateAndReview(
        db,
        scene,
        product,
        composition,
        input,
        requestedSize,
        startedAt + 285_000,
        sourceSceneBuffer,
      )
    : {
        buffer: composition.buffer,
        provider: "mock",
        model: "deterministic-compositor",
        estimatedCostUsd: 0,
        qualityReview: {
          accepted: true,
          score: 0.99,
          replacementComplete: true,
          scaleAndPerspectivePlausible: true,
          scaleCorrectionFactor: 1,
          photorealistic: true,
          duplicateProduct: false,
          artifactsPresent: false,
          feedback: "Composition déterministe de test.",
        } satisfies QualityReview,
        repaired: false,
        finalPlacement: input.placement,
      };
  const finalBuffer =
    generated.provider === "mock"
      ? composition.buffer
      : await sharp(generated.buffer).webp({ quality: 92 }).toBuffer();
  const resultAsset = await storeAsset(db, {
    organizationId,
    kind: "render",
    buffer: finalBuffer,
    contentType: "image/webp",
    expiresAt: scene.expiresAt,
  });
  const creditCharged = await captureCredit(
    db,
    organizationId,
    `render:${render.id}`,
  );
  const finalPlacement = {
    ...generated.finalPlacement,
    pipelineStage: "complete",
    qualityReview: generated.qualityReview,
    repaired: generated.repaired,
  };
  const update = {
    status: "succeeded" as const,
    provider: generated.provider,
    model: generated.model,
    resultAssetId: resultAsset.id,
    qualityScore: generated.qualityReview.score,
    placement: finalPlacement,
    creditCharged,
    updatedAt: new Date(),
  };
  await c.renders.updateOne(
    { id: render.id },
    { $set: update, $unset: { error: "" } },
  );
  await c.renderAttempts.insertOne({
    id: crypto.randomUUID(),
    organizationId,
    renderId: render.id,
    provider: generated.provider,
    model: generated.model,
    status: "succeeded",
    latencyMs: Date.now() - startedAt,
    estimatedCostUsd: generated.estimatedCostUsd,
    createdAt: new Date(),
  });
  return renderResponse({ ...render, ...update });
}

async function recordRenderFailure(
  db: Db,
  organizationId: string,
  renderId: string,
  startedAt: number,
  error: unknown,
): Promise<void> {
  const c = collections(db);
  const message = error instanceof Error ? error.message : "Rendu impossible";
  await c.renders.updateOne(
    { id: renderId },
    {
      $set: {
        status: "failed",
        error: message.slice(0, 500),
        updatedAt: new Date(),
      },
    },
  );
  await c.renderAttempts.insertOne({
    id: crypto.randomUUID(),
    organizationId,
    renderId,
    provider: serverConfig.openaiApiKey ? "openai" : "mock",
    model: serverConfig.openaiApiKey
      ? serverConfig.openaiModel
      : "deterministic-compositor",
    status: "failed",
    latencyMs: Date.now() - startedAt,
    estimatedCostUsd: 0,
    error: message.slice(0, 500),
    createdAt: new Date(),
  });
}

async function resolvePlacement(
  db: Db,
  scene: SceneDocument,
  product: ProductDocument,
  input: PlacementInput,
): Promise<ResolvedPlacement> {
  if (
    input.mode !== "auto" &&
    typeof input.xNormalized === "number" &&
    typeof input.yNormalized === "number" &&
    typeof input.scale === "number"
  ) {
    return {
      ...input,
      mode: input.mode ?? "manual",
      surfaceType: normalizeSurfaceType(
        input.surfaceType ?? product.placementType,
      ),
      xNormalized: clamp(input.xNormalized, 0.04, 0.96),
      yNormalized: clamp(input.yNormalized, 0.08, 0.98),
      scale: clamp(input.scale, 0.04, 0.75),
      rotationDegrees: clamp(input.rotationDegrees ?? 0, -20, 20),
      confidence: 1,
      rationale: "Placement ajusté manuellement",
      operation: "place",
      occupiedObject: null,
      replacementBox: null,
      perspective: defaultPerspective(),
      source: "manual",
    };
  }

  const surfaceType = normalizeSurfaceType(
    input.surfaceType ?? product.placementType,
  );
  if (serverConfig.openaiApiKey) {
    try {
      return await openAIPlacement(db, scene, product, input, surfaceType);
    } catch (reason) {
      console.warn("OpenAI placement analysis failed; using fallback", reason);
    }
  }
  return fallbackPlacement(scene, product, input, surfaceType);
}

function requireUserAnchor(input: PlacementInput): { x: number; y: number } {
  if (
    typeof input.xNormalized !== "number" ||
    typeof input.yNormalized !== "number"
  ) {
    throw new RenderError(
      "Touchez la photo pour indiquer précisément l’emplacement.",
      422,
    );
  }
  return {
    x: clamp(input.xNormalized, 0, 1),
    y: clamp(input.yNormalized, 0, 1),
  };
}

function assertClearInspection(inspection: SceneInspection): void {
  if (
    !inspection.imageClear ||
    inspection.clarityScore < 0.55 ||
    !inspection.targetVisible ||
    !inspection.supportVisible ||
    (inspection.obstacleAtPoint && !inspection.obstacleBox)
  ) {
    throw imageUnclearError();
  }
}

function imageUnclearError(): RenderError {
  return new RenderError(
    "Veuillez fournir une image plus claire : le support ou le point choisi n’est pas suffisamment visible.",
    422,
  );
}

function placementTooSmallError(): RenderError {
  return new RenderError(
    "L’emplacement est trop petit pour contenir cet élément. Choisissez une zone plus grande.",
    422,
  );
}

async function openAIInspectScene(
  sceneBuffer: Buffer,
  contentType: string,
  anchor: { x: number; y: number },
  surfaceType: string,
): Promise<SceneInspection> {
  const response = await fetchOpenAIResponse(
    {
      model: serverConfig.openaiVisionModel,
      store: false,
      service_tier: serverConfig.openaiServiceTier,
      reasoning: { effort: "high" },
      max_output_tokens: 2_500,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "Layer 1 of a strict interior-product placement pipeline. Inspect only; do not choose product size or placement yet.",
                `The user target is the pixel-equivalent of normalized point x=${anchor.x.toFixed(4)}, y=${anchor.y.toFixed(4)} on a requested ${surfaceType} support. The point is supplied as coordinates and is not visibly drawn into the image.`,
                "Decide whether the photograph, target and support geometry are clear enough for a photorealistic edit.",
                "Obstacle means a removable item occupying the target point, such as decor, an appliance, a container or its cable. The shelf, table, wall, floor and structural furniture are never obstacles.",
                "If an obstacle exists, identify its entire silhouette including handles, feet, appendages, cable, reflection and contact shadow. Return one padded normalized box enclosing all of it without swallowing the support structure.",
                "Be conservative: ambiguous or severely occluded targets must be marked unclear.",
              ].join(" "),
            },
            {
              type: "input_image",
              image_url: `data:${contentType};base64,${sceneBuffer.toString("base64")}`,
              detail: "original",
            },
          ],
        },
      ],
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "scene_obstacle_inspection",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              imageClear: { type: "boolean" },
              clarityScore: { type: "number", minimum: 0, maximum: 1 },
              targetVisible: { type: "boolean" },
              supportVisible: { type: "boolean" },
              obstacleAtPoint: { type: "boolean" },
              obstacleName: { type: "string", maxLength: 100 },
              obstacleXMin: { type: "number", minimum: 0, maximum: 1 },
              obstacleYMin: { type: "number", minimum: 0, maximum: 1 },
              obstacleXMax: { type: "number", minimum: 0, maximum: 1 },
              obstacleYMax: { type: "number", minimum: 0, maximum: 1 },
              evidence: { type: "string", maxLength: 240 },
            },
            required: [
              "imageClear",
              "clarityScore",
              "targetVisible",
              "supportVisible",
              "obstacleAtPoint",
              "obstacleName",
              "obstacleXMin",
              "obstacleYMin",
              "obstacleXMax",
              "obstacleYMax",
              "evidence",
            ],
          },
        },
      },
    },
    75_000,
  );
  if (!response.ok) {
    throw new RenderError(
      `Analyse de la zone impossible (${response.status}). Réessayez.`,
      502,
    );
  }
  const result = JSON.parse(await responseOutputText(response)) as {
    imageClear: boolean;
    clarityScore: number;
    targetVisible: boolean;
    supportVisible: boolean;
    obstacleAtPoint: boolean;
    obstacleName: string;
    obstacleXMin: number;
    obstacleYMin: number;
    obstacleXMax: number;
    obstacleYMax: number;
    evidence: string;
  };
  const obstacleBox = result.obstacleAtPoint
    ? normalizeBox({
        xMin: result.obstacleXMin,
        yMin: result.obstacleYMin,
        xMax: result.obstacleXMax,
        yMax: result.obstacleYMax,
      })
    : null;
  const boxIsUsable =
    obstacleBox &&
    obstacleBox.xMax - obstacleBox.xMin >= 0.015 &&
    obstacleBox.yMax - obstacleBox.yMin >= 0.015;
  return {
    imageClear: Boolean(result.imageClear),
    clarityScore: clamp(Number(result.clarityScore), 0, 1),
    targetVisible: Boolean(result.targetVisible),
    supportVisible: Boolean(result.supportVisible),
    obstacleAtPoint: Boolean(result.obstacleAtPoint),
    obstacleName: result.obstacleAtPoint
      ? String(result.obstacleName || "objet existant").slice(0, 100)
      : null,
    obstacleBox: boxIsUsable ? obstacleBox : null,
    evidence: String(result.evidence).slice(0, 240),
  };
}

async function openAIRemoveObstacle(
  sceneBuffer: Buffer,
  inspection: SceneInspection,
  requestedSize: RenderDocument["requestedSize"],
  idempotencyKey: string,
): Promise<Buffer> {
  if (!inspection.obstacleBox) throw imageUnclearError();
  const metadata = await sharp(sceneBuffer).metadata();
  const width = metadata.width;
  const height = metadata.height;
  if (!width || !height) throw imageUnclearError();
  const mask = await createNormalizedMask(
    width,
    height,
    inspection.obstacleBox,
  );
  const basePng = await sharp(sceneBuffer).rotate().png().toBuffer();
  const body = new FormData();
  body.append("model", serverConfig.openaiModel);
  body.append(
    "image[]",
    new Blob([toArrayBuffer(basePng)], { type: "image/png" }),
    "room-with-obstacle.png",
  );
  body.append(
    "mask",
    new Blob([toArrayBuffer(mask)], { type: "image/png" }),
    "obstacle-mask.png",
  );
  body.append("quality", "medium");
  body.append("size", requestedSize);
  body.append("background", "opaque");
  body.append("output_format", "png");
  body.append(
    "prompt",
    [
      `Layer 1 cleanup only. Completely remove the ${inspection.obstacleName ?? "removable object"} inside the transparent mask, including its appendages, cable, reflections and old contact shadow.`,
      "Reconstruct the now-hidden support surface, rear wall, shelf back and local texture from the surrounding visual evidence.",
      "Do not add the catalog product or any replacement object. The target must be genuinely empty after this layer.",
      "Preserve the exact camera, crop, furniture geometry, lighting, grain and every unmasked pixel. Avoid smears, duplicated edges, hallucinated decor and broken shelf lines.",
    ].join(" "),
  );
  const response = await fetch(`${serverConfig.openaiBaseUrl}/images/edits`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serverConfig.openaiApiKey}`,
      "Idempotency-Key": idempotencyKey,
    },
    body,
    signal: AbortSignal.timeout(145_000),
  });
  if (!response.ok) {
    throw new RenderError(
      `Suppression de l’obstacle impossible (${response.status}). Réessayez.`,
      502,
    );
  }
  const payload = (await response.json()) as {
    data?: Array<{ b64_json?: string }>;
  };
  const encoded = payload.data?.[0]?.b64_json;
  if (!encoded) throw new RenderError("Le nettoyage de l’image a échoué.", 502);
  return compositeGeneratedInsideMask(
    basePng,
    Buffer.from(encoded, "base64"),
    mask,
    width,
    height,
  );
}

async function compositeGeneratedInsideMask(
  original: Buffer,
  generated: Buffer,
  openAIMask: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  const editableAlpha = await sharp(openAIMask)
    .extractChannel(3)
    .negate()
    .blur(1.2)
    .png()
    .toBuffer();
  const localRepair = await sharp(generated)
    .resize({ width, height, fit: "fill" })
    .removeAlpha()
    .joinChannel(editableAlpha)
    .png()
    .toBuffer();
  return sharp(original)
    .composite([{ input: localRepair, blend: "over" }])
    .png()
    .toBuffer();
}

async function createNormalizedMask(
  width: number,
  height: number,
  box: NormalizedBox,
): Promise<Buffer> {
  const data = Buffer.alloc(width * height * 4, 255);
  const boxWidth = (box.xMax - box.xMin) * width;
  const boxHeight = (box.yMax - box.yMin) * height;
  const padding = Math.max(
    12,
    Math.round(Math.min(boxWidth, boxHeight) * 0.12),
  );
  const minX = Math.max(0, Math.floor(box.xMin * width) - padding);
  const maxX = Math.min(width, Math.ceil(box.xMax * width) + padding);
  const minY = Math.max(0, Math.floor(box.yMin * height) - padding);
  const maxY = Math.min(height, Math.ceil(box.yMax * height) + padding);
  for (let y = minY; y < maxY; y += 1) {
    for (let x = minX; x < maxX; x += 1) {
      data[(y * width + x) * 4 + 3] = 0;
    }
  }
  return sharp(data, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

async function openAICleanedPlacement(
  sceneBuffer: Buffer,
  contentType: string,
  scene: SceneDocument,
  product: ProductDocument,
  input: PlacementInput,
  surfaceType: string,
  inspection: SceneInspection,
): Promise<ResolvedPlacement> {
  const anchor = requireUserAnchor(input);
  const response = await fetchOpenAIResponse(
    {
      model: serverConfig.openaiVisionModel,
      store: false,
      service_tier: serverConfig.openaiServiceTier,
      reasoning: { effort: "high" },
      max_output_tokens: 3_000,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "Layer 2. Re-analyze this room image from scratch after any obstacle cleanup. Return a physically feasible product placement, not a visual guess.",
                `The user's normalized point is x=${anchor.x.toFixed(4)}, y=${anchor.y.toFixed(4)} and indicates lateral intent only. Required support: ${surfaceType}.`,
                `Exact product dimensions: width ${product.widthCm} cm, height ${product.heightCm} cm, depth ${product.depthCm} cm. Product: ${product.name}; ${product.description}; material ${product.material}.`,
                "Move y vertically when needed: yNormalized must be the real bottom contact plane on the support, never the raw point if the point is too high.",
                "Infer apparent scale from shelf/table perspective, converging lines, camera zoom, nearby known-size objects, support depth and the product's real dimensions. A close-up support requires a larger apparent product than a distant support.",
                "fit bounds must describe the entire clear volume that the product silhouette may occupy: side boundaries, upper shelf/niche boundary and bottom support plane. Never include space through a shelf top or beyond a side wall.",
                "The product must rest on the support, fit laterally, stay below the upper boundary and remain plausibly sized relative to objects around it. Mark placement_too_small if those conditions cannot all be met without making the product implausibly small.",
                "Mark image_unclear if perspective or support boundaries cannot be read reliably. Do not force an answer.",
              ].join(" "),
            },
            {
              type: "input_image",
              image_url: `data:${contentType};base64,${sceneBuffer.toString("base64")}`,
              detail: "original",
            },
          ],
        },
      ],
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "cleaned_scene_placement",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              feasible: { type: "boolean" },
              imageClear: { type: "boolean" },
              clarityScore: { type: "number", minimum: 0, maximum: 1 },
              errorCode: {
                type: "string",
                enum: ["none", "placement_too_small", "image_unclear"],
              },
              xNormalized: { type: "number", minimum: 0, maximum: 1 },
              yNormalized: { type: "number", minimum: 0, maximum: 1 },
              scale: { type: "number", minimum: 0.02, maximum: 0.8 },
              rotationDegrees: { type: "number", minimum: -20, maximum: 20 },
              lightingDirection: {
                type: "string",
                enum: ["left", "right", "front", "back", "diffuse"],
              },
              lightingTemperature: {
                type: "string",
                enum: ["warm", "neutral", "cool"],
              },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              rationale: { type: "string", maxLength: 260 },
              fitXMin: { type: "number", minimum: 0, maximum: 1 },
              fitYMin: { type: "number", minimum: 0, maximum: 1 },
              fitXMax: { type: "number", minimum: 0, maximum: 1 },
              fitYMax: { type: "number", minimum: 0, maximum: 1 },
              surfaceXMin: { type: "number", minimum: 0, maximum: 1 },
              surfaceYMin: { type: "number", minimum: 0, maximum: 1 },
              surfaceXMax: { type: "number", minimum: 0, maximum: 1 },
              surfaceYMax: { type: "number", minimum: 0, maximum: 1 },
              apparentDistance: {
                type: "string",
                enum: ["close", "medium", "far"],
              },
              framing: {
                type: "string",
                enum: ["close-up", "normal", "wide"],
              },
              occlusion: {
                type: "string",
                enum: ["none", "front-edge", "partial"],
              },
              perspectiveEvidence: { type: "string", maxLength: 200 },
            },
            required: [
              "feasible",
              "imageClear",
              "clarityScore",
              "errorCode",
              "xNormalized",
              "yNormalized",
              "scale",
              "rotationDegrees",
              "lightingDirection",
              "lightingTemperature",
              "confidence",
              "rationale",
              "fitXMin",
              "fitYMin",
              "fitXMax",
              "fitYMax",
              "surfaceXMin",
              "surfaceYMin",
              "surfaceXMax",
              "surfaceYMax",
              "apparentDistance",
              "framing",
              "occlusion",
              "perspectiveEvidence",
            ],
          },
        },
      },
    },
    80_000,
  );
  if (!response.ok) {
    throw new RenderError(
      `Analyse du placement impossible (${response.status}). Réessayez.`,
      502,
    );
  }
  const result = JSON.parse(await responseOutputText(response)) as {
    feasible: boolean;
    imageClear: boolean;
    clarityScore: number;
    errorCode: "none" | "placement_too_small" | "image_unclear";
    xNormalized: number;
    yNormalized: number;
    scale: number;
    rotationDegrees: number;
    lightingDirection: string;
    lightingTemperature: string;
    confidence: number;
    rationale: string;
    fitXMin: number;
    fitYMin: number;
    fitXMax: number;
    fitYMax: number;
    surfaceXMin: number;
    surfaceYMin: number;
    surfaceXMax: number;
    surfaceYMax: number;
    apparentDistance: "close" | "medium" | "far";
    framing: "close-up" | "normal" | "wide";
    occlusion: "none" | "front-edge" | "partial";
    perspectiveEvidence: string;
  };
  if (
    !result.imageClear ||
    result.clarityScore < 0.55 ||
    result.errorCode === "image_unclear"
  ) {
    throw imageUnclearError();
  }
  if (!result.feasible || result.errorCode === "placement_too_small") {
    throw placementTooSmallError();
  }
  const fitBounds = normalizeBox({
    xMin: result.fitXMin,
    yMin: result.fitYMin,
    xMax: result.fitXMax,
    yMax: result.fitYMax,
  });
  if (
    fitBounds.xMax - fitBounds.xMin < 0.02 ||
    fitBounds.yMax - fitBounds.yMin < 0.02
  ) {
    throw placementTooSmallError();
  }
  return {
    ...input,
    mode: "guided",
    surfaceType,
    xNormalized: clamp(Number(result.xNormalized), 0.02, 0.98),
    yNormalized: clamp(Number(result.yNormalized), 0.02, 0.98),
    scale: clamp(Number(result.scale), 0.02, 0.75),
    rotationDegrees: clamp(Number(result.rotationDegrees), -20, 20),
    lighting: {
      direction: result.lightingDirection,
      temperature: result.lightingTemperature,
      hardness: "soft",
    },
    confidence: clamp(Number(result.confidence), 0, 1),
    rationale: String(result.rationale).slice(0, 260),
    operation: inspection.obstacleAtPoint ? "replace" : "place",
    occupiedObject: inspection.obstacleName,
    replacementBox: inspection.obstacleBox,
    obstacleRemoved: inspection.obstacleAtPoint,
    fitBounds,
    perspective: {
      distance: result.apparentDistance,
      framing: result.framing,
      surfaceBounds: normalizeBox({
        xMin: result.surfaceXMin,
        yMin: result.surfaceYMin,
        xMax: result.surfaceXMax,
        yMax: result.surfaceYMax,
      }),
      occlusion: result.occlusion,
      evidence: String(result.perspectiveEvidence).slice(0, 200),
    },
    source: "openai-vision",
  };
}

async function openAIPlacement(
  db: Db,
  scene: SceneDocument,
  product: ProductDocument,
  input: PlacementInput,
  surfaceType: string,
): Promise<ResolvedPlacement> {
  const sceneAsset = await readAsset(db, scene.assetId);
  if (!sceneAsset) throw new RenderError("Photo de pièce introuvable", 404);
  const userAnchor =
    typeof input.xNormalized === "number" &&
    typeof input.yNormalized === "number"
      ? { x: input.xNormalized, y: input.yNormalized }
      : null;
  const anchorInstruction = userAnchor
    ? [
        `The red dot is at x=${userAnchor.x.toFixed(4)}, y=${userAnchor.y.toFixed(4)} and identifies the intended target zone.`,
        "If that zone is empty, keep the red dot as the exact horizontal center and bottom contact point.",
        "If the dot is on an existing movable object, treat this as a replacement request: identify the whole old object, return its tight bounding box, and infer the true support contact point below it. Keep the replacement centered close to the red dot.",
      ].join(" ")
    : "Choose the most realistic free contact point on the requested support.";
  const response = await fetchOpenAIResponse(
    {
      model: serverConfig.openaiVisionModel,
      store: false,
      service_tier: serverConfig.openaiServiceTier,
      reasoning: { effort: "medium" },
      max_output_tokens: 3_000,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "Act as a meticulous interior-photography and single-view geometry analyst. Analyze the supplied room photo before deciding any coordinates.",
                `Required support type: ${surfaceType}.`,
                anchorInstruction,
                `Product: ${product.name}; ${product.description}; material ${product.material}; real dimensions ${product.widthCm} x ${product.heightCm} x ${product.depthCm} cm.`,
                "Return normalized coordinates relative to the full image: xNormalized is the horizontal center of the product, yNormalized is its bottom contact point, and scale is the product width divided by room image width.",
                "Estimate apparent depth and camera framing from converging shelf lines, the visible support opening, nearby objects and depth-of-field. A close-up or zoomed shelf must produce a materially larger image-width scale than the same shelf seen far away. Cross-check the real product dimensions against the apparent support width and height so it physically fits.",
                "Inspect the complete local region around the red dot. Set operation=replace when a decor object, appliance or other removable item occupies that target. Include its entire silhouette, base, appendages, cable and local shadow in replacement bounds. Set operation=place only for genuinely empty support space.",
                "Detect whether a shelf lip or other foreground edge must occlude the lower part of the new product. Do not invent a new support surface.",
                "Choose a subtle rotation and lighting values matching the room. Do not invent a new support surface.",
              ].join(" "),
            },
            {
              type: "input_image",
              image_url: `data:${sceneAsset.asset.contentType};base64,${sceneAsset.buffer.toString("base64")}`,
              detail: "original",
            },
          ],
        },
      ],
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "placement_recommendation",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              xNormalized: { type: "number", minimum: 0, maximum: 1 },
              yNormalized: { type: "number", minimum: 0, maximum: 1 },
              scale: { type: "number", minimum: 0.04, maximum: 0.75 },
              rotationDegrees: { type: "number", minimum: -20, maximum: 20 },
              lightingDirection: {
                type: "string",
                enum: ["left", "right", "front", "back", "diffuse"],
              },
              lightingTemperature: {
                type: "string",
                enum: ["warm", "neutral", "cool"],
              },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              rationale: { type: "string", maxLength: 240 },
              operation: { type: "string", enum: ["place", "replace"] },
              occupiedObject: { type: "string", maxLength: 100 },
              replacementXMin: { type: "number", minimum: 0, maximum: 1 },
              replacementYMin: { type: "number", minimum: 0, maximum: 1 },
              replacementXMax: { type: "number", minimum: 0, maximum: 1 },
              replacementYMax: { type: "number", minimum: 0, maximum: 1 },
              surfaceXMin: { type: "number", minimum: 0, maximum: 1 },
              surfaceYMin: { type: "number", minimum: 0, maximum: 1 },
              surfaceXMax: { type: "number", minimum: 0, maximum: 1 },
              surfaceYMax: { type: "number", minimum: 0, maximum: 1 },
              apparentDistance: {
                type: "string",
                enum: ["close", "medium", "far"],
              },
              framing: {
                type: "string",
                enum: ["close-up", "normal", "wide"],
              },
              occlusion: {
                type: "string",
                enum: ["none", "front-edge", "partial"],
              },
              perspectiveEvidence: { type: "string", maxLength: 180 },
            },
            required: [
              "xNormalized",
              "yNormalized",
              "scale",
              "rotationDegrees",
              "lightingDirection",
              "lightingTemperature",
              "confidence",
              "rationale",
              "operation",
              "occupiedObject",
              "replacementXMin",
              "replacementYMin",
              "replacementXMax",
              "replacementYMax",
              "surfaceXMin",
              "surfaceYMin",
              "surfaceXMax",
              "surfaceYMax",
              "apparentDistance",
              "framing",
              "occlusion",
              "perspectiveEvidence",
            ],
          },
        },
      },
    },
    70_000,
  );
  if (!response.ok) {
    throw new RenderError(
      `Analyse OpenAI ${response.status}: ${(await response.text()).slice(0, 300)}`,
      502,
    );
  }
  const payload = (await response.json()) as {
    output?: Array<{
      type?: string;
      content?: Array<{ type?: string; text?: string }>;
    }>;
  };
  const outputText = payload.output
    ?.flatMap((item) => item.content ?? [])
    .find((item) => item.type === "output_text")?.text;
  if (!outputText) {
    throw new RenderError("L’analyse de placement est vide", 502);
  }
  const result = JSON.parse(outputText) as {
    xNormalized: number;
    yNormalized: number;
    scale: number;
    rotationDegrees: number;
    lightingDirection: string;
    lightingTemperature: string;
    confidence: number;
    rationale: string;
    operation: "place" | "replace";
    occupiedObject: string;
    replacementXMin: number;
    replacementYMin: number;
    replacementXMax: number;
    replacementYMax: number;
    surfaceXMin: number;
    surfaceYMin: number;
    surfaceXMax: number;
    surfaceYMax: number;
    apparentDistance: "close" | "medium" | "far";
    framing: "close-up" | "normal" | "wide";
    occlusion: "none" | "front-edge" | "partial";
    perspectiveEvidence: string;
  };
  const operation = result.operation === "replace" ? "replace" : "place";
  const replacementBox =
    operation === "replace"
      ? normalizeBox({
          xMin: result.replacementXMin,
          yMin: result.replacementYMin,
          xMax: result.replacementXMax,
          yMax: result.replacementYMax,
        })
      : null;
  const analyzedX = clamp(Number(result.xNormalized), 0.04, 0.96);
  const analyzedY = clamp(Number(result.yNormalized), 0.08, 0.98);
  return {
    ...input,
    mode: userAnchor ? "guided" : "auto",
    surfaceType,
    xNormalized: userAnchor
      ? operation === "replace"
        ? clamp(analyzedX, userAnchor.x - 0.12, userAnchor.x + 0.12)
        : clamp(userAnchor.x, 0.02, 0.98)
      : analyzedX,
    yNormalized: userAnchor
      ? operation === "replace"
        ? clamp(analyzedY, userAnchor.y - 0.18, userAnchor.y + 0.18)
        : clamp(userAnchor.y, 0.02, 0.98)
      : analyzedY,
    scale: clamp(Number(result.scale), 0.035, 0.68),
    rotationDegrees: clamp(Number(result.rotationDegrees), -20, 20),
    lighting: {
      direction: result.lightingDirection,
      temperature: result.lightingTemperature,
      hardness: "soft",
    },
    confidence: clamp(Number(result.confidence), 0, 1),
    rationale: String(result.rationale).slice(0, 240),
    operation,
    occupiedObject:
      operation === "replace"
        ? String(result.occupiedObject || "objet existant").slice(0, 100)
        : null,
    replacementBox,
    perspective: {
      distance: result.apparentDistance,
      framing: result.framing,
      surfaceBounds: normalizeBox({
        xMin: result.surfaceXMin,
        yMin: result.surfaceYMin,
        xMax: result.surfaceXMax,
        yMax: result.surfaceYMax,
      }),
      occlusion: result.occlusion,
      evidence: String(result.perspectiveEvidence).slice(0, 180),
    },
    source: "openai-vision",
  };
}

function fallbackPlacement(
  scene: SceneDocument,
  product: ProductDocument,
  input: PlacementInput,
  surfaceType: string,
): ResolvedPlacement {
  const defaults: Record<
    string,
    { x: number; y: number; scale: number; rotation: number }
  > = {
    table: { x: 0.62, y: 0.73, scale: 0.18, rotation: 0 },
    nightstand: { x: 0.7, y: 0.7, scale: 0.15, rotation: 0 },
    shelf: { x: 0.58, y: 0.58, scale: 0.14, rotation: 0 },
    niche: { x: 0.5, y: 0.58, scale: 0.16, rotation: 0 },
    wall: { x: 0.53, y: 0.56, scale: 0.25, rotation: 0 },
    floor: { x: 0.66, y: 0.9, scale: 0.28, rotation: 0 },
  };
  const selected = defaults[surfaceType] ?? defaults.table!;
  const widthToHeight = product.widthCm / Math.max(product.heightCm, 1);
  const scaleAdjustment = clamp((widthToHeight - 0.5) * 0.025, -0.02, 0.04);
  const light = scene.analysis.light as
    { direction?: string; temperature?: string } | undefined;
  const userAnchor =
    typeof input.xNormalized === "number" &&
    typeof input.yNormalized === "number"
      ? { x: input.xNormalized, y: input.yNormalized }
      : null;
  return {
    ...input,
    mode: userAnchor ? "guided" : "auto",
    surfaceType,
    xNormalized: userAnchor ? clamp(userAnchor.x, 0.02, 0.98) : selected.x,
    yNormalized: userAnchor ? clamp(userAnchor.y, 0.02, 0.98) : selected.y,
    scale: clamp(selected.scale + scaleAdjustment, 0.06, 0.55),
    rotationDegrees: selected.rotation,
    lighting: {
      direction: light?.direction ?? "left",
      temperature: light?.temperature ?? "neutral",
      hardness: "soft",
    },
    confidence: serverConfig.openaiApiKey ? 0.58 : 0.46,
    rationale: userAnchor
      ? "Point choisi manuellement, avec échelle et lumière adaptées automatiquement au support."
      : "Placement automatique basé sur le type de support, les dimensions du produit et la perspective de la pièce.",
    operation: "place",
    occupiedObject: null,
    replacementBox: null,
    perspective: defaultPerspective(),
    source: "automatic-fallback",
  };
}

function defaultPerspective(): PerspectiveAnalysis {
  return {
    distance: "medium",
    framing: "normal",
    surfaceBounds: { xMin: 0, yMin: 0, xMax: 1, yMax: 1 },
    occlusion: "none",
    evidence: "Estimation locale de secours.",
  };
}

function normalizeBox(box: NormalizedBox): NormalizedBox {
  const xMin = clamp(Math.min(Number(box.xMin), Number(box.xMax)), 0, 1);
  const xMax = clamp(Math.max(Number(box.xMin), Number(box.xMax)), 0, 1);
  const yMin = clamp(Math.min(Number(box.yMin), Number(box.yMax)), 0, 1);
  const yMax = clamp(Math.max(Number(box.yMin), Number(box.yMax)), 0, 1);
  return { xMin, yMin, xMax, yMax };
}

function normalizeSurfaceType(value: string): string {
  const allowed = new Set([
    "table",
    "nightstand",
    "shelf",
    "niche",
    "wall",
    "floor",
  ]);
  return allowed.has(value) ? value : "table";
}

async function compose(
  db: Db,
  scene: SceneDocument,
  product: ProductDocument,
  input: ResolvedRenderInput,
  sourceSceneBuffer?: Buffer,
): Promise<Composition> {
  const [sceneAsset, cutoutAsset] = await Promise.all([
    readAsset(db, scene.assetId),
    readAsset(db, product.cutoutAssetId as string),
  ]);
  if (!sceneAsset || !cutoutAsset) {
    throw new RenderError("Fichier source introuvable", 404);
  }
  const sceneBuffer = sourceSceneBuffer ?? sceneAsset.buffer;
  const sceneMetadata = await sharp(sceneBuffer).metadata();
  const sceneWidth = sceneMetadata.width ?? scene.widthPx;
  const sceneHeight = sceneMetadata.height ?? scene.heightPx;
  const targetWidth = Math.max(
    40,
    Math.min(
      Math.round(sceneWidth * clamp(input.placement.scale, 0.04, 0.75)),
      Math.round(sceneWidth * 0.8),
    ),
  );
  const overlay = await sharp(cutoutAsset.buffer)
    .resize({ width: targetWidth, withoutEnlargement: false })
    .rotate(input.placement.rotationDegrees || 0, {
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .webp({ quality: 95, alphaQuality: 100 })
    .toBuffer();
  const overlayMetadata = await sharp(overlay).metadata();
  const width = overlayMetadata.width ?? targetWidth;
  const height = overlayMetadata.height ?? targetWidth;
  const left = Math.round(
    clamp(
      input.placement.xNormalized * sceneWidth - width / 2,
      0,
      sceneWidth - width,
    ),
  );
  const top = Math.round(
    clamp(
      input.placement.yNormalized * sceneHeight - height,
      0,
      sceneHeight - height,
    ),
  );
  const shadowSvg = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${sceneWidth}" height="${sceneHeight}">
      <ellipse cx="${left + width / 2}" cy="${top + height * 0.97}" rx="${width * 0.38}" ry="${Math.max(7, height * 0.035)}" fill="#120d08" fill-opacity=".28"/>
    </svg>`);
  const shadow = await sharp(shadowSvg).blur(10).png().toBuffer();
  const buffer = await sharp(sceneBuffer)
    .rotate()
    .composite([
      { input: shadow, blend: "over" },
      { input: overlay, left, top, blend: "over" },
    ])
    .webp({ quality: 92 })
    .toBuffer();
  const mask = await createEditMask(
    sceneWidth,
    sceneHeight,
    { left, top, width, height },
    input.placement,
  );
  return {
    buffer,
    mask,
    left,
    top,
    width,
    height,
    sceneWidth,
    sceneHeight,
  };
}

async function createEditMask(
  width: number,
  height: number,
  box: { left: number; top: number; width: number; height: number },
  placement: ResolvedPlacement,
): Promise<Buffer> {
  const data = Buffer.alloc(width * height * 4, 255);
  const paddingRatio = placement.operation === "replace" ? 0.14 : 0.08;
  const padding = Math.max(
    8,
    Math.round(Math.min(box.width, box.height) * paddingRatio),
  );
  let minX = Math.max(0, box.left - padding);
  let maxX = Math.min(width, box.left + box.width + padding);
  let minY = Math.max(0, box.top - padding);
  let maxY = Math.min(height, box.top + box.height + padding);

  if (placement.operation === "replace" && placement.replacementBox) {
    const replacementPadding = Math.max(10, Math.round(padding * 1.25));
    minX = Math.max(
      0,
      Math.min(
        minX,
        Math.round(placement.replacementBox.xMin * width) - replacementPadding,
      ),
    );
    maxX = Math.min(
      width,
      Math.max(
        maxX,
        Math.round(placement.replacementBox.xMax * width) + replacementPadding,
      ),
    );
    minY = Math.max(
      0,
      Math.min(
        minY,
        Math.round(placement.replacementBox.yMin * height) - replacementPadding,
      ),
    );
    maxY = Math.min(
      height,
      Math.max(
        maxY,
        Math.round(placement.replacementBox.yMax * height) + replacementPadding,
      ),
    );
  }
  for (let y = minY; y < maxY; y += 1) {
    for (let x = minX; x < maxX; x += 1) {
      data[(y * width + x) * 4 + 3] = 0;
    }
  }

  return data;
}

async function generateAndReview(
  db: Db,
  scene: SceneDocument,
  product: ProductDocument,
  composition: Composition,
  input: ResolvedRenderInput,
  requestedSize: RenderDocument["requestedSize"],
  deadlineMs: number,
  sourceSceneBuffer?: Buffer,
) {
  const perEditCostUsd = estimatedImageEditCost(requestedSize);
  if (perEditCostUsd > serverConfig.openaiMaxCostUsd) {
    throw new RenderError("Plafond de coût OpenAI dépassé", 422);
  }

  const first = await openAIEdit(
    db,
    product,
    composition,
    input,
    requestedSize,
  );
  let selected = first;
  let qualityReview = await reviewRenderSafely(
    db,
    scene,
    product,
    first.buffer,
    input.placement,
    deadlineMs,
  );
  let totalEstimatedCostUsd = first.estimatedCostUsd;
  let repaired = false;
  let finalPlacement = input.placement;

  if (
    shouldRepair(qualityReview, input.placement) &&
    totalEstimatedCostUsd + perEditCostUsd <= serverConfig.openaiMaxCostUsd &&
    Date.now() + 185_000 < deadlineMs
  ) {
    const correctedPlacement =
      !qualityReview.scaleAndPerspectivePlausible &&
      Math.abs(qualityReview.scaleCorrectionFactor - 1) >= 0.05
        ? {
            ...input.placement,
            scale: clamp(
              input.placement.scale * qualityReview.scaleCorrectionFactor,
              0.035,
              0.68,
            ),
            rationale: `${input.placement.rationale} Échelle affinée après contrôle visuel.`,
          }
        : input.placement;
    const repairInput: ResolvedRenderInput = {
      ...input,
      placement: correctedPlacement,
    };
    const scaleWasCorrected = correctedPlacement !== input.placement;
    const repairComposition = scaleWasCorrected
      ? await compose(db, scene, product, repairInput, sourceSceneBuffer)
      : composition;
    const repair = await openAIEdit(
      db,
      product,
      repairComposition,
      repairInput,
      requestedSize,
      {
        ...(scaleWasCorrected ? {} : { baseBuffer: first.buffer }),
        feedback: qualityReview.feedback,
      },
    );
    totalEstimatedCostUsd += repair.estimatedCostUsd;
    const repairReview = await reviewRenderSafely(
      db,
      scene,
      product,
      repair.buffer,
      correctedPlacement,
      deadlineMs,
    );
    if (repairReview.score >= qualityReview.score) {
      selected = repair;
      qualityReview = repairReview;
      repaired = true;
      finalPlacement = correctedPlacement;
    }
  }

  return {
    ...selected,
    estimatedCostUsd: totalEstimatedCostUsd,
    qualityReview,
    repaired,
    finalPlacement,
  };
}

function shouldRepair(
  review: QualityReview,
  placement: ResolvedPlacement,
): boolean {
  return (
    !review.accepted ||
    review.score < 0.86 ||
    review.duplicateProduct ||
    review.artifactsPresent ||
    !review.scaleAndPerspectivePlausible ||
    !review.photorealistic ||
    (placement.operation === "replace" && !review.replacementComplete)
  );
}

function estimatedImageEditCost(
  requestedSize: RenderDocument["requestedSize"],
): number {
  return requestedSize === "1024x1024" ? 0.12 : 0.115;
}

async function reviewRenderSafely(
  db: Db,
  scene: SceneDocument,
  product: ProductDocument,
  renderBuffer: Buffer,
  placement: ResolvedPlacement,
  deadlineMs: number,
): Promise<QualityReview> {
  if (deadlineMs - Date.now() < 12_000) {
    return fallbackQualityReview();
  }
  try {
    return await openAIQualityReview(
      db,
      scene,
      product,
      renderBuffer,
      placement,
      deadlineMs,
    );
  } catch (reason) {
    console.warn("OpenAI render quality review failed", reason);
    return fallbackQualityReview();
  }
}

function fallbackQualityReview(): QualityReview {
  return {
    accepted: true,
    score: 0.9,
    replacementComplete: true,
    scaleAndPerspectivePlausible: true,
    scaleCorrectionFactor: 1,
    photorealistic: true,
    duplicateProduct: false,
    artifactsPresent: false,
    feedback:
      "Contrôle automatique indisponible; rendu haute fidélité conservé.",
  };
}

async function openAIQualityReview(
  db: Db,
  scene: SceneDocument,
  product: ProductDocument,
  renderBuffer: Buffer,
  placement: ResolvedPlacement,
  deadlineMs: number,
): Promise<QualityReview> {
  const [sceneAsset, cutoutAsset] = await Promise.all([
    readAsset(db, scene.assetId),
    readAsset(db, product.cutoutAssetId as string),
  ]);
  if (!sceneAsset || !cutoutAsset) {
    throw new RenderError("Fichier source introuvable", 404);
  }
  const operationInstruction =
    placement.operation === "replace"
      ? `The original object labeled ${placement.occupiedObject ?? "existing object"} must be completely absent, including every remnant and old shadow.`
      : "No pre-existing object needed removal at the target.";
  const response = await fetchOpenAIResponse(
    {
      model: serverConfig.openaiVisionModel,
      store: false,
      service_tier: serverConfig.openaiServiceTier,
      reasoning: { effort: "medium" },
      max_output_tokens: 2_000,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "Perform a strict photorealism quality-control review.",
                "Image 1 is the generated result. Image 2 is the untouched room. Image 3 is the exact catalog product reference.",
                operationInstruction,
                `The placement analysis classified the view as ${placement.perspective.framing}, distance ${placement.perspective.distance}, with occlusion ${placement.perspective.occlusion}.`,
                "Reject visible double objects, ghosts, leftover parts, melted or smeared textures, broken shelf geometry, halos, incorrect contact shadows, implausible scale or perspective, a floating product, identity changes, or duplicated products.",
                "Judge scale against the support depth and framing: a close-up target should appear larger than the same real object in a distant wide view.",
                "scaleCorrectionFactor is the width multiplier needed for the product: 1 means unchanged, below 1 smaller, above 1 larger.",
                "accepted must only be true when the result could pass as an unedited interior photograph at normal viewing size. Give concise actionable repair feedback.",
              ].join(" "),
            },
            {
              type: "input_image",
              image_url: `data:image/webp;base64,${renderBuffer.toString("base64")}`,
              detail: "original",
            },
            {
              type: "input_image",
              image_url: `data:${sceneAsset.asset.contentType};base64,${sceneAsset.buffer.toString("base64")}`,
              detail: "original",
            },
            {
              type: "input_image",
              image_url: `data:${cutoutAsset.asset.contentType};base64,${cutoutAsset.buffer.toString("base64")}`,
              detail: "original",
            },
          ],
        },
      ],
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "render_quality_review",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              accepted: { type: "boolean" },
              score: { type: "number", minimum: 0, maximum: 1 },
              replacementComplete: { type: "boolean" },
              scaleAndPerspectivePlausible: { type: "boolean" },
              scaleCorrectionFactor: {
                type: "number",
                minimum: 0.65,
                maximum: 1.5,
              },
              photorealistic: { type: "boolean" },
              duplicateProduct: { type: "boolean" },
              artifactsPresent: { type: "boolean" },
              feedback: { type: "string", maxLength: 300 },
            },
            required: [
              "accepted",
              "score",
              "replacementComplete",
              "scaleAndPerspectivePlausible",
              "scaleCorrectionFactor",
              "photorealistic",
              "duplicateProduct",
              "artifactsPresent",
              "feedback",
            ],
          },
        },
      },
    },
    Math.max(5_000, Math.min(35_000, deadlineMs - Date.now() - 5_000)),
  );
  if (!response.ok) {
    throw new RenderError(
      `Contrôle OpenAI ${response.status}: ${(await response.text()).slice(0, 300)}`,
      502,
    );
  }
  const payload = (await response.json()) as {
    output?: Array<{
      content?: Array<{ type?: string; text?: string }>;
    }>;
  };
  const outputText = payload.output
    ?.flatMap((item) => item.content ?? [])
    .find((item) => item.type === "output_text")?.text;
  if (!outputText) {
    throw new RenderError("Le contrôle qualité OpenAI est vide", 502);
  }
  const result = JSON.parse(outputText) as QualityReview;
  return {
    accepted: Boolean(result.accepted),
    score: clamp(Number(result.score), 0, 1),
    replacementComplete: Boolean(result.replacementComplete),
    scaleAndPerspectivePlausible: Boolean(result.scaleAndPerspectivePlausible),
    scaleCorrectionFactor: clamp(
      Number(result.scaleCorrectionFactor),
      0.65,
      1.5,
    ),
    photorealistic: Boolean(result.photorealistic),
    duplicateProduct: Boolean(result.duplicateProduct),
    artifactsPresent: Boolean(result.artifactsPresent),
    feedback: String(result.feedback).slice(0, 300),
  };
}

async function openAIEdit(
  db: Db,
  product: ProductDocument,
  composition: Composition,
  input: ResolvedRenderInput,
  requestedSize: RenderDocument["requestedSize"],
  repair?: { baseBuffer?: Buffer; feedback: string },
) {
  const estimatedCostUsd = estimatedImageEditCost(requestedSize);
  if (estimatedCostUsd > serverConfig.openaiMaxCostUsd) {
    throw new RenderError("Plafond de coût OpenAI dépassé", 422);
  }
  const cutoutAsset = await readAsset(db, product.cutoutAssetId as string);
  if (!cutoutAsset) {
    throw new RenderError("Fichier source introuvable", 404);
  }
  const baseBuffer = repair?.baseBuffer ?? composition.buffer;
  const baseMetadata = await sharp(baseBuffer).metadata();
  const baseWidth = baseMetadata.width ?? composition.sceneWidth;
  const baseHeight = baseMetadata.height ?? composition.sceneHeight;
  const maskPng = await sharp(composition.mask, {
    raw: {
      width: composition.sceneWidth,
      height: composition.sceneHeight,
      channels: 4,
    },
  })
    .resize({ width: baseWidth, height: baseHeight, kernel: "nearest" })
    .png()
    .toBuffer();
  const body = new FormData();
  body.append("model", serverConfig.openaiModel);
  body.append(
    "image[]",
    new Blob([toArrayBuffer(baseBuffer)], { type: "image/webp" }),
    repair ? "render-to-repair.webp" : "composition.webp",
  );
  body.append(
    "image[]",
    new Blob([toArrayBuffer(cutoutAsset.buffer)], {
      type: cutoutAsset.asset.contentType,
    }),
    "product.webp",
  );
  body.append(
    "mask",
    new Blob([toArrayBuffer(maskPng)], { type: "image/png" }),
    "mask.png",
  );
  body.append("quality", serverConfig.openaiQuality);
  if (!serverConfig.openaiModel.startsWith("gpt-image-2")) {
    body.append("input_fidelity", "high");
  }
  body.append("size", requestedSize);
  body.append("background", "opaque");
  body.append("output_format", "webp");
  body.append("output_compression", "90");
  body.append(
    "prompt",
    [
      repair
        ? repair.baseBuffer
          ? "Image 1 is the first generated render and needs one precise surgical repair inside the transparent mask."
          : "Image 1 is a newly recomposed placement with the scale corrected from the vision review; integrate it cleanly inside the transparent mask."
        : "Image 1 is an exact deterministic composition containing the catalog product at the analyzed position and scale.",
      "Image 1 contains the complete room context and the deterministic placement. Image 2 is the exact product identity reference.",
      input.placement.operation === "replace"
        ? input.placement.obstacleRemoved
          ? `Operation: REPLACE, cleanup already completed in the preceding layer. The old ${input.placement.occupiedObject ?? "object"} is absent from Image 1. Never recreate any part of it, its cable, reflection or shadow. Integrate exactly one catalog product into the now-empty zone.`
          : `Operation: REPLACE. Completely erase the old ${input.placement.occupiedObject ?? "object"} in the analyzed target bounds ${JSON.stringify(input.placement.replacementBox)}. Remove its full silhouette, appendages, base, cable, reflections and old contact shadow. Reconstruct the shelf back, wall, support surface and texture from the visible context surrounding the target in Image 1 before integrating exactly one catalog product.`
        : "Operation: PLACE on empty space. Integrate exactly one catalog product without removing or changing nearby objects.",
      "Change only the local masked target. Preserve the room geometry, camera angle, lens perspective, depth-of-field, crop, furniture, decor and every pixel outside the mask.",
      "Keep exactly one catalog product at the composed position, scale and pose. Preserve its silhouette, proportions, colors, labels and design from Image 2, while naturally re-rendering its material, highlights, surface texture and edge lighting so it belongs to the photograph instead of looking pasted on.",
      `Product: ${product.name}; ${product.description}; material ${product.material}; real dimensions ${product.widthCm} x ${product.heightCm} x ${product.depthCm} cm.`,
      `Perspective analysis: ${JSON.stringify(input.placement.perspective)}.`,
      `Lighting: ${JSON.stringify(input.placement.lighting ?? {})}.`,
      input.placement.perspective.occlusion !== "none"
        ? "Restore the original foreground shelf lip or edge visible in Image 1 in front of the lower product where physically required."
        : "Create a physically correct contact with the support; the product must not float.",
      "Match scene illumination direction, color temperature, white balance, exposure, local reflections, contact shadow softness, ambient occlusion, camera grain and compression. Remove halos, ghosts, doubled contours and smeared textures.",
      product.generationInstructions
        ? `Merchant aesthetic instructions, applied only when compatible with product fidelity and the mask: ${product.generationInstructions}`
        : "Use a natural, photorealistic and restrained interior photography finish.",
      repair
        ? `Mandatory repair feedback from the vision reviewer: ${repair.feedback}`
        : "The final result must look like one untouched photorealistic interior photograph, not a collage or a generative edit.",
    ].join(" "),
  );
  let response: Response;
  try {
    response = await fetch(`${serverConfig.openaiBaseUrl}/images/edits`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serverConfig.openaiApiKey}`,
        "Idempotency-Key": repair
          ? `${input.idempotencyKey}-repair`
          : input.idempotencyKey,
      },
      body,
      signal: AbortSignal.timeout(150_000),
    });
  } catch (reason) {
    if (isTimeoutError(reason)) {
      throw new RenderError(
        "La génération haute qualité a pris trop de temps. Réessayez avec la même photo.",
        504,
      );
    }
    throw reason;
  }
  if (!response.ok) {
    throw new RenderError(
      `OpenAI ${response.status}: ${(await response.text()).slice(0, 300)}`,
      502,
    );
  }
  const payload = (await response.json()) as {
    data?: Array<{ b64_json?: string }>;
  };
  const encoded = payload.data?.[0]?.b64_json;
  if (!encoded) {
    throw new RenderError("OpenAI n’a retourné aucune image", 502);
  }
  return {
    buffer: Buffer.from(encoded, "base64"),
    provider: "openai",
    model: serverConfig.openaiModel,
    estimatedCostUsd,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function isTimeoutError(reason: unknown): boolean {
  return (
    reason instanceof Error &&
    (reason.name === "TimeoutError" || reason.name === "AbortError")
  );
}

async function responseOutputText(response: Response): Promise<string> {
  const payload = (await response.json()) as {
    output?: Array<{
      content?: Array<{ type?: string; text?: string }>;
    }>;
  };
  const outputText = payload.output
    ?.flatMap((item) => item.content ?? [])
    .find((item) => item.type === "output_text")?.text;
  if (!outputText) {
    throw new RenderError(
      "L’analyse visuelle n’a retourné aucun résultat.",
      502,
    );
  }
  return outputText;
}

async function fetchOpenAIResponse(
  requestBody: Record<string, unknown>,
  timeoutMs: number,
): Promise<Response> {
  const send = (body: Record<string, unknown>) =>
    fetch(`${serverConfig.openaiBaseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serverConfig.openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

  const response = await send(requestBody);
  if (
    !response.ok &&
    requestBody.service_tier &&
    (response.status === 400 || response.status === 403)
  ) {
    const errorBody = await response.text();
    if (/service.?tier|fast|priority/i.test(errorBody)) {
      const fallbackBody = { ...requestBody };
      delete fallbackBody.service_tier;
      console.warn(
        "OpenAI Fast mode unavailable; retrying with standard processing",
      );
      return send(fallbackBody);
    }
    return new Response(errorBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  return response;
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  const copy = new Uint8Array(buffer.length);
  copy.set(buffer);
  return copy.buffer;
}

export class RenderError extends Error {
  constructor(
    message: string,
    public readonly status = 500,
  ) {
    super(message);
  }
}
