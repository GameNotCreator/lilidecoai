import "server-only";

import { v2 as cloudinary, type UploadApiResponse } from "cloudinary";
import { Binary, type Db } from "mongodb";
import sharp from "sharp";

import { cloudinaryStorageConfigured, serverConfig } from "./config";
import { collections } from "./mongodb";
import type { AssetDocument } from "./types";

const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const cloudinaryDeliveryType = "private" as const;

let cloudinaryReady = false;

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

  if (cloudinaryStorageConfigured()) {
    try {
      const uploaded = await uploadCloudinary(
        input.buffer,
        `${serverConfig.cloudinaryUploadFolder}/${input.organizationId}/${input.kind}/${id}`,
      );
      base.cloudinaryPublicId = uploaded.public_id;
      base.cloudinaryFormat = uploaded.format;
      base.cloudinaryVersion = uploaded.version;
      base.cloudinaryDeliveryType = cloudinaryDeliveryType;
    } catch (reason) {
      console.error("Cloudinary upload failed; using MongoDB fallback", reason);
      base.bytes = new Binary(input.buffer);
    }
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
  if (!asset.cloudinaryPublicId || !asset.cloudinaryFormat) return null;
  const client = cloudinaryClient();
  const deliveryType = asset.cloudinaryDeliveryType ?? "authenticated";
  const url = client.utils.private_download_url(
    asset.cloudinaryPublicId,
    asset.cloudinaryFormat,
    {
      resource_type: "image",
      type: deliveryType,
      expires_at: Math.floor(Date.now() / 1000) + 300,
      attachment: false,
    },
  );
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) return null;
  const buffer = Buffer.from(await response.arrayBuffer());
  return { asset, buffer };
}

export async function deleteAsset(db: Db, assetId: string): Promise<void> {
  const assets = collections(db).assets;
  const asset = await assets.findOne({ id: assetId });
  if (!asset) return;
  if (asset.cloudinaryPublicId) {
    const deliveryType = asset.cloudinaryDeliveryType ?? "authenticated";
    await cloudinaryClient().uploader.destroy(asset.cloudinaryPublicId, {
      resource_type: "image",
      type: deliveryType,
      invalidate: true,
    });
  }
  await assets.deleteOne({ id: assetId });
}

export function assetUrl(assetId: string | undefined): string | null {
  return assetId ? `/api/assets/${assetId}` : null;
}

function cloudinaryClient(): typeof cloudinary {
  if (cloudinaryReady) return cloudinary;
  if (!cloudinaryStorageConfigured()) {
    throw new Error("Cloudinary n’est pas configuré");
  }

  if (serverConfig.cloudinaryUrl) {
    const url = new URL(serverConfig.cloudinaryUrl);
    if (url.protocol !== "cloudinary:") {
      throw new Error("CLOUDINARY_URL doit commencer par cloudinary://");
    }
    cloudinary.config({
      cloud_name: decodeURIComponent(url.hostname),
      api_key: decodeURIComponent(url.username),
      api_secret: decodeURIComponent(url.password),
      secure: true,
      hide_sensitive: true,
    });
  } else {
    cloudinary.config({
      cloud_name: serverConfig.cloudinaryCloudName,
      api_key: serverConfig.cloudinaryApiKey,
      api_secret: serverConfig.cloudinaryApiSecret,
      secure: true,
      hide_sensitive: true,
    });
  }
  cloudinaryReady = true;
  return cloudinary;
}

function uploadCloudinary(
  buffer: Buffer,
  publicId: string,
): Promise<UploadApiResponse> {
  const client = cloudinaryClient();
  return new Promise((resolve, reject) => {
    const upload = client.uploader.upload_stream(
      {
        public_id: publicId,
        resource_type: "image",
        type: cloudinaryDeliveryType,
        overwrite: true,
        invalidate: true,
      },
      (error, result) => {
        if (error) return reject(error);
        if (!result) return reject(new Error("Réponse Cloudinary vide"));
        resolve(result);
      },
    );
    upload.end(buffer);
  });
}

export class ApiInputError extends Error {}
