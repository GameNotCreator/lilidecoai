import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";

vi.mock("server-only", () => ({}));
import {
  composeSpatialVolumeMatte,
  matteSpatialVolume,
  SPATIAL_VOLUME_MATTE_POLICY as policy,
  spatialVolumeMatteGeometry,
  SpatialVolumeMatteError,
  validateSpatialVolumeMatteOptions,
} from "../lib/server/spatial-volume-matte";

const width = 64,
  height = 64;
const hash = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
const png = (data: Buffer, w: number, h: number, channels: 1 | 3) => {
  const image = sharp(data, { raw: { width: w, height: h, channels } });
  return (channels === 1 ? image.toColourspace("b-w") : image).png().toBuffer();
};
function fixture() {
  const object = Buffer.alloc(width * height),
    contact = Buffer.alloc(width * height),
    support = Buffer.alloc(width * height),
    protectedRegion = Buffer.alloc(width * height),
    nominal = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (x >= 20 && x < 44 && y >= 18 && y < 44) object[i] = 255;
      if (x >= 18 && x < 46 && y >= 44 && y < 50) contact[i] = 255;
      if (y >= 36) support[i] = 255;
      if (x >= 24 && x < 40 && y >= 22 && y < 42) nominal[i] = 255;
    }
  const masks = {
    object,
    contact,
    support,
    protectedRegion,
    nominal,
    width,
    height,
  };
  const { crop } = spatialVolumeMatteGeometry(masks);
  const alphaCrop = Buffer.alloc(crop.width * crop.height);
  for (let y = 23; y < 43; y++)
    for (let x = 23; x < 41; x++)
      alphaCrop[(y - crop.top) * crop.width + x - crop.left] =
        x === 23 ? 64 : 255;
  return {
    ...masks,
    alphaCrop,
    original: Buffer.alloc(width * height * 3, 200),
    generated: Buffer.alloc(width * height * 3, 90),
    contactProfile: "solid-base" as const,
    crop,
  };
}
async function encoded(input = fixture()) {
  const [
    originalRoom,
    generatedRoom,
    objectRegion,
    contactRegion,
    freeSupport,
    protectedRegion,
    nominalObjectRegion,
  ] = await Promise.all([
    png(input.original, width, height, 3),
    png(input.generated, width, height, 3),
    png(input.object, width, height, 1),
    png(input.contact, width, height, 1),
    png(input.support, width, height, 1),
    png(input.protectedRegion, width, height, 1),
    png(input.nominal, width, height, 1),
  ]);
  return {
    originalRoom,
    generatedRoom,
    objectRegion,
    contactRegion,
    freeSupport,
    protectedRegion,
    nominalObjectRegion,
    contactProfile: "solid-base" as const,
  };
}
function server(
  mask: Buffer,
  overrideHeaders: Record<string, string> = {},
  status = 200,
) {
  return vi.fn<typeof fetch>(
    async (_url, options) =>
      new Response(new Uint8Array(mask), {
        status,
        headers: {
          "content-type": "image/png",
          "x-matting-model": policy.model,
          "x-matting-model-sha256": policy.modelSha256,
          "x-matting-runtime": policy.runtime,
          "x-matting-input-sha256": hash(
            new Uint8Array(options!.body as Uint8Array),
          ),
          "x-matting-mask-sha256": hash(mask),
          ...overrideHeaders,
        },
      }),
  );
}
const options = {
  url: "http://127.0.0.1:7011",
  token: "test",
  timeoutMs: 1000,
};

describe("spatial v12 strict matte and fixed procedural AO", () => {
  it.each([
    { url: "ftp://127.0.0.1" },
    { url: "not a URL" },
    { url: "http://example.com" },
    { url: "https://user:password@example.com" },
    { token: "\r\ninvalid" },
    { token: " " },
    { token: "nul\0secret" },
    { token: "tab\tsecret" },
    { token: "del\x7fsecret" },
    { token: "latin1-\u00e9" },
    { token: "unicode-\u20ac" },
    { timeoutMs: 0 },
    { timeoutMs: 300001 },
  ])(
    "validates admission options before any image processing: %j",
    (invalid) => {
      expect(() =>
        validateSpatialVolumeMatteOptions({ ...options, ...invalid }),
      ).toThrow(SpatialVolumeMatteError);
    },
  );

  it("accepts the existing full 2048-square normalized image grid", () => {
    const side = 2048,
      object = Buffer.alloc(side ** 2),
      nominal = Buffer.alloc(side ** 2),
      zero = Buffer.alloc(side ** 2);
    object[1024 * side + 1024] = nominal[1024 * side + 1024] = 255;
    expect(
      spatialVolumeMatteGeometry({
        object,
        nominal,
        contact: zero,
        support: zero,
        protectedRegion: zero,
        width: side,
        height: side,
      }).crop,
    ).toEqual({ left: 1023, top: 1023, width: 3, height: 3 });
  });

  it("preserves generated opaque pixels, fractional alpha and original pixels outside geometry", () => {
    const f = fixture(),
      copy = structuredClone(f);
    const result = composeSpatialVolumeMatte(f);
    expect(result.counts.outsideObjectAlphaPixels).toBe(0);
    expect(result.nominalDiagnostics.outsideNominalAlphaPixels).toBeGreaterThan(
      0,
    );
    expect(
      result.nominalDiagnostics.nominalBoundaryAlphaPixels,
    ).toBeGreaterThan(0);
    expect(result.alpha[30 * width + 23]).toBe(64);
    expect(
      result.candidate.subarray(
        (30 * width + 30) * 3,
        (30 * width + 30) * 3 + 3,
      ),
    ).toEqual(Buffer.from([90, 90, 90]));
    expect(result.candidate.subarray(0, 3)).toEqual(
      Buffer.from([200, 200, 200]),
    );
    expect(result.integrity.backgroundOnlyChangedPixels).toBeGreaterThan(0);
    expect(result.integrity.partiallyTransparentChangedPixels).toBeGreaterThan(
      0,
    );
    expect(result.integrity.opaqueChangedValues).toBe(0);
    expect(Array.from(f.alphaCrop)).toEqual(Array.from(copy.alphaCrop));
    expect(Array.from(f.original)).toEqual(Array.from(copy.original));
    expect(Array.from(f.generated)).toEqual(Array.from(copy.generated));
  });

  it("AO uses max Gaussian coverage, never generated RGB or summed density", () => {
    const f = fixture();
    const first = composeSpatialVolumeMatte(f),
      second = composeSpatialVolumeMatte({
        ...f,
        generated: Buffer.alloc(f.generated.length, 255),
      });
    expect(first.gain).toEqual(second.gain);
    expect(Math.min(...first.gain)).toBeCloseTo(0.8, 6);
    for (let i = 0; i < first.gain.length; i++)
      if (!f.support[i]) expect(first.gain[i]).toBe(1);
  });

  it.each(["outside", "crop-edge", "image-edge", "empty", "unstable"])(
    "refuses %s alpha instead of clipping it",
    (kind) => {
      const f = fixture();
      if (kind === "empty" || kind === "unstable")
        f.alphaCrop.fill(kind === "empty" ? 0 : 1);
      if (kind === "unstable") {
        f.alphaCrop.fill(0);
        f.alphaCrop[(30 - f.crop.top) * f.crop.width + 30 - f.crop.left] = 127;
      }
      if (kind === "outside")
        f.alphaCrop[(30 - f.crop.top) * f.crop.width + 18 - f.crop.left] = 1;
      if (kind === "crop-edge" || kind === "image-edge") f.alphaCrop[0] = 1;
      expect(() => composeSpatialVolumeMatte(f)).toThrow(
        SpatialVolumeMatteError,
      );
    },
  );

  it("refuses protected regions, contact overlap and nonbinary geometry before inference", async () => {
    for (const kind of ["protected", "overlap", "nonbinary"]) {
      const f = fixture();
      if (kind === "protected") f.protectedRegion[30 * width + 30] = 255;
      if (kind === "overlap") f.contact[30 * width + 30] = 255;
      if (kind === "nonbinary") f.object[30 * width + 30] = 254;
      const fetcher = vi.fn<typeof fetch>();
      await expect(
        matteSpatialVolume(await encoded(f), { ...options, fetch: fetcher }),
      ).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
    }
  });

  it("encodes a lossless fixed-grid candidate with pinned HTTP proof and one request", async () => {
    const f = fixture(),
      mask = await png(f.alphaCrop, f.crop.width, f.crop.height, 1),
      fetcher = server(mask);
    const result = await matteSpatialVolume(await encoded(f), {
      ...options,
      fetch: fetcher,
    });
    const pure = composeSpatialVolumeMatte(f);
    expect(await sharp(result.image).raw().toBuffer()).toEqual(pure.candidate);
    expect(
      await sharp(result.alpha).toColourspace("b-w").raw().toBuffer(),
    ).toEqual(pure.alpha);
    expect(result.metadata.modelSha256).toBe(policy.modelSha256);
    expect(result.metadata.requiresFinalVisualReview).toBe(true);
    expect(result.metadata.fingerprints.image).toBe(hash(result.image));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      "http://127.0.0.1:7011/v1/mask",
    );
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      redirect: "error",
      cache: "no-store",
      method: "POST",
    });
  });

  it.each([
    ["x-matting-model", "other"],
    ["x-matting-model-sha256", "0".repeat(64)],
    ["x-matting-runtime", "onnxruntime-other"],
    ["x-matting-input-sha256", "0".repeat(64)],
    ["x-matting-mask-sha256", "0".repeat(64)],
    ["content-type", "image/jpeg"],
    ["content-length", String(policy.maximumMaskBytes + 1)],
  ])("rejects incorrect response %s", async (header, value) => {
    const f = fixture(),
      mask = await png(f.alphaCrop, f.crop.width, f.crop.height, 1),
      fetcher = server(mask, { [header!]: value! });
    await expect(
      matteSpatialVolume(await encoded(f), { ...options, fetch: fetcher }),
    ).rejects.toBeInstanceOf(SpatialVolumeMatteError);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects mask dimensions, RGB and alpha channels", async () => {
    const f = fixture();
    const masks = [
      await png(Buffer.alloc(8 * 8), 8, 8, 1),
      await png(
        Buffer.alloc(f.crop.width * f.crop.height * 3),
        f.crop.width,
        f.crop.height,
        3,
      ),
      await sharp(await png(f.alphaCrop, f.crop.width, f.crop.height, 1))
        .ensureAlpha()
        .png()
        .toBuffer(),
    ];
    for (const mask of masks)
      await expect(
        matteSpatialVolume(await encoded(f), {
          ...options,
          fetch: server(mask),
        }),
      ).rejects.toThrow();
  });

  it("bounds a stalled fetch and marks the failure retryable without another request", async () => {
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
    await expect(
      matteSpatialVolume(await encoded(), {
        ...options,
        timeoutMs: 10,
        fetch: fetcher,
      }),
    ).rejects.toMatchObject({ code: "matting-timeout", retryable: true });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("bounds a stalled response body and cancels the reader", async () => {
    const cancelled = vi.fn();
    const fetcher = vi.fn<typeof fetch>(
      async (_url, init) =>
        new Response(new ReadableStream({ cancel: cancelled }), {
          headers: {
            "content-type": "image/png",
            "x-matting-model": policy.model,
            "x-matting-model-sha256": policy.modelSha256,
            "x-matting-runtime": policy.runtime,
            "x-matting-input-sha256": hash(
              new Uint8Array(init!.body as Uint8Array),
            ),
          },
        }),
    );
    await expect(
      matteSpatialVolume(await encoded(), {
        ...options,
        timeoutMs: 10,
        fetch: fetcher,
      }),
    ).rejects.toMatchObject({ code: "matting-timeout", retryable: true });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("enforces the response-byte bound even without a declared length", async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>(
      async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(policy.maximumMaskBytes + 1));
            },
            cancel,
          }),
          {
            headers: {
              "content-type": "image/png",
              "x-matting-model": policy.model,
              "x-matting-model-sha256": policy.modelSha256,
              "x-matting-runtime": policy.runtime,
              "x-matting-input-sha256": hash(
                new Uint8Array(init!.body as Uint8Array),
              ),
            },
          },
        ),
    );
    await expect(
      matteSpatialVolume(await encoded(), { ...options, fetch: fetcher }),
    ).rejects.toMatchObject({ code: "mask-too-large", retryable: false });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("aborts an active request and never treats cancellation as a photo failure", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async () => {
      controller.abort();
      return new Promise(() => {});
    });
    await expect(
      matteSpatialVolume(await encoded(), {
        ...options,
        signal: controller.signal,
        fetch: fetcher,
      }),
    ).rejects.toMatchObject({ code: "cancelled", retryable: false });
  });

  it("marks only temporary HTTP responses retryable", async () => {
    for (const status of [401, 422, 503]) {
      await expect(
        matteSpatialVolume(await encoded(), {
          ...options,
          fetch: server(Buffer.from("unavailable"), {}, status),
        }),
      ).rejects.toMatchObject({
        code: "invalid-service-response",
        retryable: status === 503,
      });
    }
  });

  it("refuses unsupported contact profiles and nonprivate plaintext transport", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      matteSpatialVolume(
        { ...(await encoded()), contactProfile: "legs" as "solid-base" },
        { ...options, fetch: fetcher },
      ),
    ).rejects.toMatchObject({ code: "unsupported-contact-profile" });
    await expect(
      matteSpatialVolume(await encoded(), {
        ...options,
        url: "http://example.com",
        fetch: fetcher,
      }),
    ).rejects.toMatchObject({ code: "invalid-service-configuration" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
