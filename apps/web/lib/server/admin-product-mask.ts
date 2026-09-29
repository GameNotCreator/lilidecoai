import "server-only";
import sharp from "sharp";
import { AdminProductError } from "./admin-products";
import { applyProductMask } from "./product-cutout";

export const MAX_ADMIN_MASK_BYTES = 4 * 1024 * 1024;
export interface AdminProductMask {
  buffer: Buffer;
  sourceAssetId: string;
  sourceSha256: string;
}

/** A mask supplies coverage only. All visible RGB is read from the stored photo. */
export async function applyAdminProductMask(source: Buffer, mask: Buffer) {
  if (mask.length > MAX_ADMIN_MASK_BYTES || !mask.length)
    throw new AdminProductError("Le masque PNG doit faire moins de 4 Mo.", 422);
  try {
    const metadata = await sharp(mask, { limitInputPixels: 2048 ** 2, failOn: "error" }).metadata();
    if (metadata.format !== "png" || metadata.hasAlpha || (metadata.pages ?? 1) !== 1 || metadata.space !== "b-w")
      throw new Error("Expected a single grayscale PNG coverage mask");
    const alpha = await sharp(mask).raw().toBuffer();
    let opaque = 0, transparent = 0;
    for (const value of alpha) {
      if (value >= 245) opaque++;
      if (value <= 10) transparent++;
    }
    // Reject an unchanged photo frame or an empty/ghost product before the
    // heuristic can reinterpret the mask as a fresh source photograph.
    if (opaque < alpha.length * 0.05 || transparent < alpha.length * 0.05)
      throw new Error("Mask must contain both a solid product and removed background");
    return await applyProductMask(source, mask);
  } catch {
    throw new AdminProductError("Masque invalide : utilisez un PNG en niveaux de gris, sans transparence, aux dimensions exactes de la photo. Le produit doit être blanc et le fond noir.", 422);
  }
}
