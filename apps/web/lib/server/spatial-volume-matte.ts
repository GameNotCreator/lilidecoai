import "server-only";
import { createHash } from "node:crypto";
import sharp from "sharp";

/** v12 only: the foreground is never fitted to the nominal API mask. */
export const SPATIAL_VOLUME_MATTE_POLICY = Object.freeze({
  version: "spatial-volume-matte-v12" as const,
  model: "rembg-2.0.67-birefnet-general-lite",
  modelSha256:
    "5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333",
  runtime: "onnxruntime-1.30.0",
  maximumPixels: 2048 * 2048,
  maximumDimension: 2048,
  maximumMaskBytes: 8 * 1024 * 1024,
  observationMargin: 0.75,
  baseGeometryAlphaThreshold: 128,
  sigmaXInObjectWidths: 0.015,
  sigmaYInObjectWidths: 0.02,
  minimumSigmaPx: 0.75,
  maximumSigmaDistance: 3,
  maximumDarkness: 0.2,
  contactProfile: "solid-base" as const,
  shadowMethod: "maximum-bottom-contour-gaussian-on-original-support" as const,
});

type Crop = { left: number; top: number; width: number; height: number };
export type SpatialVolumeMatteInput = {
  originalRoom: Buffer;
  generatedRoom: Buffer;
  objectRegion: Buffer;
  contactRegion: Buffer;
  freeSupport: Buffer;
  protectedRegion: Buffer;
  nominalObjectRegion: Buffer;
  contactProfile: "solid-base";
};
export type SpatialVolumeMatteOptions = {
  url: string;
  token: string;
  timeoutMs: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
};

export class SpatialVolumeMatteError extends Error {
  public readonly retryable: boolean;
  constructor(
    public readonly code: string,
    public readonly diagnostics: Record<string, unknown> = {},
  ) {
    super(`Spatial volume matte refused: ${code}`);
    this.name = "SpatialVolumeMatteError";
    this.retryable =
      code === "matting-timeout" ||
      code === "matting-unavailable" ||
      (code === "invalid-service-response" &&
        [408, 429, 500, 502, 503, 504].includes(Number(diagnostics.status)));
  }
}
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const fail = (code: string, diagnostics?: Record<string, unknown>): never => {
  throw new SpatialVolumeMatteError(code, diagnostics);
};
const policy = SPATIAL_VOLUME_MATTE_POLICY;

async function readPng(
  bytes: Buffer,
  channels: 1 | 3,
  grid?: { width: number; height: number },
) {
  const metadata = await sharp(bytes, {
    limitInputPixels: policy.maximumPixels,
  }).metadata();
  const { width, height } = metadata;
  if (
    metadata.format !== "png" ||
    metadata.channels !== channels ||
    metadata.hasAlpha ||
    metadata.depth !== "uchar" ||
    (metadata.pages ?? 1) !== 1 ||
    (metadata.orientation && metadata.orientation !== 1) ||
    !width ||
    !height ||
    width > policy.maximumDimension ||
    height > policy.maximumDimension ||
    width * height > policy.maximumPixels ||
    (grid && (width !== grid.width || height !== grid.height))
  )
    fail("invalid-png-grid");
  const image = sharp(bytes, { limitInputPixels: policy.maximumPixels });
  const data = await (channels === 1 ? image.toColourspace("b-w") : image)
    .raw()
    .toBuffer();
  if (data.length !== width * height * channels) fail("invalid-png-data");
  return { data, width, height };
}

/** Geometry-only observation crop; it must not depend on generated alpha. */
export function spatialVolumeMatteGeometry(input: {
  object: Uint8Array;
  contact: Uint8Array;
  support: Uint8Array;
  protectedRegion: Uint8Array;
  nominal: Uint8Array;
  width: number;
  height: number;
}) {
  const { object, contact, support, protectedRegion, nominal, width, height } =
    input;
  const length = width * height;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > policy.maximumDimension ||
    height > policy.maximumDimension ||
    length > policy.maximumPixels ||
    [object, contact, support, protectedRegion, nominal].some(
      (mask) =>
        mask.length !== length || mask.some((v) => v !== 0 && v !== 255),
    )
  )
    fail("invalid-binary-geometry");
  let left = width,
    top = height,
    right = -1,
    bottom = -1,
    nominalPixels = 0;
  const authorization = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    if (
      (object[i] && contact[i]) ||
      (protectedRegion[i] && (object[i] || contact[i] || support[i])) ||
      (contact[i] && !support[i]) ||
      (nominal[i] && !object[i])
    )
      fail("inconsistent-geometry");
    authorization[i] = object[i] || contact[i] ? 255 : 0;
    if (nominal[i]) nominalPixels++;
    if (object[i]) {
      left = Math.min(left, i % width);
      right = Math.max(right, i % width);
      top = Math.min(top, Math.floor(i / width));
      bottom = Math.max(bottom, Math.floor(i / width));
    }
  }
  if (right < left || !nominalPixels) fail("empty-object-geometry");
  const margin = Math.ceil(
    policy.observationMargin * Math.max(right - left + 1, bottom - top + 1),
  );
  const crop: Crop = {
    left: Math.max(0, left - margin),
    top: Math.max(0, top - margin),
    width: Math.min(width, right + 1 + margin) - Math.max(0, left - margin),
    height: Math.min(height, bottom + 1 + margin) - Math.max(0, top - margin),
  };
  return { authorization, crop };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Admission must call this before starting any paid provider operation. */
export function validateSpatialVolumeMatteOptions(
  options: SpatialVolumeMatteOptions,
): URL {
  if (typeof options.url !== "string" || typeof options.token !== "string")
    fail("invalid-service-configuration");
  let endpoint: URL;
  try {
    endpoint = new URL("/v1/mask", options.url);
  } catch {
    return fail("invalid-service-configuration");
  }
  if (
    (endpoint.protocol !== "https:" &&
      !(
        endpoint.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
      )) ||
    endpoint.username ||
    endpoint.password ||
    // A bearer secret is printable ASCII without whitespace. Validate before a
    // paid image operation, including values Headers/fetch cannot transport.
    !/^[\x21-\x7e]+$/.test(options.token) ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 300_000
  )
    fail("invalid-service-configuration");
  return endpoint;
}

async function requestMask(
  cropPng: Buffer,
  crop: Crop,
  options: SpatialVolumeMatteOptions,
): Promise<{ bytes: Buffer; data: Buffer }> {
  const endpoint = validateSpatialVolumeMatteOptions(options);
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([timeout, options.signal])
    : timeout;
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    response = await abortable(
      (options.fetch ?? fetch)(endpoint, {
        method: "POST",
        headers: {
          "content-type": "image/png",
          authorization: `Bearer ${options.token}`,
        },
        body: new Uint8Array(cropPng),
        signal,
        redirect: "error",
        cache: "no-store",
      }),
      signal,
    );
    if (
      response.status !== 200 ||
      response.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase() !== "image/png" ||
      !response.body
    )
      fail("invalid-service-response", { status: response.status });
    if (
      response.headers.get("x-matting-model") !== policy.model ||
      response.headers.get("x-matting-model-sha256") !== policy.modelSha256 ||
      response.headers.get("x-matting-runtime") !== policy.runtime ||
      response.headers.get("x-matting-input-sha256") !== hash(cropPng)
    )
      fail("unverified-model-provenance");
    const declaredLength = response.headers.get("content-length");
    if (
      declaredLength !== null &&
      (!/^\d+$/.test(declaredLength) ||
        Number(declaredLength) > policy.maximumMaskBytes)
    )
      fail("mask-too-large");
    reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      length += value.byteLength;
      if (length > policy.maximumMaskBytes) fail("mask-too-large");
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    if (response.headers.get("x-matting-mask-sha256") !== hash(bytes))
      fail("invalid-mask-fingerprint");
    return { bytes, data: (await readPng(bytes, 1, crop)).data };
  } catch (error) {
    if (error instanceof SpatialVolumeMatteError) throw error;
    if (signal.aborted)
      fail(options.signal?.aborted ? "cancelled" : "matting-timeout");
    return fail("matting-unavailable");
  } finally {
    if (reader) {
      // Never let a stalled upstream cancellation extend the request deadline.
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    } else if (response?.body) void response.body.cancel().catch(() => {});
  }
}

/** Pure fixed-grid composition, exported for byte-level integrity tests. */
export function composeSpatialVolumeMatte(input: {
  original: Buffer;
  generated: Buffer;
  alphaCrop: Buffer;
  object: Uint8Array;
  contact: Uint8Array;
  support: Uint8Array;
  protectedRegion: Uint8Array;
  nominal: Uint8Array;
  width: number;
  height: number;
  contactProfile: "solid-base";
}) {
  const {
    original,
    generated,
    alphaCrop,
    object,
    support,
    protectedRegion,
    nominal,
    width,
    height,
  } = input;
  if (input.contactProfile !== "solid-base")
    fail("unsupported-contact-profile");
  const { authorization, crop } = spatialVolumeMatteGeometry(input);
  if (
    original.length !== width * height * 3 ||
    generated.length !== original.length ||
    alphaCrop.length !== crop.width * crop.height
  )
    fail("invalid-composition-grid");
  const alpha = Buffer.alloc(width * height);
  const counts = {
    positiveAlphaPixels: 0,
    cropEdgeAlphaPixels: 0,
    imageEdgeAlphaPixels: 0,
    outsideObjectAlphaPixels: 0,
    protectedAlphaPixels: 0,
  };
  const nominalDiagnostics = {
    outsideNominalAlphaPixels: 0,
    nominalBoundaryAlphaPixels: 0,
    policy: "diagnostic-only-final-visual-review-required" as const,
  };
  for (let y = 0; y < crop.height; y++)
    for (let x = 0; x < crop.width; x++) {
      const a = alphaCrop[y * crop.width + x]!,
        fx = x + crop.left,
        fy = y + crop.top,
        i = fy * width + fx;
      alpha[i] = a;
      if (!a) continue;
      counts.positiveAlphaPixels++;
      if (!x || !y || x === crop.width - 1 || y === crop.height - 1)
        counts.cropEdgeAlphaPixels++;
      if (!fx || !fy || fx === width - 1 || fy === height - 1)
        counts.imageEdgeAlphaPixels++;
      if (!object[i]) counts.outsideObjectAlphaPixels++;
      if (protectedRegion[i]) counts.protectedAlphaPixels++;
      if (!nominal[i]) nominalDiagnostics.outsideNominalAlphaPixels++;
      else if (
        !fx ||
        !fy ||
        fx === width - 1 ||
        fy === height - 1 ||
        !nominal[i - 1] ||
        !nominal[i + 1] ||
        !nominal[i - width] ||
        !nominal[i + width]
      )
        nominalDiagnostics.nominalBoundaryAlphaPixels++;
    }
  const reasons = [
    ...(!counts.positiveAlphaPixels ? ["empty-alpha"] : []),
    ...(counts.cropEdgeAlphaPixels ? ["alpha-touches-crop-edge"] : []),
    ...(counts.imageEdgeAlphaPixels ? ["alpha-touches-image-edge"] : []),
    ...(counts.outsideObjectAlphaPixels
      ? ["alpha-outside-object-authorization"]
      : []),
    ...(counts.protectedAlphaPixels ? ["alpha-enters-protection"] : []),
  ];
  if (reasons.length)
    fail(reasons[0]!, {
      reasons,
      counts,
      nominalDiagnostics,
      crop,
      alphaSha256: hash(alpha),
    });
  let left = width,
    right = -1,
    top = height,
    bottom = -1;
  const base: { x: number; y: number }[] = [];
  for (let x = 0; x < width; x++) {
    let low = -1;
    for (let y = 0; y < height; y++)
      if (alpha[y * width + x]! >= policy.baseGeometryAlphaThreshold) {
        low = y;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    if (low >= 0) base.push({ x: x + 0.5, y: low + 0.5 });
  }
  if (!base.length) fail("unstable-alpha-base", { counts, nominalDiagnostics });
  const objectWidth = right - left + 1;
  const sigmaX = Math.max(
    policy.minimumSigmaPx,
    objectWidth * policy.sigmaXInObjectWidths,
  );
  const sigmaY = Math.max(
    policy.minimumSigmaPx,
    objectWidth * policy.sigmaYInObjectWidths,
  );
  const gain = new Float32Array(alpha.length).fill(1);
  for (const point of base) {
    const minX = Math.max(
      0,
      Math.floor(point.x - policy.maximumSigmaDistance * sigmaX),
    );
    const maxX = Math.min(
      width - 1,
      Math.ceil(point.x + policy.maximumSigmaDistance * sigmaX),
    );
    const minY = Math.max(
      0,
      Math.floor(point.y - policy.maximumSigmaDistance * sigmaY),
    );
    const maxY = Math.min(
      height - 1,
      Math.ceil(point.y + policy.maximumSigmaDistance * sigmaY),
    );
    for (let y = minY; y <= maxY; y++)
      for (let x = minX; x <= maxX; x++) {
        const i = y * width + x;
        if (!authorization[i] || !support[i]) continue;
        const distance =
          ((x + 0.5 - point.x) / sigmaX) ** 2 +
          ((y + 0.5 - point.y) / sigmaY) ** 2;
        if (distance > policy.maximumSigmaDistance ** 2) continue;
        gain[i] = Math.min(
          gain[i]!,
          1 - policy.maximumDarkness * Math.exp(-0.5 * distance),
        );
      }
  }
  const candidate = Buffer.alloc(original.length);
  let partiallyTransparentChangedPixels = 0,
    partiallyTransparentMaximumByteDelta = 0,
    backgroundOnlyChangedPixels = 0;
  for (let i = 0; i < alpha.length; i++) {
    const a = alpha[i]!;
    let changed = false;
    for (let c = 0; c < 3; c++) {
      const j = i * 3 + c;
      const background = Math.round(original[j]! * gain[i]!);
      candidate[j] = Math.round(
        (generated[j]! * a + background * (255 - a)) / 255,
      );
      const plain = Math.round(
        (generated[j]! * a + original[j]! * (255 - a)) / 255,
      );
      changed ||= candidate[j] !== plain;
      if (a && a < 255)
        partiallyTransparentMaximumByteDelta = Math.max(
          partiallyTransparentMaximumByteDelta,
          Math.abs(candidate[j]! - plain),
        );
      if (
        (a === 255 && candidate[j] !== generated[j]) ||
        ((!authorization[i] || protectedRegion[i]) &&
          candidate[j] !== original[j]) ||
        (!support[i] && candidate[j] !== plain) ||
        candidate[j]! > plain
      )
        fail("composition-integrity-failed");
    }
    if (changed) {
      if (a) partiallyTransparentChangedPixels++;
      else backgroundOnlyChangedPixels++;
    }
  }
  return {
    candidate,
    alpha,
    gain,
    crop,
    counts,
    nominalDiagnostics,
    ao: {
      baseColumns: base.length,
      bounds: { left, top, right: right + 1, bottom: bottom + 1 },
      sigmaX,
      sigmaY,
    },
    integrity: {
      intrinsicAlphaChangedValues: 0,
      intrinsicForegroundRgbChangedValues: 0,
      opaqueChangedValues: 0,
      outsideAuthorizationChangedValues: 0,
      protectedChangedValues: 0,
      nonSupportShadowChangedValues: 0,
      partiallyTransparentChangedPixels,
      partiallyTransparentMaximumByteDelta,
      backgroundOnlyChangedPixels,
    },
  };
}

/** Private alpha inference is one bounded request; durable orchestration owns retries. */
export async function matteSpatialVolume(
  input: SpatialVolumeMatteInput,
  options: SpatialVolumeMatteOptions,
) {
  if (input.contactProfile !== "solid-base")
    fail("unsupported-contact-profile");
  options.signal?.throwIfAborted();
  const original = await readPng(input.originalRoom, 3);
  const { width, height } = original;
  const [generated, object, contact, support, protectedRegion, nominal] =
    await Promise.all([
      readPng(input.generatedRoom, 3, original),
      readPng(input.objectRegion, 1, original),
      readPng(input.contactRegion, 1, original),
      readPng(input.freeSupport, 1, original),
      readPng(input.protectedRegion, 1, original),
      readPng(input.nominalObjectRegion, 1, original),
    ]);
  const masks = {
    object: object.data,
    contact: contact.data,
    support: support.data,
    protectedRegion: protectedRegion.data,
    nominal: nominal.data,
    width,
    height,
  };
  const { crop } = spatialVolumeMatteGeometry(masks);
  const cropPng = await sharp(input.generatedRoom, {
    limitInputPixels: policy.maximumPixels,
  })
    .extract(crop)
    .png()
    .toBuffer();
  const mask = await requestMask(cropPng, crop, options);
  options.signal?.throwIfAborted();
  const result = composeSpatialVolumeMatte({
    ...masks,
    original: original.data,
    generated: generated.data,
    alphaCrop: mask.data,
    contactProfile: input.contactProfile,
  });
  const [image, alpha] = await Promise.all([
    sharp(result.candidate, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer(),
    sharp(result.alpha, { raw: { width, height, channels: 1 } })
      .toColourspace("b-w")
      .png()
      .toBuffer(),
  ]);
  return {
    image,
    alpha,
    metadata: {
      policy: policy.version,
      model: policy.model,
      modelSha256: policy.modelSha256,
      runtime: policy.runtime,
      grid: { width, height },
      crop,
      counts: result.counts,
      nominalDiagnostics: result.nominalDiagnostics,
      ao: {
        ...result.ao,
        method: policy.shadowMethod,
        maximumDarkness: policy.maximumDarkness,
      },
      integrity: result.integrity,
      fingerprints: {
        originalRoom: hash(input.originalRoom),
        generatedRoom: hash(input.generatedRoom),
        objectRegion: hash(input.objectRegion),
        contactRegion: hash(input.contactRegion),
        freeSupport: hash(input.freeSupport),
        protectedRegion: hash(input.protectedRegion),
        nominalObjectRegion: hash(input.nominalObjectRegion),
        submittedCrop: hash(cropPng),
        returnedMask: hash(mask.bytes),
        alpha: hash(alpha),
        image: hash(image),
      },
      requiresFinalVisualReview: true,
    },
  };
}
