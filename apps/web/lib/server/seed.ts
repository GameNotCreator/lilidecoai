import "server-only";

import sharp from "sharp";
import type { Db } from "mongodb";

import { storeAsset } from "./assets";
import { collections } from "./mongodb";
import {
  DEMO_MERCHANT_SLUG,
  DEMO_ORGANIZATION_ID,
  DEMO_PRODUCT_ID,
  type ProductDocument,
} from "./types";

const DEMO_PRODUCT_ASSET_ID = "11111111-1111-4111-8111-111111111112";
const DEMO_CUTOUT_ASSET_ID = "11111111-1111-4111-8111-111111111113";

declare global {
  var __liliSeedPromise: Promise<void> | undefined;
}

export async function ensureDemoSeed(db: Db): Promise<void> {
  if (!globalThis.__liliSeedPromise) {
    globalThis.__liliSeedPromise = seed(db).catch((error) => {
      globalThis.__liliSeedPromise = undefined;
      throw error;
    });
  }
  await globalThis.__liliSeedPromise;
}

async function seed(db: Db): Promise<void> {
  const c = collections(db);
  await c.organizations.updateOne(
    { id: DEMO_ORGANIZATION_ID },
    {
      $setOnInsert: {
        id: DEMO_ORGANIZATION_ID,
        name: "Atelier Lili",
        slug: DEMO_MERCHANT_SLUG,
        createdAt: new Date(),
      },
    },
    { upsert: true },
  );
  await c.wallets.updateOne(
    { organizationId: DEMO_ORGANIZATION_ID },
    {
      $setOnInsert: {
        organizationId: DEMO_ORGANIZATION_ID,
        balance: 12,
        processedKeys: [],
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  );
  await c.wallets.updateOne(
    { organizationId: DEMO_ORGANIZATION_ID, balance: { $lt: 1 } },
    { $set: { balance: 12, updatedAt: new Date() } },
  );

  const existing = await c.products.findOne({ id: DEMO_PRODUCT_ID });
  if (existing) return;

  const vaseSvg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="720" height="900" viewBox="0 0 720 900">
      <defs>
        <linearGradient id="sand" x1="0" x2="1">
          <stop offset="0" stop-color="#8d735c"/>
          <stop offset=".45" stop-color="#d2b79b"/>
          <stop offset="1" stop-color="#7b604c"/>
        </linearGradient>
      </defs>
      <rect width="720" height="900" fill="#ffffff"/>
      <ellipse cx="360" cy="805" rx="205" ry="35" fill="#000" opacity=".12"/>
      <path d="M292 125h136l-11 112c91 79 135 187 123 326-13 158-73 238-180 238S193 721 180 563c-12-139 32-247 123-326z" fill="url(#sand)"/>
      <ellipse cx="360" cy="125" rx="68" ry="19" fill="#6e5442"/>
      <ellipse cx="360" cy="129" rx="49" ry="11" fill="#2d211b"/>
      <path d="M235 363c82 41 168 41 250 0" fill="none" stroke="#f2e3d2" stroke-width="13" opacity=".6"/>
    </svg>`;
  const source = await sharp(Buffer.from(vaseSvg)).png().toBuffer();
  const cutout = await sharp(Buffer.from(vaseSvg.replace("#ffffff", "none")))
    .png()
    .toBuffer();

  await storeAsset(
    db,
    {
      organizationId: DEMO_ORGANIZATION_ID,
      kind: "product",
      buffer: source,
      contentType: "image/png",
    },
    DEMO_PRODUCT_ASSET_ID,
  );
  await storeAsset(
    db,
    {
      organizationId: DEMO_ORGANIZATION_ID,
      kind: "cutout",
      buffer: cutout,
      contentType: "image/png",
    },
    DEMO_CUTOUT_ASSET_ID,
  );

  const now = new Date();
  const product: ProductDocument = {
    id: DEMO_PRODUCT_ID,
    organizationId: DEMO_ORGANIZATION_ID,
    name: "Vase Sable",
    description: "Vase artisanal en céramique mate.",
    sku: "VAS-SABLE-01",
    widthCm: 28,
    heightCm: 46,
    depthCm: 28,
    material: "Céramique mate",
    placementType: "table",
    lightingProfile: { source: "softbox-left", reflectance: "matte" },
    buyUrl: "https://example.com/vase-sable",
    status: "ready",
    assetId: DEMO_PRODUCT_ASSET_ID,
    cutoutAssetId: DEMO_CUTOUT_ASSET_ID,
    anchor: {
      anchorType: "bottom_center",
      xNormalized: 0.5,
      yNormalized: 1,
    },
    createdAt: now,
    updatedAt: now,
  };
  await c.products.insertOne(product);
}
