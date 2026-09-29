import "server-only";

import sharp from "sharp";
import { CUTOUT_VERSION, prepareCutout, type CutoutResult } from "./assets";
import { serverConfig } from "./config";
import { fillMirrorInterior, hasSeparatedSubjects } from "./mask-topology";

const MAX_MASK_BYTES = 8 * 1024 * 1024;
const MAX_DIMENSION = 2048;

export class MattingUnavailableError extends Error {
  constructor() {
    super(
      "Le détourage avancé est momentanément indisponible. Votre photo n’est pas en cause : réessayez dans quelques instants.",
    );
  }
}

/** The service returns coverage only, never replacement RGB pixels. */
export async function applyProductMask(
  source: Buffer,
  mask: Buffer,
): Promise<Buffer> {
  const original = await sharp(source, { limitInputPixels: MAX_DIMENSION ** 2 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const info = await sharp(mask, {
    limitInputPixels: MAX_DIMENSION ** 2,
  }).metadata();
  if (
    info.format !== "png" ||
    info.width !== original.info.width ||
    info.height !== original.info.height ||
    info.hasAlpha
  ) {
    throw new Error("Invalid matting mask geometry or format");
  }
  const alpha = await sharp(mask).greyscale().raw().toBuffer();
  for (let i = 0; i < alpha.length; i += 1) {
    original.data[i * 4 + 3] = Math.round(
      (original.data[i * 4 + 3]! * alpha[i]!) / 255,
    );
  }
  return sharp(original.data, { raw: original.info }).png().toBuffer();
}

async function readMask(response: Response): Promise<Buffer> {
  if (
    !response.ok ||
    response.headers.get("content-type")?.split(";")[0] !== "image/png" ||
    !response.body
  ) {
    await response.body?.cancel();
    throw new Error("Matting service did not return a mask");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_MASK_BYTES) throw new Error("Mask too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export interface ProductCutout extends CutoutResult {
  source: "heuristic" | "matting";
  version: string;
}

export async function prepareProductCutout(
  buffer: Buffer,
  options: { objectType?: string } = {},
): Promise<ProductCutout> {
  const local = await prepareCutout(buffer);
  if (!local.needsModelIsolation || !serverConfig.mattingUrl) {
    local.quality.multipleSubjects = await hasSeparatedSubjects(local.buffer);
    return {
      ...local,
      source: "heuristic",
      version: `${CUTOUT_VERSION}/topology-v1`,
    };
  }
  try {
    // One normalized grid is sent and checked: no aspect-ratio guessing or
    // stretching a generative output onto a different source photograph.
    const normalized = await sharp(buffer)
      .rotate()
      .resize({
        width: MAX_DIMENSION,
        height: MAX_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();
    const response = await fetch(new URL("/v1/mask", serverConfig.mattingUrl), {
      method: "POST",
      headers: {
        "content-type": "image/png",
        authorization: `Bearer ${serverConfig.mattingToken ?? ""}`,
      },
      body: new Uint8Array(normalized),
      signal: AbortSignal.timeout(serverConfig.mattingTimeoutMs),
      redirect: "error",
      cache: "no-store",
    });
    const model = response.headers.get("x-matting-model");
    if (!model || !/^[a-z0-9._-]{1,80}$/.test(model)) {
      await response.body?.cancel();
      throw new Error("Missing matting model version");
    }
    const mask = await readMask(response);
    const matte = await applyProductMask(
      normalized,
      options.objectType === "mirror" ? await fillMirrorInterior(mask) : mask,
    );
    const result = await prepareCutout(matte);
    result.quality.multipleSubjects = await hasSeparatedSubjects(result.buffer);
    return {
      ...result,
      source: "matting",
      version: `${CUTOUT_VERSION}/mask-v2/${model}${options.objectType === "mirror" ? "/solid-mirror-v2" : ""}`,
    };
  } catch {
    // Do not misdiagnose a timeout as an unsuitable customer photograph.
    // Do not silently accept the failed heuristic or retry expensive work.
    throw new MattingUnavailableError();
  }
}
