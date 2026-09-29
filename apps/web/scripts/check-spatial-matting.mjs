import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";

export const PINNED_SPATIAL_MATTING = Object.freeze({
  model: "birefnet-general-lite",
  responseModel: "rembg-2.0.67-birefnet-general-lite",
  modelSha256:
    "5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333",
  runtime: "onnxruntime-1.30.0",
});
const MAX_BYTES = 8 * 1024 * 1024;
const sha = (data) => createHash("sha256").update(data).digest("hex");
class SmokeError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const refuse = (code) => {
  throw new SmokeError(code);
};

function bounded(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolvePromise, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolvePromise, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

async function readBody(response, maximum, signal) {
  if (!response.body) refuse("missing-response-body");
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > maximum)
  ) {
    void response.body.cancel().catch(() => {});
    refuse("response-too-large");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await bounded(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > maximum) refuse("response-too-large");
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** No image-generation API is called. This probes the private CPU mask service. */
export async function checkSpatialMatting({
  url,
  token,
  timeoutMs = 60_000,
  fetcher = fetch,
}) {
  let origin;
  try {
    origin = new URL(url);
  } catch {
    refuse("invalid-service-url");
  }
  if (
    (origin.protocol !== "https:" &&
      !(
        origin.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
      )) ||
    origin.username ||
    origin.password
  )
    refuse("invalid-service-url");
  if (typeof token !== "string" || !token.trim() || /[\r\n]/.test(token))
    refuse("invalid-service-token");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    refuse("invalid-timeout");
  const signal = AbortSignal.timeout(timeoutMs);
  let activeResponse;
  const call = async (pathname, options = {}) => {
    activeResponse = await bounded(
      fetcher(new URL(pathname, origin), {
        ...options,
        signal,
        redirect: "error",
        cache: "no-store",
      }),
      signal,
    );
    return activeResponse;
  };
  try {
    const health = await call("/health");
    if (
      health.status !== 200 ||
      health.headers.get("content-type")?.split(";")[0] !== "application/json"
    )
      refuse("health-unavailable");
    const info = JSON.parse(
      (await readBody(health, 16 * 1024, signal)).toString("utf8"),
    );
    if (
      info.ready !== true ||
      info.model !== PINNED_SPATIAL_MATTING.model ||
      info.modelSha256 !== PINNED_SPATIAL_MATTING.modelSha256 ||
      info.runtime !== PINNED_SPATIAL_MATTING.runtime
    )
      refuse("health-identity-mismatch");
    if (info.busy !== false) refuse("service-busy");
    const side = 256,
      rgb = Buffer.alloc(side * side * 3);
    for (let y = 0; y < side; y++)
      for (let x = 0; x < side; x++) {
        const inside = x >= 72 && x < 184 && y >= 52 && y < 220;
        const pixel = inside ? [143, 66, 24] : [217, 222, 227];
        for (let c = 0; c < 3; c++) rgb[(y * side + x) * 3 + c] = pixel[c];
      }
    const source = await sharp(rgb, {
      raw: { width: side, height: side, channels: 3 },
    })
      .png()
      .toBuffer();
    const result = await call("/v1/mask", {
      method: "POST",
      headers: {
        "content-type": "image/png",
        authorization: `Bearer ${token}`,
      },
      body: new Uint8Array(source),
    });
    if (
      result.status !== 200 ||
      result.headers.get("content-type")?.split(";")[0] !== "image/png"
    )
      refuse("mask-request-failed");
    if (
      result.headers.get("x-matting-model") !==
        PINNED_SPATIAL_MATTING.responseModel ||
      result.headers.get("x-matting-model-sha256") !==
        PINNED_SPATIAL_MATTING.modelSha256 ||
      result.headers.get("x-matting-runtime") !== PINNED_SPATIAL_MATTING.runtime
    )
      refuse("mask-identity-mismatch");
    if (result.headers.get("x-matting-input-sha256") !== sha(source))
      refuse("input-fingerprint-mismatch");
    const mask = await readBody(result, MAX_BYTES, signal);
    if (result.headers.get("x-matting-mask-sha256") !== sha(mask))
      refuse("mask-fingerprint-mismatch");
    const metadata = await sharp(mask, {
      limitInputPixels: side * side,
    }).metadata();
    if (
      metadata.format !== "png" ||
      metadata.width !== side ||
      metadata.height !== side ||
      metadata.channels !== 1 ||
      metadata.depth !== "uchar" ||
      metadata.hasAlpha ||
      (metadata.pages ?? 1) !== 1 ||
      (metadata.orientation && metadata.orientation !== 1)
    )
      refuse("mask-grid-or-format-mismatch");
    return {
      version: "spatial-matting-smoke-v1",
      status: "passed",
      checkedAt: new Date().toISOString(),
      identity: PINNED_SPATIAL_MATTING,
      grid: { width: side, height: side },
      fixtureSha256: sha(source),
      maskSha256: sha(mask),
      maskBytes: mask.length,
      paidProviderCalls: 0,
      wholeEngineExecution: false,
      spatialQualityQualified: false,
    };
  } catch (error) {
    if (error instanceof SmokeError) throw error;
    refuse(signal.aborted ? "service-timeout" : "service-contract-failed");
  } finally {
    if (activeResponse?.body && !activeResponse.body.locked)
      void activeResponse.body.cancel().catch(() => {});
  }
}

async function main() {
  let url = process.env.MATTING_URL,
    output;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--url=")) url = arg.slice(6);
    else if (arg.startsWith("--output=")) output = arg.slice(9);
    else refuse("unsupported-argument");
  }
  let report;
  try {
    report = await checkSpatialMatting({
      url,
      token: process.env.MATTING_TOKEN,
      timeoutMs: Number(process.env.MATTING_TIMEOUT_MS ?? 60_000),
    });
  } catch (error) {
    report = {
      version: "spatial-matting-smoke-v1",
      status: "failed",
      code:
        error instanceof SmokeError ? error.code : "service-contract-failed",
      paidProviderCalls: 0,
      spatialQualityQualified: false,
    };
    process.exitCode = 1;
  }
  if (output) {
    const filename = resolve(output);
    await mkdir(dirname(filename), { recursive: true });
    await writeFile(filename, `${JSON.stringify(report, null, 2)}\n`, {
      flag: "wx",
    });
  }
  console.log(JSON.stringify(report));
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch(() => {
    console.error(
      "Spatial matting smoke could not complete; details suppressed to protect credentials.",
    );
    process.exitCode = 1;
  });
}
