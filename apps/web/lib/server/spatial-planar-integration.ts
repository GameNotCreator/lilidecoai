import "server-only";
import sharp from "sharp";

export const PLANAR_LIGHTING_POLICY = {
  version: "planar-neutral-light-v1" as const,
  rugGainMin: 0.8,
  rugGainMax: 1.2,
  contactGainMin: 0.65,
  contactGainMax: 1,
};
export const PLANAR_FEATHERED_LIGHTING_POLICY = {
  ...PLANAR_LIGHTING_POLICY,
  version: "planar-neutral-light-v2" as const,
};

/** Generated RGB is never pasted. Only a smoothed, bounded scalar illumination
 * ratio is transferred onto original texture/room samples. This is an artistic
 * approximation, not intrinsic-image decomposition or physical relighting. */
export async function integratePlanarLighting(input: {
  room: Buffer;
  projected: Buffer;
  textureMask: Buffer;
  generated: Buffer; // Already aligned to original room coordinates.
  contactMask: Buffer; // One byte per original-room pixel.
  contactOpacity?: Buffer; // v7 only: outer-edge fade, never a larger edit domain.
}) {
  const decode = (data: Buffer) =>
    sharp(data)
      .removeAlpha()
      .toColourspace("srgb")
      .raw()
      .toBuffer({ resolveWithObject: true });
  const [room, projected, generated, mask] = await Promise.all([
    decode(input.room),
    decode(input.projected),
    decode(input.generated),
    sharp(input.textureMask)
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true }),
  ]);
  const { width, height } = room.info;
  if (
    width * height > 16_000_000 ||
    [projected, generated, mask].some(
      (image) => image.info.width !== width || image.info.height !== height,
    ) ||
    input.contactMask.length !== width * height ||
    (input.contactOpacity !== undefined &&
      input.contactOpacity.length !== width * height)
  )
    throw new Error("Dimensions incompatibles pour l’intégration du tapis.");
  const sigma = Math.max(8, Math.min(64, Math.min(width, height) / 16));
  const luminance = (data: Buffer, i: number) =>
    0.2126 * data[i * 3]! +
    0.7152 * data[i * 3 + 1]! +
    0.0722 * data[i * 3 + 2]!;
  async function gainField(
    weights: Buffer,
    baseline: Buffer,
    min: number,
    max: number,
  ) {
    const values = Buffer.alloc(width * height);
    for (let i = 0; i < values.length; i++) {
      const ratio = Math.max(
        min,
        Math.min(
          max,
          luminance(generated.data, i) / Math.max(1, luminance(baseline, i)),
        ),
      );
      values[i] = Math.round(((ratio - min) / (max - min)) * weights[i]!);
    }
    const blur = (data: Buffer) =>
      sharp(data, { raw: { width, height, channels: 1 } })
        .blur(sigma)
        .greyscale()
        .raw()
        .toBuffer();
    const [smooth, weight] = await Promise.all([blur(values), blur(weights)]);
    return { smooth, weight, min, max };
  }
  const textureWeights = Buffer.from(mask.data);
  const contactWeights = Buffer.from(input.contactMask);
  for (let i = 0; i < contactWeights.length; i++) {
    // Never transfer generated shadows through transparent texture pixels.
    if (textureWeights[i]) contactWeights[i] = 0;
  }
  const [rug, contact] = await Promise.all([
    gainField(textureWeights, projected.data, 0.8, 1.2),
    gainField(contactWeights, room.data, 0.65, 1),
  ]);
  const gain = (field: typeof rug, i: number) =>
    field.weight[i]
      ? Math.max(
          field.min,
          Math.min(
            field.max,
            field.min +
              ((field.max - field.min) * field.smooth[i]!) / field.weight[i]!,
          ),
        )
      : 1;
  const output = Buffer.from(room.data);
  for (let i = 0; i < width * height; i++) {
    const alpha = mask.data[i]! / 255;
    if (alpha) {
      // Uncomposite before relighting so anti-aliased room pixels stay untouched.
      const foreground = [0, 1, 2].map((c) =>
        Math.max(
          0,
          Math.min(
            255,
            (projected.data[i * 3 + c]! - room.data[i * 3 + c]! * (1 - alpha)) /
              alpha,
          ),
        ),
      );
      const factor = Math.min(gain(rug, i), 255 / Math.max(1, ...foreground));
      for (let c = 0; c < 3; c++)
        output[i * 3 + c] = Math.round(
          foreground[c]! * factor * alpha + room.data[i * 3 + c]! * (1 - alpha),
        );
    } else if (contactWeights[i]) {
      const strength =
        input.contactOpacity === undefined ? 1 : input.contactOpacity[i]! / 255;
      const factor = 1 - (1 - gain(contact, i)) * strength;
      for (let c = 0; c < 3; c++)
        output[i * 3 + c] = Math.round(room.data[i * 3 + c]! * factor);
    }
  }
  return sharp(output, { raw: { width, height, channels: 3 } })
    .webp({ lossless: true })
    .toBuffer();
}
