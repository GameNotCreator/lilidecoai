import "server-only";
import sharp from "sharp";
import { CUTOUT_VERSION } from "./assets";
import { prepareProductCutout } from "./product-cutout";
import { hasSeparatedSubjects } from "./mask-topology";
import { AdminProductError } from "./admin-products";

export const PREPARED_MATTE_VERSION = `prepared-matte-v2/${CUTOUT_VERSION}`;
/** This extracts alpha only. It never labels generated product pixels authentic. */
export async function prepareViewMatte(source: Buffer) {
  const matte = await prepareProductCutout(source);
  const multipleSubjects = await hasSeparatedSubjects(matte.buffer);
  if (multipleSubjects || matte.needsModelIsolation || Object.values(matte.quality).some(Boolean))
    throw new AdminProductError("Détourage incertain : vérifiez la silhouette, les détails fins et l’ombre attachée, puis fournissez une meilleure photo.", 422);
  const { data, info } = await sharp(matte.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    if ((data[(y * info.width + x) * 4 + 3] ?? 0) < 128) continue;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  if (maxX <= minX || maxY <= minY) throw new AdminProductError("Silhouette vide.", 422);
  const contactY = Math.min(info.height - 1, Math.round(matte.baseRowFraction * info.height));
  const contactXs: number[] = [];
  const band = Math.max(1, Math.round(info.height * 0.02));
  for (let y = Math.max(minY, contactY - band); y <= Math.min(maxY, contactY + band); y++)
    for (let x = minX; x <= maxX; x++) if ((data[(y * info.width + x) * 4 + 3] ?? 0) >= 240) contactXs.push(x);
  contactXs.sort((a, b) => a - b);
  if (!contactXs.length) throw new AdminProductError("Point de contact indéterminé.", 422);
  const anchorX = (contactXs[Math.floor(contactXs.length / 2)]! + 0.5) / info.width;
  const alpha = await sharp(matte.buffer).extractChannel("alpha").png().toBuffer();
  return { image: matte.buffer, alpha, widthPx: info.width, heightPx: info.height,
    visibleBounds: { x: minX / info.width, y: minY / info.height,
      width: (maxX - minX + 1) / info.width, height: (maxY - minY + 1) / info.height },
    anchor: { x: anchorX, y: (contactY + 0.5) / info.height, confidence: 0.85 },
    warnings: matte.warnings, maskSource: matte.source, version: `prepared-matte-v2/${matte.version}` };
}
