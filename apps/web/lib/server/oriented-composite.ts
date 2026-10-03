import "server-only";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { insidePolygon, isFreeSupport } from "../spatial-scene";
import {
  OrientedPlacementError,
  type OrientedPlacementPlan,
} from "./oriented-selection";
import { ORIENTED_LAYER_POLICY } from "./oriented-layer-policy";

export { ORIENTED_LAYER_POLICY } from "./oriented-layer-policy";

export type RenderLayerSet = {
  version: typeof ORIENTED_LAYER_POLICY.version;
  width: number;
  height: number;
  planFingerprint: string;
  viewId: string;
  viewRevision: number;
  imageSha256: string;
  alphaSha256: string;
  backgroundRgb: Buffer;
  productRgb: Buffer;
  productAlpha: Uint8Array;
  contactShadow: Uint8Array;
  foregroundProtection: Uint8Array;
  permittedMask: Uint8Array;
  previewPng: Buffer;
  evidence: {
    productPixels: number;
    productShortSidePx: number;
    contactDistancePx: number;
    contactDistanceRatio: number;
    ratioPreserved: true;
    metricVerified: false;
  };
};

const hash = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));
const luma = (data: Uint8Array, i: number) =>
  data[3 * i]! * 0.2126 + data[3 * i + 1]! * 0.7152 + data[3 * i + 2]! * 0.0722;

async function decodeRgb(image: Buffer, width: number, height: number) {
  const result = await sharp(image, {
    limitInputPixels: ORIENTED_LAYER_POLICY.maxPixels,
  })
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (
    result.info.width !== width ||
    result.info.height !== height ||
    result.info.channels !== 3
  )
    throw new OrientedPlacementError(
      "invalid_pose",
      "Le cadrage de l’image ne correspond pas au plan figé.",
    );
  return result.data;
}

/** Provider output may use another resolution. Scale the entire frame uniformly,
 * accepting only the same ratio up to integer rounding at the scene resolution.
 * Never crop, pad or stretch a changed frame to fit. The original provider bytes
 * remain the evidence reviewed before this photometric-only normalization. */
async function decodeProviderRgb(image: Buffer, width: number, height: number) {
  const decoder = sharp(image, {
    limitInputPixels: ORIENTED_LAYER_POLICY.maxProviderPixels,
  });
  const metadata = await decoder.metadata();
  if (
    !metadata.width ||
    !metadata.height ||
    Math.round((metadata.height * width) / metadata.width) !== height
  )
    throw new OrientedPlacementError(
      "invalid_pose",
      "Le cadrage de l’image ne correspond pas au plan figé.",
    );
  const result = await decoder
    .resize({ width })
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (
    result.info.width !== width ||
    result.info.height !== height ||
    result.info.channels !== 3
  )
    throw new OrientedPlacementError(
      "invalid_pose",
      "Le cadrage de l’image ne correspond pas au plan figé.",
    );
  return result.data;
}

/** Bilinear sampling in premultiplied space avoids a dark fringe from RGB in
 * transparent pixels. Both axes share the exact plan scale, without a resize box. */
function sampleProduct(
  rgb: Buffer,
  alpha: Buffer,
  width: number,
  height: number,
  x: number,
  y: number,
) {
  const left = Math.floor(x),
    top = Math.floor(y);
  const sample = [0, 0, 0, 0];
  for (let dy = 0; dy < 2; dy++)
    for (let dx = 0; dx < 2; dx++) {
      const sx = left + dx,
        sy = top + dy;
      if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
      const weight =
        (dx ? x - left : 1 - x + left) * (dy ? y - top : 1 - y + top);
      const i = sy * width + sx,
        opacity = alpha[i]! * weight;
      sample[3]! += opacity;
      for (let c = 0; c < 3; c++) sample[c]! += rgb[3 * i + c]! * opacity;
    }
  if (sample[3]! > 0) for (let c = 0; c < 3; c++) sample[c]! /= sample[3]!;
  return sample;
}

function composePixels(
  layers: Pick<
    RenderLayerSet,
    | "backgroundRgb"
    | "productRgb"
    | "productAlpha"
    | "contactShadow"
    | "foregroundProtection"
  >,
  exposure = 1,
  shadowGain?: Float32Array,
) {
  const output = Buffer.from(layers.backgroundRgb);
  for (let i = 0; i < layers.productAlpha.length; i++) {
    if (layers.foregroundProtection[i]) continue;
    const alpha = layers.productAlpha[i]! / 255;
    const darkening = shadowGain
      ? shadowGain[i]!
      : layers.contactShadow[i]! / 255;
    if (!alpha && !darkening) continue;
    for (let c = 0; c < 3; c++)
      output[3 * i + c] = Math.round(
        clamp(layers.productRgb[3 * i + c]! * exposure, 0, 255) * alpha +
          layers.backgroundRgb[3 * i + c]! * (1 - darkening) * (1 - alpha),
      );
  }
  return output;
}

export async function composeOrientedView(input: {
  /** Already EXIF-normalized scene; the planner uses these exact dimensions. */
  scene: Buffer;
  viewImage: Buffer;
  viewAlpha: Buffer;
  plan: OrientedPlacementPlan;
}): Promise<RenderLayerSet> {
  const { plan } = input,
    { width, height } = plan,
    length = width * height;
  const view = plan.view,
    image = view.image,
    alphaAsset = view.alpha;
  if (
    !image ||
    !alphaAsset ||
    length > ORIENTED_LAYER_POLICY.maxPixels ||
    !Number.isSafeInteger(length) ||
    length < 1
  )
    throw new OrientedPlacementError(
      "invalid_view",
      "Dimensions de composition invalides.",
    );
  if (
    hash(input.viewImage) !== image.sha256 ||
    hash(input.viewAlpha) !== alphaAsset.sha256
  )
    throw new OrientedPlacementError(
      "invalid_view",
      "Les actifs de la vue ne correspondent plus au snapshot admis.",
    );
  const backgroundRgb = await decodeRgb(input.scene, width, height);
  const sourceRgb = await decodeRgb(
    input.viewImage,
    image.widthPx,
    image.heightPx,
  );
  // The alpha asset is a grayscale opacity image. Its own PNG alpha is not the mask.
  const alphaResult = await sharp(input.viewAlpha, {
    limitInputPixels: ORIENTED_LAYER_POLICY.maxPixels,
  })
    .removeAlpha()
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (
    alphaResult.info.width !== image.widthPx ||
    alphaResult.info.height !== image.heightPx
  )
    throw new OrientedPlacementError(
      "invalid_view",
      "Le masque préparé n’est pas aligné avec la vue.",
    );
  const sourceAlpha = alphaResult.data,
    sourceBounds = view.visibleBounds!;
  let sourcePixels = 0;
  for (let sy = 0; sy < image.heightPx; sy++)
    for (let sx = 0; sx < image.widthPx; sx++) {
      if (!sourceAlpha[sy * image.widthPx + sx]) continue;
      sourcePixels++;
      if (
        sx < sourceBounds.x * image.widthPx - 1 ||
        sx > (sourceBounds.x + sourceBounds.width) * image.widthPx + 1 ||
        sy < sourceBounds.y * image.heightPx - 1 ||
        sy > (sourceBounds.y + sourceBounds.height) * image.heightPx + 1
      )
        throw new OrientedPlacementError(
          "invalid_view",
          "Le masque déborde les limites approuvées de la vue.",
        );
    }
  if (!sourcePixels)
    throw new OrientedPlacementError(
      "invalid_view",
      "Le masque de la vue est vide.",
    );
  const productRgb = Buffer.alloc(length * 3),
    productAlpha = new Uint8Array(length),
    contactShadow = new Uint8Array(length),
    foregroundProtection = new Uint8Array(length),
    permittedMask = new Uint8Array(length);
  const bounds = plan.visibleBounds,
    transform = plan.transform;
  const angle = (transform.rotationDegrees * Math.PI) / 180,
    cos = Math.cos(angle),
    sin = Math.sin(angle);
  const obstacles = [
    ...plan.spatial.surface.holes,
    ...plan.spatial.surface.obstacles,
  ];
  let productPixels = 0,
    contactDistancePx = Infinity;
  for (
    let y = Math.max(0, Math.floor(bounds.y) - 1);
    y < Math.min(height, Math.ceil(bounds.y + bounds.height) + 1);
    y++
  )
    for (
      let x = Math.max(0, Math.floor(bounds.x) - 1);
      x < Math.min(width, Math.ceil(bounds.x + bounds.width) + 1);
      x++
    ) {
      const dx = (x + 0.5 - transform.translateX) / transform.scale,
        dy = (y + 0.5 - transform.translateY) / transform.scale;
      const sample = sampleProduct(
        sourceRgb,
        sourceAlpha,
        image.widthPx,
        image.heightPx,
        cos * dx + sin * dy - 0.5,
        -sin * dx + cos * dy - 0.5,
      );
      const i = y * width + x,
        a = Math.round(sample[3]!);
      if (!a) continue;
      const point = { x: (x + 0.5) / width, y: (y + 0.5) / height };
      if (obstacles.some((polygon) => insidePolygon(point, polygon)))
        throw new OrientedPlacementError(
          "support_unavailable",
          "La silhouette rencontre un trou ou un obstacle. Les occultations ne sont pas admises dans ce pilote.",
        );
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1)
        throw new OrientedPlacementError(
          "invalid_pose",
          "La silhouette est coupée par le cadre.",
        );
      productAlpha[i] = a;
      permittedMask[i] = 255;
      for (let c = 0; c < 3; c++)
        productRgb[3 * i + c] = Math.round(sample[c]!);
      productPixels++;
      if (a >= 128)
        contactDistancePx = Math.min(
          contactDistancePx,
          Math.hypot(x + 0.5 - plan.anchor.x, y + 0.5 - plan.anchor.y),
        );
    }
  if (!productPixels)
    throw new OrientedPlacementError(
      "invalid_pose",
      "Le produit projeté n’est pas visible.",
    );
  // A compact smooth ellipse at the frozen contact point. No cast shadow is
  // invented without a qualified lighting analysis.
  const footprint = plan.spatial.projection.footprint;
  const rx = Math.max(
    2,
    (Math.max(...footprint.map((p) => p.x)) -
      Math.min(...footprint.map((p) => p.x))) *
      0.48,
  );
  const ry = Math.max(
    1.5,
    Math.min(rx * 0.22, plan.projectedPhysicalHeightPx * 0.035),
  );
  for (
    let y = Math.max(0, Math.floor(plan.anchor.y - ry));
    y < Math.min(height, Math.ceil(plan.anchor.y + ry));
    y++
  )
    for (
      let x = Math.max(0, Math.floor(plan.anchor.x - rx));
      x < Math.min(width, Math.ceil(plan.anchor.x + rx));
      x++
    ) {
      const point = { x: (x + 0.5) / width, y: (y + 0.5) / height },
        i = y * width + x;
      // A support boundary limits its shadow, not the object rising above it.
      // Only actual foreground protections may hide product pixels.
      if (!isFreeSupport(point, plan.spatial.surface)) continue;
      const radius =
        ((x + 0.5 - plan.anchor.x) / rx) ** 2 +
        ((y + 0.5 - plan.anchor.y) / ry) ** 2;
      if (radius >= 1) continue;
      contactShadow[i] = Math.round(
        255 * ORIENTED_LAYER_POLICY.contactDarkening * (1 - radius) ** 2,
      );
      if (contactShadow[i]) permittedMask[i] = 255;
    }
  const layers = {
    version: ORIENTED_LAYER_POLICY.version,
    width,
    height,
    planFingerprint: plan.planFingerprint,
    viewId: view.id,
    viewRevision: view.revision,
    imageSha256: image.sha256,
    alphaSha256: alphaAsset.sha256,
    backgroundRgb,
    productRgb,
    productAlpha,
    contactShadow,
    foregroundProtection,
    permittedMask,
    evidence: {
      productPixels,
      productShortSidePx: Math.min(bounds.width, bounds.height),
      contactDistancePx,
      contactDistanceRatio: contactDistancePx / plan.projectedPhysicalHeightPx,
      ratioPreserved: true as const,
      metricVerified: false as const,
    },
  };
  const previewPng = await sharp(composePixels(layers), {
    raw: { width, height, channels: 3 },
  })
    .png()
    .toBuffer();
  return { ...layers, previewPng };
}

export type OrientedRestorationReport = {
  version: "oriented-restoration-v1";
  viewId: string;
  imageSha256: string;
  alphaSha256: string;
  productExposure: number;
  shadowMethod: "local" | "provider_luminance";
  maxShadowDarkening: number;
  backgroundChangedPixels: number;
  protectedChangedPixels: number;
  outputSha256: string;
  outputEncoding: "png";
};

export async function harmonizeOrientedLayers(input: {
  layers: RenderLayerSet;
  generated: Buffer;
  shadowMethod?: "local" | "provider_luminance";
}): Promise<{ png: Buffer; report: OrientedRestorationReport }> {
  const { layers } = input,
    { width, height } = layers;
  const generated = await decodeProviderRgb(input.generated, width, height);
  // One robust scalar is the slowest possible light field: it cannot import
  // invented motifs or contours from the generated image.
  const ratios: number[] = [];
  for (let i = 0; i < layers.productAlpha.length; i++)
    if (layers.productAlpha[i]! >= 250 && luma(layers.productRgb, i) >= 24)
      ratios.push(luma(generated, i) / luma(layers.productRgb, i));
  ratios.sort((a, b) => a - b);
  const productExposure = clamp(
    ratios[Math.floor(ratios.length / 2)] ?? 1,
    ORIENTED_LAYER_POLICY.minProductExposure,
    ORIENTED_LAYER_POLICY.maxProductExposure,
  );
  const shadowMethod = input.shadowMethod ?? "local";
  // Low frequencies only: provider marble/grain must never become a new
  // texture through the shadow gain, even inside the authorized contact patch.
  const blurRadius = Math.max(
    0.3,
    Math.min(24, layers.evidence.productShortSidePx * 0.08),
  );
  const blurredGenerated =
    shadowMethod === "provider_luminance"
      ? await sharp(generated, { raw: { width, height, channels: 3 } })
          .blur(blurRadius)
          .raw()
          .toBuffer()
      : generated;
  const blurredBackground =
    shadowMethod === "provider_luminance"
      ? await sharp(layers.backgroundRgb, {
          raw: { width, height, channels: 3 },
        })
          .blur(blurRadius)
          .raw()
          .toBuffer()
      : layers.backgroundRgb;
  const shadowGain = new Float32Array(width * height);
  let maxShadowDarkening = 0;
  for (let i = 0; i < shadowGain.length; i++) {
    const mask = layers.contactShadow[i]! / 255;
    if (!mask || layers.foregroundProtection[i]) continue;
    let darkness = mask;
    if (shadowMethod === "provider_luminance") {
      const before = luma(blurredBackground, i);
      const observed =
        before >= 24
          ? clamp(
              1 - luma(blurredGenerated, i) / before,
              0,
              ORIENTED_LAYER_POLICY.maxShadowDarkening,
            )
          : 0;
      darkness = (observed * mask) / ORIENTED_LAYER_POLICY.contactDarkening;
    }
    shadowGain[i] = Math.min(
      ORIENTED_LAYER_POLICY.maxShadowDarkening,
      darkness,
    );
    maxShadowDarkening = Math.max(maxShadowDarkening, shadowGain[i]!);
  }
  const output = composePixels(layers, productExposure, shadowGain);
  let backgroundChangedPixels = 0,
    protectedChangedPixels = 0;
  for (let i = 0; i < width * height; i++) {
    const changed = [0, 1, 2].some(
      (c) => output[3 * i + c] !== layers.backgroundRgb[3 * i + c],
    );
    if (changed && !layers.permittedMask[i]) backgroundChangedPixels++;
    if (changed && layers.foregroundProtection[i]) protectedChangedPixels++;
  }
  const png = await sharp(output, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
  return {
    png,
    report: {
      version: "oriented-restoration-v1",
      viewId: layers.viewId,
      imageSha256: layers.imageSha256,
      alphaSha256: layers.alphaSha256,
      productExposure,
      shadowMethod,
      maxShadowDarkening,
      backgroundChangedPixels,
      protectedChangedPixels,
      outputSha256: hash(png),
      outputEncoding: "png",
    },
  };
}
