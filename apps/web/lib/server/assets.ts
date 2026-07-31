import "server-only";

import { del, get, put } from "@vercel/blob";
import { Binary, type Db } from "mongodb";
import sharp from "sharp";

import { serverConfig } from "./config";
import { collections } from "./mongodb";
import type { AssetDocument } from "./types";

const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

function usesBlobStorage(): boolean {
  return Boolean(serverConfig.blobToken || process.env.VERCEL);
}

function blobTokenOption(): { token: string } | Record<string, never> {
  return serverConfig.blobToken ? { token: serverConfig.blobToken } : {};
}

export interface ImageAssetInput {
  organizationId: string;
  kind: AssetDocument["kind"];
  buffer: Buffer;
  contentType: string;
  expiresAt?: Date;
}

export async function validateImage(
  buffer: Buffer,
  contentType: string,
): Promise<{ width: number; height: number }> {
  if (!allowedTypes.has(contentType)) {
    throw new ApiInputError("Format accepté: JPEG, PNG ou WebP");
  }
  if (buffer.length === 0 || buffer.length > serverConfig.maxUploadBytes) {
    throw new ApiInputError(
      `Image trop volumineuse: maximum ${Math.floor(serverConfig.maxUploadBytes / 1_000_000)} Mo`,
    );
  }
  const metadata = await sharp(buffer, { failOn: "error" }).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width < 320 || height < 320) {
    throw new ApiInputError("L’image doit mesurer au moins 320 × 320 px");
  }
  return { width, height };
}

export async function normalizeImage(
  buffer: Buffer,
  maxDimension = 2048,
): Promise<Buffer> {
  return sharp(buffer, { failOn: "error" })
    .rotate()
    .resize({
      width: maxDimension,
      height: maxDimension,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 90 })
    .toBuffer();
}

export async function createCutout(buffer: Buffer): Promise<Buffer> {
  const normalized = await sharp(buffer, { failOn: "error" })
    .rotate()
    .resize({
      width: 1400,
      height: 1400,
      fit: "inside",
      withoutEnlargement: true,
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = normalized.data;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const red = pixels[offset] ?? 0;
    const green = pixels[offset + 1] ?? 0;
    const blue = pixels[offset + 2] ?? 0;
    const minimum = Math.min(red, green, blue);
    const maximum = Math.max(red, green, blue);
    const nearNeutral = maximum - minimum < 28;
    if (nearNeutral && minimum > 236) {
      pixels[offset + 3] = 0;
    } else if (nearNeutral && minimum > 210) {
      pixels[offset + 3] = Math.round(
        ((236 - minimum) / 26) * (pixels[offset + 3] ?? 255),
      );
    }
  }

  return sharp(pixels, {
    raw: {
      width: normalized.info.width,
      height: normalized.info.height,
      channels: 4,
    },
  })
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 95, alphaQuality: 100 })
    .toBuffer();
}

export async function storeAsset(
  db: Db,
  input: ImageAssetInput,
  fixedId = crypto.randomUUID(),
): Promise<AssetDocument> {
  const id = fixedId;
  const base: AssetDocument = {
    id,
    organizationId: input.organizationId,
    kind: input.kind,
    contentType: input.contentType,
    size: input.buffer.length,
    createdAt: new Date(),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  };

  if (usesBlobStorage()) {
    const blob = await put(
      `${input.organizationId}/${input.kind}/${id}`,
      input.buffer,
      {
        access: "private",
        addRandomSuffix: true,
        contentType: input.contentType,
        ...blobTokenOption(),
      },
    );
    base.blobPath = blob.pathname;
  } else {
    base.bytes = new Binary(input.buffer);
  }

  await collections(db).assets.updateOne(
    { id },
    { $set: base },
    { upsert: true },
  );
  return base;
}

export async function readAsset(
  db: Db,
  assetId: string,
): Promise<{ asset: AssetDocument; buffer: Buffer } | null> {
  const asset = await collections(db).assets.findOne({ id: assetId });
  if (!asset) return null;
  if (asset.bytes) {
    return {
      asset,
      buffer: Buffer.from(asset.bytes.buffer),
    };
  }
  if (!asset.blobPath) return null;
  const result = await get(asset.blobPath, {
    access: "private",
    ...blobTokenOption(),
  });
  if (!result || result.statusCode !== 200 || !result.stream) return null;
  const buffer = Buffer.from(await new Response(result.stream).arrayBuffer());
  return { asset, buffer };
}

export async function deleteAsset(db: Db, assetId: string): Promise<void> {
  const asset = await collections(db).assets.findOneAndDelete({ id: assetId });
  if (asset?.blobPath && usesBlobStorage()) {
    await del(asset.blobPath, blobTokenOption());
  }
}

export function assetUrl(assetId: string | undefined): string | null {
  return assetId ? `/api/assets/${assetId}` : null;
}

export class ApiInputError extends Error {}
