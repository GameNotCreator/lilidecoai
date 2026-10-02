import sharp from "sharp";
import type { PaddedComposition, SimpleComposition } from "./simple-composite";

export const STOREFRONT_REALISTIC_COMPOSITE_VERSION = "storefront-local-perspective-v1";

/** Allow a new camera view, including the top face, around each anchored object. */
export function perspectiveEditComposition(composition: SimpleComposition): SimpleComposition {
  const { sceneWidth: width, sceneHeight: height } = composition;
  const maskRaw = Buffer.alloc(width * height * 4, 255);
  for (const placement of composition.placements) {
    const left = Math.max(0, Math.floor(placement.left - placement.widthPx * 0.4));
    const right = Math.min(width, Math.ceil(placement.left + placement.widthPx * 1.4));
    const top = Math.max(0, Math.floor(placement.top - placement.heightPx * 0.55));
    const bottom = Math.min(height, Math.ceil(placement.top + placement.heightPx * 1.12));
    for (let y = top; y < bottom; y++)
      for (let x = left; x < right; x++) maskRaw[(y * width + x) * 4 + 3] = 0;
  }
  return { ...composition, maskRaw };
}

/**
 * Keep the generated camera pose inside the allowed region. Never re-stamp the
 * old catalogue angle. Every pixel outside the region comes from the real room;
 * the small edge blend runs inward, so it cannot alter the protected background.
 */
export async function restorePerspectiveBackground(
  composition: SimpleComposition,
  padded: PaddedComposition,
  generated: Buffer,
): Promise<Buffer> {
  const width = composition.sceneWidth;
  const height = composition.sceneHeight;
  if (!composition.sceneWebp || composition.maskRaw.length !== width * height * 4)
    throw new Error("Photographie ou masque de perspective invalide.");
  const [room, edited] = await Promise.all([
    sharp(composition.sceneWebp).removeAlpha().toColourspace("srgb").raw().toBuffer(),
    sharp(generated).resize(padded.paddedWidth, padded.paddedHeight, { fit: "fill" })
      .extract({ left: padded.offsetX, top: padded.offsetY, width, height })
      .removeAlpha().toColourspace("srgb").raw().toBuffer(),
  ]);
  if (room.length !== width * height * 3 || edited.length !== room.length)
    throw new Error("Dimensions de la photographie incohérentes.");
  const editable = (x: number, y: number) => x >= 0 && x < width && y >= 0 && y < height &&
    composition.maskRaw[(y * width + x) * 4 + 3] === 0;
  const output = Buffer.from(room);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!editable(x, y)) continue;
      let distance = 3;
      for (let radius = 1; radius <= 3; radius++) {
        if (!editable(x - radius, y) || !editable(x + radius, y) ||
            !editable(x, y - radius) || !editable(x, y + radius)) {
          distance = radius - 1;
          break;
        }
      }
      const alpha = distance / 3;
      const offset = (y * width + x) * 3;
      for (let channel = 0; channel < 3; channel++)
        output[offset + channel] = Math.round(room[offset + channel]! * (1 - alpha) + edited[offset + channel]! * alpha);
    }
  }
  return sharp(output, { raw: { width, height, channels: 3 } }).webp({ lossless: true }).toBuffer();
}
