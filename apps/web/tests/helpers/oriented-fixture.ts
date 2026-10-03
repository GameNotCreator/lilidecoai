import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import sharp from "sharp";
import type { PreparedProductView } from "@lili/types";
import { storeAsset } from "../../lib/server/assets";
import { collections } from "../../lib/server/mongodb";
import {
  ensurePreparedViewIndexes,
  preparedCollections,
  preparedSources,
} from "../../lib/server/prepared-views";
import { assertDurableDatabase } from "../../lib/server/durable-queue";
import type { ProductDocument, SceneDocument } from "../../lib/server/types";
import type { RenderInput } from "../../lib/server/render-request";

const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
export async function seedOrientedFixture(db: Db) {
  await assertDurableDatabase(db);
  await ensurePreparedViewIndexes(db);
  await collections(db).renders.createIndex(
    { organizationId: 1, idempotencyKey: 1 },
    { unique: true },
  );
  await collections(db).creditTransactions.createIndex(
    { organizationId: 1, idempotencyKey: 1 },
    { unique: true },
  );
  const now = new Date(),
    expiresAt = new Date(now.getTime() + 3_600_000);
  const solid = (width: number, height: number, background: string) =>
    sharp({ create: { width, height, channels: 3, background } })
      .png()
      .toBuffer();
  const room = await solid(600, 400, "#b4a591");
  const frontal = await solid(80, 120, "#0033cc");
  const pixels = Buffer.alloc(80 * 120 * 3),
    alpha = Buffer.alloc(80 * 120);
  for (let y = 20; y < 100; y++)
    for (let x = 20; x < 60; x++) {
      const i = y * 80 + x;
      alpha[i] = 255;
      pixels[3 * i] = (x + y) % 2 ? 150 : 90;
      pixels[3 * i + 1] = 65;
      pixels[3 * i + 2] = 45;
    }
  const prepared = await sharp(pixels, {
    raw: { width: 80, height: 120, channels: 3 },
  })
    .png()
    .toBuffer();
  const mask = await sharp(alpha, {
    raw: { width: 80, height: 120, channels: 1 },
  })
    .png()
    .toBuffer();
  const save = (
    buffer: Buffer,
    kind: Parameters<typeof storeAsset>[1]["kind"],
  ) =>
    storeAsset(db, {
      organizationId: "org",
      kind,
      buffer,
      visibility: "organization",
      contentType: "image/png",
      expiresAt,
    });
  const [sceneAsset, originalAsset, oldCutout, imageAsset, alphaAsset] =
    await Promise.all([
      save(room, "scene"),
      save(frontal, "product"),
      save(frontal, "product"),
      save(prepared, "render"),
      save(mask, "render"),
    ]);
  const product: ProductDocument = {
    id: "10000000-0000-4000-8000-000000000001",
    organizationId: "org",
    name: "Synthetic test vase",
    description: "Software fixture only",
    sku: null,
    widthCm: 24,
    heightCm: 40,
    depthCm: 24,
    material: "opaque ceramic",
    placementType: "floor",
    generationInstructions: "",
    lightingProfile: {},
    buyUrl: null,
    status: "ready",
    objectType: "vase",
    assetId: originalAsset.id,
    cutoutAssetId: oldCutout.id,
    createdAt: now,
    updatedAt: now,
    spatialMetadata: {
      measurementConvention: "full dimensions",
      dimensionSource: "catalog",
      supports: ["floor"],
      characteristicParts: ["rim"],
      contactProfile: "solid-base",
      volumeFamily: "vase",
    },
  };
  const scene: SceneDocument = {
    id: "20000000-0000-4000-8000-000000000001",
    organizationId: "org",
    assetId: sceneAsset.id,
    status: "uploaded",
    widthPx: 600,
    heightPx: 400,
    analysis: {},
    consentAt: now,
    createdAt: now,
    expiresAt,
  };
  await collections(db).products.insertOne(product);
  await collections(db).scenes.insertOne(scene);
  const sources = await preparedSources(db, product, null);
  const coverage = {
    azimuthMinDeg: -100,
    azimuthMaxDeg: 100,
    elevationMinDeg: 0,
    elevationMaxDeg: 85,
  };
  const view: PreparedProductView = {
    schemaVersion: 1,
    id: "prepared-view",
    organizationId: "org",
    productId: product.id,
    variantId: null,
    revision: 1,
    ...sources,
    origin: "generated",
    state: "approved",
    image: {
      assetId: imageAsset.id,
      sha256: hash(prepared),
      widthPx: 80,
      heightPx: 120,
    },
    alpha: {
      assetId: alphaAsset.id,
      sha256: hash(mask),
      widthPx: 80,
      heightPx: 120,
    },
    visibleBounds: { x: 0.25, y: 1 / 6, width: 0.5, height: 2 / 3 },
    anchor: { x: 0.5, y: 5 / 6, confidence: 1 },
    physicalHeightSegment: {
      bottom: { x: 0.5, y: 5 / 6 },
      top: { x: 0.5, y: 1 / 6 },
    },
    orientation: {
      convention: "camera-product-degrees-v1",
      requested: { azimuthDeg: 0, elevationDeg: 40, rollDeg: 0 },
      estimated: { azimuthDeg: 0, elevationDeg: 35, rollDeg: 0 },
      coverage,
    },
    review: {
      id: "fixture-review",
      kind: "human",
      actorId: "fixture-human-not-a-real-approval",
      decision: "approved",
      criteria: {
        identity: "pass",
        silhouette: "pass",
        color: "pass",
        pattern: "pass",
        alpha: "pass",
        contact: "pass",
      },
      coverage,
      allowedUsage: "internal_preview",
      limits: ["Synthetic software fixture; no product quality evidence"],
      unknownFaces: ["back"],
      evidenceAssetIds: [originalAsset.id, imageAsset.id],
      policyVersion: "prepared-review-v1",
      reviewedAt: now.toISOString(),
    },
    versions: {
      preparation: "prepared-view-v1",
      mask: "fixture",
      prompt: "fixture",
      providerConfiguration: "fixture",
    },
    preparation: { taskId: "fixture", costUsd: 0 },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  await preparedCollections(db).views.insertOne(view);
  await collections(db).wallets.insertOne({
    organizationId: "org",
    balance: 10,
    reserved: 0,
    holds: [],
    processedKeys: [],
    updatedAt: now,
  });
  const input: RenderInput = {
    engine: "oriented",
    placement: {
      productId: product.id,
      sceneId: scene.id,
      surfaceType: "floor",
    },
    placementPoint: { x: 0.5, y: 0.8 },
    surfaceType: "floor",
    idempotencyKey: "oriented-fixture-request",
  };
  return {
    product,
    scene,
    view,
    input,
    room,
    prepared,
    mask,
    frontal,
    oldCutoutId: oldCutout.id,
  };
}
