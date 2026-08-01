import "server-only";

import sharp from "sharp";
import type { Db } from "mongodb";

import { createCutout, normalizeImage, storeAsset } from "./assets";
import { collections } from "./mongodb";
import {
  DEMO_CATALOG_USER_ID,
  DEMO_MERCHANT_SLUG,
  DEMO_ORGANIZATION_ID,
  DEMO_PRODUCT_ID,
  type ProductDocument,
} from "./types";

const DEMO_PRODUCT_ASSET_ID = "11111111-1111-4111-8111-111111111112";
const DEMO_CUTOUT_ASSET_ID = "11111111-1111-4111-8111-111111111113";

interface RemoteDemoProduct {
  id: string;
  assetId: string;
  cutoutAssetId: string;
  name: string;
  description: string;
  objectType: NonNullable<ProductDocument["objectType"]>;
  sku: string;
  widthCm: number;
  heightCm: number;
  depthCm: number;
  material: string;
  placementType: string;
  generationInstructions: string;
  imageUrl: string;
  imageSourceUrl: string;
  imageCredit: string;
  fallbackColor: string;
}

const remoteDemoProducts: RemoteDemoProduct[] = [
  {
    id: "22222222-2222-4222-8222-222222222221",
    assetId: "22222222-2222-4222-8222-222222222222",
    cutoutAssetId: "22222222-2222-4222-8222-222222222223",
    name: "Lampe Boman",
    description: "Lampe de table en verre et cuivre, silhouette Art déco.",
    objectType: "lamp",
    sku: "LAM-BOMAN-01",
    widthCm: 33,
    heightCm: 74.5,
    depthCm: 33,
    material: "Verre et cuivre",
    placementType: "table",
    generationInstructions:
      "Conserver la silhouette, le décor du verre et une lumière chaude crédible.",
    imageUrl:
      "https://upload.wikimedia.org/wikipedia/commons/b/be/Table_lamp_by_Axel_Enoch_Boman.jpg",
    imageSourceUrl:
      "https://commons.wikimedia.org/wiki/File:Table_lamp_by_Axel_Enoch_Boman.jpg",
    imageCredit:
      "Bodil Beckman, Nationalmuseum · Creative Commons BY 1.0",
    fallbackColor: "#705747",
  },
  {
    id: "33333333-3333-4333-8333-333333333331",
    assetId: "33333333-3333-4333-8333-333333333332",
    cutoutAssetId: "33333333-3333-4333-8333-333333333333",
    name: "Miroir Rococo",
    description: "Miroir mural italien à cadre sculpté de style rococo.",
    objectType: "mirror",
    sku: "MIR-ROCOCO-01",
    widthCm: 55.9,
    heightCm: 69.9,
    depthCm: 5,
    material: "Bois sculpté",
    placementType: "wall",
    generationInstructions:
      "Respecter le cadre sculpté et adapter discrètement les reflets à la pièce.",
    imageUrl:
      "https://upload.wikimedia.org/wikipedia/commons/6/6a/Rococo_mirror_frame_MET_86G_069r2m.jpg",
    imageSourceUrl:
      "https://commons.wikimedia.org/wiki/File:Rococo_mirror_frame_MET_86G_069r2m.jpg",
    imageCredit: "Metropolitan Museum of Art · CC0",
    fallbackColor: "#8b755a",
  },
  {
    id: "44444444-4444-4444-8444-444444444441",
    assetId: "44444444-4444-4444-8444-444444444442",
    cutoutAssetId: "44444444-4444-4444-8444-444444444443",
    name: "Table basse Noyer",
    description: "Table basse rectangulaire en bois, photographiée sur fond blanc.",
    objectType: "furniture",
    sku: "TAB-NOYER-01",
    widthCm: 110,
    heightCm: 45,
    depthCm: 60,
    material: "Bois foncé",
    placementType: "floor",
    generationInstructions:
      "Préserver les proportions et créer une ombre de contact réaliste sous les pieds.",
    imageUrl:
      "https://upload.wikimedia.org/wikipedia/commons/f/fa/Coffee_table_on_a_white_background.jpg",
    imageSourceUrl:
      "https://commons.wikimedia.org/wiki/File:Coffee_table_on_a_white_background.jpg",
    imageCredit: "JossDude · Domaine public",
    fallbackColor: "#674734",
  },
  {
    id: "55555555-5555-4555-8555-555555555551",
    assetId: "55555555-5555-4555-8555-555555555552",
    cutoutAssetId: "55555555-5555-4555-8555-555555555553",
    name: "Plante Plectranthus",
    description: "Plante verte compacte, idéale sur un meuble ou au sol.",
    objectType: "plant",
    sku: "PLA-PLECT-01",
    widthCm: 48,
    heightCm: 55,
    depthCm: 42,
    material: "Feuillage et terre cuite",
    placementType: "floor",
    generationInstructions:
      "Garder chaque feuille nette et ajouter une ombre douce adaptée à la lumière ambiante.",
    imageUrl:
      "https://upload.wikimedia.org/wikipedia/commons/thumb/9/91/Plectranthus_tomentosa_white_background.jpg/1280px-Plectranthus_tomentosa_white_background.jpg",
    imageSourceUrl:
      "https://commons.wikimedia.org/wiki/File:Plectranthus_tomentosa_white_background.jpg",
    imageCredit: "SirWalter · CC0",
    fallbackColor: "#547153",
  },
  {
    id: "66666666-6666-4666-8666-666666666661",
    assetId: "66666666-6666-4666-8666-666666666662",
    cutoutAssetId: "66666666-6666-4666-8666-666666666663",
    name: "Tapis Sienne",
    description: "Tapis rectangulaire texturé pour tester un placement au sol.",
    objectType: "rug",
    sku: "TAP-SIENNE-01",
    widthCm: 160,
    heightCm: 1.2,
    depthCm: 230,
    material: "Laine tissée",
    placementType: "floor",
    generationInstructions:
      "Plaquer le tapis sur la perspective du sol et conserver sa texture sans déformation.",
    imageUrl:
      "https://upload.wikimedia.org/wikipedia/commons/thumb/0/08/Carpet_%28original%29.png/960px-Carpet_%28original%29.png",
    imageSourceUrl:
      "https://commons.wikimedia.org/wiki/File:Carpet_(original).png",
    imageCredit: "Simon Svensson Thunman · CC0",
    fallbackColor: "#a65f43",
  },
  {
    id: "77777777-7777-4777-8777-777777777771",
    assetId: "77777777-7777-4777-8777-777777777772",
    cutoutAssetId: "77777777-7777-4777-8777-777777777773",
    name: "Horloge Blanche",
    description: "Horloge murale ronde, simple et facile à placer.",
    objectType: "clock",
    sku: "HOR-BLANCHE-01",
    widthCm: 30,
    heightCm: 30,
    depthCm: 5,
    material: "Plastique blanc et verre",
    placementType: "wall",
    generationInstructions:
      "Conserver le cadran lisible et aligner l’horloge verticalement au mur.",
    imageUrl:
      "https://upload.wikimedia.org/wikipedia/commons/thumb/4/42/White_Wall_Clock.jpg/960px-White_Wall_Clock.jpg",
    imageSourceUrl:
      "https://commons.wikimedia.org/wiki/File:White_Wall_Clock.jpg",
    imageCredit: "Jorge Barrios · Domaine public",
    fallbackColor: "#d9d9d5",
  },
  {
    id: "88888888-8888-4888-8888-888888888881",
    assetId: "88888888-8888-4888-8888-888888888882",
    cutoutAssetId: "88888888-8888-4888-8888-888888888883",
    name: "Affiche Mucha",
    description: "Affiche verticale Art nouveau pour tester une décoration murale.",
    objectType: "frame",
    sku: "AFF-MUCHA-01",
    widthCm: 50,
    heightCm: 74,
    depthCm: 2,
    material: "Papier encadré",
    placementType: "wall",
    generationInstructions:
      "Maintenir le cadre parfaitement vertical et respecter toutes les couleurs de l’affiche.",
    imageUrl:
      "https://commons.wikimedia.org/wiki/Special:FilePath/Mucha_Salon_des_Cents_poster_-_blank.jpg?width=600",
    imageSourceUrl:
      "https://commons.wikimedia.org/wiki/File:Mucha_Salon_des_Cents_poster_-_blank.jpg",
    imageCredit: "Alphonse Mucha · Domaine public",
    fallbackColor: "#c8976d",
  },
];

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
  await ensureDemoCredits(db);

  await seedVase(db);
  for (let index = 0; index < remoteDemoProducts.length; index += 3) {
    await Promise.all(
      remoteDemoProducts
        .slice(index, index + 3)
        .map((product) => seedRemoteProduct(db, product)),
    );
  }
}

export async function ensureDemoCredits(db: Db): Promise<void> {
  const wallets = collections(db).wallets;
  await wallets.updateOne(
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
  await wallets.updateOne(
    { organizationId: DEMO_ORGANIZATION_ID, balance: { $lt: 1 } },
    { $set: { balance: 12, updatedAt: new Date() } },
  );
}

async function seedVase(db: Db): Promise<void> {
  const c = collections(db);
  const existing = await c.products.findOne({ id: DEMO_PRODUCT_ID });
  if (existing) {
    if (!existing.objectType) {
      await c.products.updateOne(
        { id: DEMO_PRODUCT_ID },
        { $set: { objectType: "vase", updatedAt: new Date() } },
      );
    }
    return;
  }

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
    createdByUserId: DEMO_CATALOG_USER_ID,
    name: "Vase Sable",
    description: "Vase artisanal en céramique mate.",
    objectType: "vase",
    sku: "VAS-SABLE-01",
    widthCm: 28,
    heightCm: 46,
    depthCm: 28,
    material: "Céramique mate",
    placementType: "table",
    generationInstructions:
      "Conserver une ambiance naturelle, éditoriale et chaleureuse, avec une ombre de contact douce.",
    lightingProfile: { source: "softbox-left", reflectance: "matte" },
    buyUrl: null,
    status: "ready",
    assetId: DEMO_PRODUCT_ASSET_ID,
    cutoutAssetId: DEMO_CUTOUT_ASSET_ID,
    anchor: defaultAnchor,
    createdAt: now,
    updatedAt: now,
  };
  await c.products.insertOne(product);
}

async function seedRemoteProduct(
  db: Db,
  spec: RemoteDemoProduct,
): Promise<void> {
  const c = collections(db);
  if (await c.products.findOne({ id: spec.id })) return;

  let imageSourceUrl: string | undefined;
  let imageCredit: string | undefined;
  let source: Buffer;
  let cutout: Buffer;
  try {
    source = await downloadDemoImage(spec.imageUrl);
    cutout = await createCutout(source);
    imageSourceUrl = spec.imageSourceUrl;
    imageCredit = spec.imageCredit;
  } catch (reason) {
    console.warn(`Demo image unavailable for ${spec.name}; using fallback`, reason);
    ({ source, cutout } = await fallbackImages(spec));
  }

  await storeAsset(
    db,
    {
      organizationId: DEMO_ORGANIZATION_ID,
      kind: "product",
      buffer: source,
      contentType: "image/webp",
    },
    spec.assetId,
  );
  await storeAsset(
    db,
    {
      organizationId: DEMO_ORGANIZATION_ID,
      kind: "cutout",
      buffer: cutout,
      contentType: "image/webp",
    },
    spec.cutoutAssetId,
  );

  const now = new Date();
  const product: ProductDocument = {
    id: spec.id,
    organizationId: DEMO_ORGANIZATION_ID,
    createdByUserId: DEMO_CATALOG_USER_ID,
    name: spec.name,
    description: spec.description,
    objectType: spec.objectType,
    sku: spec.sku,
    widthCm: spec.widthCm,
    heightCm: spec.heightCm,
    depthCm: spec.depthCm,
    material: spec.material,
    placementType: spec.placementType,
    generationInstructions: spec.generationInstructions,
    lightingProfile: { source: "front", reflectance: "matte" },
    buyUrl: null,
    ...(imageSourceUrl ? { imageSourceUrl } : {}),
    ...(imageCredit ? { imageCredit } : {}),
    status: "ready",
    assetId: spec.assetId,
    cutoutAssetId: spec.cutoutAssetId,
    anchor: defaultAnchor,
    createdAt: now,
    updatedAt: now,
  };
  await c.products.insertOne(product);
}

async function downloadDemoImage(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "LiliDecoAI/1.0 (demo catalog; contact: https://lilidecoai-web.vercel.app)",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Image source responded with ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > 12_000_000) {
    throw new Error("Demo image exceeds 12 MB");
  }
  return normalizeImage(buffer, 1200);
}

async function fallbackImages(
  spec: RemoteDemoProduct,
): Promise<{ source: Buffer; cutout: Buffer }> {
  const silhouette = fallbackSilhouette(spec);
  const sourceSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900" viewBox="0 0 900 900"><rect width="900" height="900" fill="#fff"/>${silhouette}</svg>`;
  const cutoutSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900" viewBox="0 0 900 900">${silhouette}</svg>`;
  const [source, cutout] = await Promise.all([
    sharp(Buffer.from(sourceSvg)).webp({ quality: 92 }).toBuffer(),
    sharp(Buffer.from(cutoutSvg)).webp({ quality: 95 }).toBuffer(),
  ]);
  return { source, cutout };
}

function fallbackSilhouette(spec: RemoteDemoProduct): string {
  if (spec.objectType === "rug") {
    return `<path d="M145 300h610l80 390H65z" fill="${spec.fallbackColor}"/><path d="M130 620h640" stroke="#fff" stroke-width="18" opacity=".45"/>`;
  }
  if (spec.objectType === "mirror" || spec.objectType === "clock") {
    return `<ellipse cx="450" cy="430" rx="250" ry="300" fill="${spec.fallbackColor}"/><ellipse cx="450" cy="430" rx="205" ry="255" fill="#f1f1ee"/>`;
  }
  if (spec.objectType === "frame") {
    return `<rect x="230" y="100" width="440" height="680" rx="8" fill="${spec.fallbackColor}"/><rect x="265" y="135" width="370" height="610" fill="#f2dfc4"/>`;
  }
  if (spec.objectType === "furniture") {
    return `<rect x="125" y="360" width="650" height="150" rx="12" fill="${spec.fallbackColor}"/><rect x="175" y="500" width="55" height="250" fill="${spec.fallbackColor}"/><rect x="670" y="500" width="55" height="250" fill="${spec.fallbackColor}"/>`;
  }
  if (spec.objectType === "plant") {
    return `<path d="M450 580c-190-80-255-250-110-315 35 125 80 205 110 315zm0 0c190-80 255-250 110-315-35 125-80 205-110 315zm0-80c-80-180-30-330 0-345 60 90 75 220 0 345z" fill="${spec.fallbackColor}"/><path d="M310 570h280l-45 220H355z" fill="#9b6545"/>`;
  }
  return `<path d="M325 190h250l-25 165c95 105 110 315 15 415H335c-95-100-80-310 15-415z" fill="${spec.fallbackColor}"/>`;
}

const defaultAnchor = {
  anchorType: "bottom_center",
  xNormalized: 0.5,
  yNormalized: 1,
};
