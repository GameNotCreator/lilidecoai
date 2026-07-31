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

interface RenderInput {
  placement: {
    sceneId: string;
    productId: string;
    calibrationId?: string;
    mode: string;
    xNormalized: number;
    yNormalized: number;
    scale: number;
    rotationDegrees: number;
    lighting?: {
      direction?: string;
      temperature?: string;
      hardness?: string;
    };
  };
  idempotencyKey: string;
  quality?: string;
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
    const composition = await compose(db, scene, product, input);
    const generated = serverConfig.openaiApiKey
      ? await openAIEdit(db, scene, product, composition, input, requestedSize)
      : {
          buffer: composition.buffer,
          provider: "mock",
          model: "deterministic-compositor",
          estimatedCostUsd: 0,
        };
    const finalBuffer = await overlayOriginalProduct(
      generated.buffer,
      composition,
    );
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
    return renderResponse({ ...render, ...update });
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

async function compose(
  db: Db,
  scene: SceneDocument,
  product: ProductDocument,
  input: RenderInput,
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
  const mask = createProtectionMask(sceneWidth, sceneHeight, {
    left,
    top,
    width,
    height,
  });
  return { buffer, mask, overlay, left, top, width, height };
}

function createProtectionMask(
  width: number,
  height: number,
  box: { left: number; top: number; width: number; height: number },
): Buffer {
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
  return data;
}

async function openAIEdit(
  db: Db,
  scene: SceneDocument,
  product: ProductDocument,
  composition: Composition,
  input: RenderInput,
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
    new Blob([toArrayBuffer(sceneAsset.buffer)], {
      type: sceneAsset.asset.contentType,
    }),
    "room.webp",
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
    new Blob([toArrayBuffer(composition.buffer)], { type: "image/webp" }),
    "composition.webp",
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
      "Integrate the supplied catalog product into the room photograph.",
      "The deterministic composition is the exact source of truth for position, scale, rotation, silhouette, proportions, colors, patterns and details.",
      `Lighting: ${JSON.stringify(input.placement.lighting ?? {})}.`,
      "Only improve the contact shadow, local reflections, edge blending and light interaction inside the transparent mask.",
      "Do not add, remove, duplicate, reshape, recolor or redesign the product. Preserve every area outside the mask.",
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

async function overlayOriginalProduct(
  generated: Buffer,
  composition: Composition,
): Promise<Buffer> {
  return sharp(generated)
    .composite([
      {
        input: composition.overlay,
        left: composition.left,
        top: composition.top,
        blend: "over",
      },
    ])
    .webp({ quality: 92 })
    .toBuffer();
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
