import "server-only";

import { selectOutputSize } from "@lili/geometry";
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

interface ResolvedPlacement extends PlacementInput {
  mode: string;
  surfaceType: string;
  xNormalized: number;
  yNormalized: number;
  scale: number;
  rotationDegrees: number;
  confidence: number;
  rationale: string;
  source: "manual" | "openai-vision" | "automatic-fallback";
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
  overlay: Buffer;
  left: number;
  top: number;
  width: number;
  height: number;
}

export async function createRender(
  db: Db,
  organizationId: string,
  input: RenderInput,
  publicSessionId?: string,
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
    const generated = serverConfig.openaiApiKey
      ? await openAIEdit(
          db,
          scene,
          product,
          composition,
          resolvedInput,
          requestedSize,
        )
      : {
          buffer: composition.buffer,
          provider: "mock",
          model: "deterministic-compositor",
          estimatedCostUsd: 0,
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
      `render:${renderId}`,
    );
    const update = {
      status: "succeeded" as const,
      provider: generated.provider,
      model: generated.model,
      resultAssetId: resultAsset.id,
      qualityScore: generated.provider === "mock" ? 0.99 : 0.94,
      creditCharged,
      updatedAt: new Date(),
    };
    await c.renders.updateOne({ id: renderId }, { $set: update });
    await c.renderAttempts.insertOne({
      id: crypto.randomUUID(),
      organizationId,
      renderId,
      provider: generated.provider,
      model: generated.model,
      status: "succeeded",
      latencyMs: Date.now() - startedAt,
      estimatedCostUsd: generated.estimatedCostUsd,
      createdAt: new Date(),
    });
    return renderResponse({
      ...render,
      placement: resolvedPlacement,
      ...update,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Rendu impossible";
    await c.renders.updateOne(
      { id: renderId },
      {
        $set: {
          status: "failed",
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
    throw error;
  }
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

async function openAIPlacement(
  db: Db,
  scene: SceneDocument,
  product: ProductDocument,
  input: PlacementInput,
  surfaceType: string,
): Promise<ResolvedPlacement> {
  const sceneAsset = await readAsset(db, scene.assetId);
  if (!sceneAsset) throw new RenderError("Photo de pièce introuvable", 404);
  const response = await fetch(`${serverConfig.openaiBaseUrl}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serverConfig.openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: serverConfig.openaiVisionModel,
      store: false,
      max_output_tokens: 500,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "Choose the most realistic and visually balanced placement for this catalog product in the supplied room photo.",
                `Required support type: ${surfaceType}.`,
                `Product: ${product.name}; ${product.description}; material ${product.material}; real dimensions ${product.widthCm} x ${product.heightCm} x ${product.depthCm} cm.`,
                "Return normalized coordinates relative to the full image: xNormalized is the horizontal center of the product, yNormalized is its bottom contact point, and scale is the product width divided by room image width.",
                "Prefer a clear, physically plausible support area, preserve walkways and existing objects, respect perspective, and avoid image edges.",
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
            ],
          },
        },
      },
    }),
    signal: AbortSignal.timeout(45_000),
  });
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
  };
  return {
    ...input,
    mode: "auto",
    surfaceType,
    xNormalized: clamp(Number(result.xNormalized), 0.04, 0.96),
    yNormalized: clamp(Number(result.yNormalized), 0.08, 0.98),
    scale: clamp(Number(result.scale), 0.06, 0.55),
    rotationDegrees: clamp(Number(result.rotationDegrees), -20, 20),
    lighting: {
      direction: result.lightingDirection,
      temperature: result.lightingTemperature,
      hardness: "soft",
    },
    confidence: clamp(Number(result.confidence), 0, 1),
    rationale: String(result.rationale).slice(0, 240),
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
  return {
    ...input,
    mode: "auto",
    surfaceType,
    xNormalized: selected.x,
    yNormalized: selected.y,
    scale: clamp(selected.scale + scaleAdjustment, 0.06, 0.55),
    rotationDegrees: selected.rotation,
    lighting: {
      direction: light?.direction ?? "left",
      temperature: light?.temperature ?? "neutral",
      hardness: "soft",
    },
    confidence: serverConfig.openaiApiKey ? 0.58 : 0.46,
    rationale:
      "Placement automatique basé sur le type de support, les dimensions du produit et la perspective de la pièce.",
    source: "automatic-fallback",
  };
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
): Promise<Composition> {
  const [sceneAsset, cutoutAsset] = await Promise.all([
    readAsset(db, scene.assetId),
    readAsset(db, product.cutoutAssetId as string),
  ]);
  if (!sceneAsset || !cutoutAsset) {
    throw new RenderError("Fichier source introuvable", 404);
  }
  const sceneMetadata = await sharp(sceneAsset.buffer).metadata();
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
  const buffer = await sharp(sceneAsset.buffer)
    .rotate()
    .composite([
      { input: shadow, blend: "over" },
      { input: overlay, left, top, blend: "over" },
    ])
    .webp({ quality: 92 })
    .toBuffer();
  const mask = await createEditMask(sceneWidth, sceneHeight, overlay, {
    left,
    top,
    width,
    height,
  });
  return { buffer, mask, overlay, left, top, width, height };
}

async function createEditMask(
  width: number,
  height: number,
  overlay: Buffer,
  box: { left: number; top: number; width: number; height: number },
): Promise<Buffer> {
  const data = Buffer.alloc(width * height * 4, 255);
  const padding = Math.max(
    6,
    Math.round(Math.min(box.width, box.height) * 0.06),
  );
  const minX = Math.max(0, box.left - padding);
  const maxX = Math.min(width, box.left + box.width + padding);
  const minY = Math.max(0, box.top - padding);
  const maxY = Math.min(height, box.top + box.height + padding);
  for (let y = minY; y < maxY; y += 1) {
    for (let x = minX; x < maxX; x += 1) {
      data[(y * width + x) * 4 + 3] = 0;
    }
  }

  const product = await sharp(overlay).ensureAlpha().raw().toBuffer();
  for (let y = 0; y < box.height; y += 1) {
    for (let x = 0; x < box.width; x += 1) {
      const productAlpha = product[(y * box.width + x) * 4 + 3] ?? 0;
      if (productAlpha < 20) continue;
      const sceneX = box.left + x;
      const sceneY = box.top + y;
      if (sceneX < 0 || sceneX >= width || sceneY < 0 || sceneY >= height) {
        continue;
      }
      data[(sceneY * width + sceneX) * 4 + 3] = productAlpha;
    }
  }
  return data;
}

async function openAIEdit(
  db: Db,
  scene: SceneDocument,
  product: ProductDocument,
  composition: Composition,
  input: ResolvedRenderInput,
  requestedSize: RenderDocument["requestedSize"],
) {
  const estimatedCostUsd = requestedSize === "1024x1024" ? 0.053 : 0.041;
  if (estimatedCostUsd > serverConfig.openaiMaxCostUsd) {
    throw new RenderError("Plafond de coût OpenAI dépassé", 422);
  }
  const [sceneAsset, cutoutAsset] = await Promise.all([
    readAsset(db, scene.assetId),
    readAsset(db, product.cutoutAssetId as string),
  ]);
  if (!sceneAsset || !cutoutAsset) {
    throw new RenderError("Fichier source introuvable", 404);
  }
  const maskPng = await sharp(composition.mask, {
    raw: { width: scene.widthPx, height: scene.heightPx, channels: 4 },
  })
    .png()
    .toBuffer();
  const body = new FormData();
  body.append("model", serverConfig.openaiModel);
  body.append(
    "image[]",
    new Blob([toArrayBuffer(composition.buffer)], { type: "image/webp" }),
    "composition.webp",
  );
  body.append(
    "image[]",
    new Blob([toArrayBuffer(cutoutAsset.buffer)], {
      type: cutoutAsset.asset.contentType,
    }),
    "product.webp",
  );
  body.append(
    "image[]",
    new Blob([toArrayBuffer(sceneAsset.buffer)], {
      type: sceneAsset.asset.contentType,
    }),
    "room.webp",
  );
  body.append(
    "mask",
    new Blob([toArrayBuffer(maskPng)], { type: "image/png" }),
    "mask.png",
  );
  body.append("quality", input.quality ?? serverConfig.openaiQuality);
  body.append("size", requestedSize);
  body.append("background", "opaque");
  body.append("output_format", "webp");
  body.append("output_compression", "90");
  body.append(
    "prompt",
    [
      "The first image is an exact deterministic composition that already contains the catalog product in its final position.",
      "Improve only the contact shadow, local reflections, edge blending and light interaction in the transparent mask surrounding the existing product.",
      "Never generate, add or duplicate another product. Never move, resize, rotate, reshape, recolor or redesign the existing product.",
      "The second image is the product identity reference and the third image is the untouched room reference.",
      `Product: ${product.name}; ${product.description}; material ${product.material}; real dimensions ${product.widthCm} x ${product.heightCm} x ${product.depthCm} cm.`,
      `Lighting: ${JSON.stringify(input.placement.lighting ?? {})}.`,
      product.generationInstructions
        ? `Merchant aesthetic instructions, applied only when compatible with product fidelity and the mask: ${product.generationInstructions}`
        : "Use a natural, photorealistic and restrained interior photography finish.",
      "Preserve every pixel outside the transparent mask and keep the result photorealistic.",
    ].join(" "),
  );
  const response = await fetch(`${serverConfig.openaiBaseUrl}/images/edits`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serverConfig.openaiApiKey}`,
      "Idempotency-Key": input.idempotencyKey,
    },
    body,
    signal: AbortSignal.timeout(120_000),
  });
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
