import "server-only";
import { createHash } from "node:crypto";
import sharp from "sharp";
import type { Db } from "mongodb";
import { planarTextureInputSchema, planarTextureSchema } from "@lili/types";
import { currentPlanarTexture } from "../planar-texture";
import { readAsset, ApiInputError } from "./assets";
import { collections } from "./mongodb";
import type { ProductDocument } from "./types";

export async function savePlanarTexture(
  db: Db,
  product: ProductDocument,
  value: unknown,
) {
  const input = planarTextureInputSchema.parse(value);
  if (
    product.objectType !== "rug" ||
    product.placementType !== "floor" ||
    !(product.widthCm > 0 && product.depthCm > 0)
  )
    throw new ApiInputError(
      "Enregistrez d’abord un tapis posé au sol avec sa largeur et sa profondeur.",
    );
  if (
    input.assetId !== product.assetId &&
    !product.views?.some(
      (v) => v.assetId === input.assetId && v.validationStatus === "valid",
    )
  )
    throw new ApiInputError(
      "Choisissez une photo validée de cette fiche produit.",
    );
  const asset = await readAsset(db, input.assetId);
  if (!asset || asset.asset.organizationId !== product.organizationId)
    throw new ApiInputError("Photo introuvable pour cette boutique.");
  const { info } = await sharp(asset.buffer)
    .rotate()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (Math.min(info.width, info.height) < 256)
    throw new ApiInputError(
      "La photo doit mesurer au moins 256 pixels de chaque côté.",
    );
  if (
    input.corners.some((p, i) => {
      const q = input.corners[(i + 1) % 4]!;
      return (
        Math.hypot((p.x - q.x) * info.width, (p.y - q.y) * info.height) < 64
      );
    })
  )
    throw new ApiInputError(
      "La zone de texture est trop petite. Utilisez une photo plus détaillée.",
    );
  const planarTexture = planarTextureSchema.parse({
    ...input,
    version: 1,
    fingerprint: createHash("sha256").update(asset.buffer).digest("hex"),
    widthPx: info.width,
    heightPx: info.height,
    productWidthCm: product.widthCm,
    productDepthCm: product.depthCm,
    confirmedAt: new Date().toISOString(),
  });
  const updatedAt = new Date();
  const result = await collections(db).products.updateOne(
    {
      id: product.id,
      organizationId: product.organizationId,
      updatedAt: product.updatedAt,
    },
    { $set: { planarTexture, updatedAt }, $unset: { spatialPreparation: "" } },
  );
  if (!result.matchedCount)
    throw new ApiInputError(
      "La fiche a changé. Actualisez-la avant de confirmer les coins.",
    );
  return {
    ...product,
    planarTexture,
    updatedAt,
    spatialPreparation: undefined,
  };
}

/** Required at consumption time: never trust a saved selection after bytes changed. */
export async function readVerifiedPlanarTexture(
  db: Db,
  product: ProductDocument,
) {
  const reference = currentPlanarTexture(product);
  if (!reference)
    throw new ApiInputError(
      "Définissez à nouveau les quatre coins de la texture.",
    );
  const asset = await readAsset(db, reference.assetId);
  if (
    !asset ||
    asset.asset.organizationId !== product.organizationId ||
    createHash("sha256").update(asset.buffer).digest("hex") !==
      reference.fingerprint
  )
    throw new ApiInputError(
      "La photo de texture a changé ou n’est plus disponible. Confirmez à nouveau ses coins.",
    );
  return { reference, buffer: asset.buffer };
}
