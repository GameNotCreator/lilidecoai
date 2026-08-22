import sharp from "sharp";

/**
 * Deterministic composite pipeline for the simple multi-point workflow.
 *
 * Position and size are geometry, not generation: the product cutout is pasted
 * at its exact target location before the model is called, the model may only
 * touch the masked area around each object (shadow, light, seam), and
 * `pasteBackOutsideMask` restores every pixel outside the mask from the
 * composite afterwards. Overflow past a shelf, a moved object or a redecorated
 * room become impossible by construction, not by prompt.
 */

export type SimpleCompositeDimensionPair =
  | { mode: "height_length"; heightCm: number; lengthCm: number }
  | { mode: "length_width"; lengthCm: number; widthCm: number };

export interface SimpleCompositeObjectInput {
  cutout: Buffer;
  point: { x: number; y: number };
  dimensions: SimpleCompositeDimensionPair;
  /** Pixels per centimetre on the support surface at the point, when known. */
  pixelsPerCm: number | null;
}

export interface SimpleCompositePlacement {
  objectIndex: number;
  left: number;
  top: number;
  widthPx: number;
  heightPx: number;
  pixelsPerCm: number | null;
  scaleSource: "vision" | "assumed_room_width";
}

export interface PlacedOverlay {
  /** The cutout resized to its final size, RGBA png. */
  png: Buffer;
  left: number;
  top: number;
  widthPx: number;
  heightPx: number;
}

export interface SimpleComposition {
  imageWebp: Buffer;
  /** RGBA scene-sized mask: alpha 0 = editable, alpha 255 = preserved. */
  maskRaw: Buffer;
  sceneWidth: number;
  sceneHeight: number;
  placements: SimpleCompositePlacement[];
  /** Kept for the identity re-stamp after harmonization. */
  overlays: PlacedOverlay[];
}

export interface PaddedComposition {
  imageWebp: Buffer;
  maskPng: Buffer;
  offsetX: number;
  offsetY: number;
  paddedWidth: number;
  paddedHeight: number;
  padded: boolean;
}

/** Fallback when no calibration exists: a room photo spans roughly 300 cm. */
export const ASSUMED_ROOM_WIDTH_CM = 300;

const MIN_OBJECT_FRACTION = 0.035;
const MAX_OBJECT_WIDTH_FRACTION = 0.6;
const MAX_OBJECT_HEIGHT_FRACTION = 0.85;

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function computeTargetPixelSize(
  dimensions: SimpleCompositeDimensionPair,
  pixelsPerCm: number | null,
  cutoutAspect: number,
  sceneWidth: number,
  sceneHeight: number,
): {
  widthPx: number;
  heightPx: number;
  scaleSource: SimpleCompositePlacement["scaleSource"];
} {
  const aspect = clampNumber(cutoutAspect, 0.05, 20);
  const perCm = pixelsPerCm ?? sceneWidth / ASSUMED_ROOM_WIDTH_CM;
  let widthPx: number;
  let heightPx: number;
  if (dimensions.mode === "height_length") {
    heightPx = dimensions.heightCm * perCm;
    widthPx = heightPx * aspect;
  } else {
    widthPx = Math.max(dimensions.lengthCm, dimensions.widthCm) * perCm;
    heightPx = widthPx / aspect;
  }
  const shrink = Math.min(
    1,
    (sceneWidth * MAX_OBJECT_WIDTH_FRACTION) / widthPx,
    (sceneHeight * MAX_OBJECT_HEIGHT_FRACTION) / heightPx,
  );
  const grow = Math.max(
    1,
    (sceneWidth * MIN_OBJECT_FRACTION) / widthPx,
    16 / Math.min(widthPx, heightPx),
  );
  const factor = shrink < 1 ? shrink : grow;
  return {
    widthPx: Math.max(1, Math.round(widthPx * factor)),
    heightPx: Math.max(1, Math.round(heightPx * factor)),
    scaleSource: pixelsPerCm ? "vision" : "assumed_room_width",
  };
}

/**
 * The editable region hugs each object's silhouette (dilated ~3 px) plus a
 * generous contact-shadow ellipse under the base — never a full bounding box.
 * Neighbouring items and the wall behind the object stay outside the model's
 * reach; the model only gets the edge-blend ring and the shadow zone.
 */
export async function createSilhouetteMask(
  width: number,
  height: number,
  overlays: PlacedOverlay[],
): Promise<Buffer> {
  const silhouettes = await Promise.all(
    overlays.map(async (overlay) => ({
      input: await sharp(overlay.png)
        .ensureAlpha()
        .extractChannel("alpha")
        .png()
        .toBuffer(),
      left: overlay.left,
      top: overlay.top,
    })),
  );
  const shadowSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${overlays
      .map(
        (overlay) =>
          `<ellipse cx="${overlay.left + overlay.widthPx / 2}" cy="${overlay.top + overlay.heightPx * 0.985}" rx="${overlay.widthPx * 0.55}" ry="${Math.max(10, overlay.heightPx * 0.06)}" fill="#ffffff"/>`,
      )
      .join("")}</svg>`,
  );
  const region = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .composite([
      ...silhouettes.map((shape) => ({
        input: shape.input,
        left: shape.left,
        top: shape.top,
        blend: "over" as const,
      })),
      { input: shadowSvg, blend: "over" as const },
    ])
    .toColourspace("b-w")
    .blur(2)
    .threshold(20)
    .raw()
    .toBuffer();

  const data = Buffer.alloc(width * height * 4, 255);
  for (let i = 0; i < width * height; i += 1) {
    if ((region[i] ?? 0) > 0) data[i * 4 + 3] = 0;
  }
  return data;
}

export async function compositeObjectsOnScene(
  sceneImage: Buffer,
  sceneWidth: number,
  sceneHeight: number,
  objects: SimpleCompositeObjectInput[],
): Promise<SimpleComposition> {
  const prepared = await Promise.all(
    objects.map(async (object, index) => {
      const metadata = await sharp(object.cutout).metadata();
      const aspect = (metadata.width ?? 1) / Math.max(1, metadata.height ?? 1);
      const size = computeTargetPixelSize(
        object.dimensions,
        object.pixelsPerCm,
        aspect,
        sceneWidth,
        sceneHeight,
      );
      const left = Math.round(
        clampNumber(
          object.point.x * sceneWidth - size.widthPx / 2,
          0,
          Math.max(0, sceneWidth - size.widthPx),
        ),
      );
      const top = Math.round(
        clampNumber(
          object.point.y * sceneHeight - size.heightPx,
          0,
          Math.max(0, sceneHeight - size.heightPx),
        ),
      );
      const overlay = await sharp(object.cutout)
        .resize({ width: size.widthPx, height: size.heightPx, fit: "fill" })
        .png()
        .toBuffer();
      return {
        index,
        overlay,
        left,
        top,
        widthPx: size.widthPx,
        heightPx: size.heightPx,
        pixelsPerCm: object.pixelsPerCm,
        scaleSource: size.scaleSource,
        pointY: object.point.y,
      };
    }),
  );

  // Nearer objects (larger y) composite last so they overlap farther ones.
  const ordered = [...prepared].sort((a, b) => a.pointY - b.pointY);
  const shadows = await Promise.all(
    ordered.map((placement) => {
      const svg = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${sceneWidth}" height="${sceneHeight}"><ellipse cx="${placement.left + placement.widthPx / 2}" cy="${placement.top + placement.heightPx * 0.985}" rx="${placement.widthPx * 0.42}" ry="${Math.max(6, placement.heightPx * 0.03)}" fill="#151009" fill-opacity=".24"/></svg>`,
      );
      return sharp(svg).blur(9).png().toBuffer();
    }),
  );
  const imageWebp = await sharp(sceneImage)
    .composite([
      ...shadows.map((shadow) => ({ input: shadow, blend: "over" as const })),
      ...ordered.map((placement) => ({
        input: placement.overlay,
        left: placement.left,
        top: placement.top,
        blend: "over" as const,
      })),
    ])
    .webp({ quality: 94 })
    .toBuffer();

  const overlays: PlacedOverlay[] = prepared.map((placement) => ({
    png: placement.overlay,
    left: placement.left,
    top: placement.top,
    widthPx: placement.widthPx,
    heightPx: placement.heightPx,
  }));
  const maskRaw = await createSilhouetteMask(sceneWidth, sceneHeight, overlays);
  return {
    imageWebp,
    maskRaw,
    sceneWidth,
    sceneHeight,
    placements: prepared.map((placement) => ({
      objectIndex: placement.index,
      left: placement.left,
      top: placement.top,
      widthPx: placement.widthPx,
      heightPx: placement.heightPx,
      pixelsPerCm: placement.pixelsPerCm,
      scaleSource: placement.scaleSource,
    })),
    overlays,
  };
}

/**
 * gpt-image-2 only outputs 1024x1024 / 1536x1024 / 1024x1536. When the scene
 * has a different aspect ratio the composite is letterboxed with neutral gray
 * (masked as non-editable) so the model never crops; the bars are removed
 * before paste-back.
 */
export async function padCompositionForAspect(
  composition: SimpleComposition,
  requestedSize: string,
): Promise<PaddedComposition> {
  const [requestedWidth, requestedHeight] = requestedSize
    .split("x")
    .map((part) => Number(part));
  const targetRatio = (requestedWidth || 1) / Math.max(1, requestedHeight || 1);
  const { sceneWidth, sceneHeight } = composition;
  const ratio = sceneWidth / sceneHeight;
  let paddedWidth = sceneWidth;
  let paddedHeight = sceneHeight;
  if (Math.abs(ratio - targetRatio) / targetRatio > 0.01) {
    if (ratio > targetRatio) {
      paddedHeight = Math.round(sceneWidth / targetRatio);
    } else {
      paddedWidth = Math.round(sceneHeight * targetRatio);
    }
  }
  const offsetX = Math.floor((paddedWidth - sceneWidth) / 2);
  const offsetY = Math.floor((paddedHeight - sceneHeight) / 2);
  const padded = paddedWidth !== sceneWidth || paddedHeight !== sceneHeight;

  const imageWebp = padded
    ? await sharp(composition.imageWebp)
        .extend({
          top: offsetY,
          bottom: paddedHeight - sceneHeight - offsetY,
          left: offsetX,
          right: paddedWidth - sceneWidth - offsetX,
          background: { r: 118, g: 118, b: 118, alpha: 1 },
        })
        .webp({ quality: 94 })
        .toBuffer()
    : composition.imageWebp;

  let maskPng: Buffer;
  if (!padded) {
    maskPng = await sharp(composition.maskRaw, {
      raw: { width: sceneWidth, height: sceneHeight, channels: 4 },
    })
      .png()
      .toBuffer();
  } else {
    const paddedMask = Buffer.alloc(paddedWidth * paddedHeight * 4, 255);
    for (let y = 0; y < sceneHeight; y += 1) {
      composition.maskRaw.copy(
        paddedMask,
        ((y + offsetY) * paddedWidth + offsetX) * 4,
        y * sceneWidth * 4,
        (y + 1) * sceneWidth * 4,
      );
    }
    maskPng = await sharp(paddedMask, {
      raw: { width: paddedWidth, height: paddedHeight, channels: 4 },
    })
      .png()
      .toBuffer();
  }
  return {
    imageWebp,
    maskPng,
    offsetX,
    offsetY,
    paddedWidth,
    paddedHeight,
    padded,
  };
}

/**
 * The hard guarantee: outside the feathered edit mask, every pixel of the
 * final image comes from the composite, never from the model.
 */
export async function pasteBackOutsideMask(
  composition: SimpleComposition,
  padded: PaddedComposition,
  modelOutput: Buffer,
): Promise<Buffer> {
  const { sceneWidth, sceneHeight } = composition;
  const aligned = await sharp(modelOutput)
    .resize(padded.paddedWidth, padded.paddedHeight, { fit: "fill" })
    .extract({
      left: padded.offsetX,
      top: padded.offsetY,
      width: sceneWidth,
      height: sceneHeight,
    })
    .removeAlpha()
    .png()
    .toBuffer();

  const alpha = Buffer.alloc(sceneWidth * sceneHeight);
  for (let i = 0; i < sceneWidth * sceneHeight; i += 1) {
    alpha[i] = composition.maskRaw[i * 4 + 3] === 0 ? 255 : 0;
  }
  const feathered = await sharp(alpha, {
    raw: { width: sceneWidth, height: sceneHeight, channels: 1 },
  })
    .blur(3)
    .png()
    .toBuffer();
  const overlay = await sharp(aligned).joinChannel(feathered).png().toBuffer();

  // Identity re-stamp: the model's rendition of the object (softened by
  // regeneration and resampling) is covered again by the original cutout,
  // eroded ~3 px so the model keeps only the blend ring and the shadow.
  // The object's pixels stay catalog-sharp at full scene resolution.
  const stamps = await Promise.all(
    composition.overlays.map(async (placed) => {
      const alphaPng = await sharp(placed.png)
        .ensureAlpha()
        .extractChannel("alpha")
        .png()
        .toBuffer();
      const corePng = await sharp(alphaPng)
        .blur(2)
        .threshold(200)
        .blur(1)
        .png()
        .toBuffer();
      // The eroded core is multiplied by the original alpha: outside the
      // silhouette the stamp is exactly transparent, so the black RGB that
      // removeAlpha() exposes under transparent pixels can never bleed out.
      // Two passes: sharp applies composite() at the end of its pipeline, so
      // the alpha channel it introduces must be stripped in a fresh pipeline
      // or joinChannel would graft two channels instead of one.
      const multiplied = await sharp(alphaPng)
        .composite([{ input: corePng, blend: "multiply" }])
        .png()
        .toBuffer();
      const stampAlpha = await sharp(multiplied)
        .removeAlpha()
        .toColourspace("b-w")
        .png()
        .toBuffer();
      // removeAlpha and joinChannel cannot share a pipeline: sharp applies
      // them in a fixed internal order that yields a 3-channel image with no
      // alpha at all — an opaque tile that would paint its black corners
      // over the scene.
      const stampRgb = await sharp(placed.png).removeAlpha().png().toBuffer();
      const stamp = await sharp(stampRgb)
        .joinChannel(stampAlpha)
        .png()
        .toBuffer();
      return {
        input: stamp,
        left: placed.left,
        top: placed.top,
        blend: "over" as const,
      };
    }),
  );
  return sharp(composition.imageWebp)
    .composite([{ input: overlay, blend: "over" }, ...stamps])
    .webp({ quality: 94 })
    .toBuffer();
}
