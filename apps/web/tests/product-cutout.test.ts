import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

vi.mock("server-only", () => ({}));
vi.mock("../lib/server/config", () => ({
  serverConfig: {
    mattingUrl: "http://127.0.0.1:7011",
    mattingToken: "test",
    mattingTimeoutMs: 1000,
  },
}));

import {
  applyProductMask,
  MattingUnavailableError,
  prepareProductCutout,
} from "../lib/server/product-cutout";
import { serverConfig } from "../lib/server/config";

afterEach(() => vi.restoreAllMocks());

async function image(width = 24, height = 32) {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 171, g: 93, b: 42, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
}

describe("source-preserving mask", () => {
  it("changes only alpha and intersects existing transparency", async () => {
    const source = await image();
    const mask = await sharp({
      create: { width: 24, height: 32, channels: 3, background: "#808080" },
    })
      .png()
      .toBuffer();
    const original = await sharp(source).raw().toBuffer();
    const output = await sharp(await applyProductMask(source, mask))
      .raw()
      .toBuffer();
    for (let i = 0; i < output.length; i += 4) {
      expect(output.subarray(i, i + 3)).toEqual(original.subarray(i, i + 3));
      expect(output[i + 3]).toBe(Math.round((original[i + 3]! * 128) / 255));
    }
  });

  it("rejects shifted grids and masks carrying their own alpha", async () => {
    await expect(
      applyProductMask(await image(), await image(12, 32)),
    ).rejects.toThrow();
    await expect(
      applyProductMask(await image(), await image()),
    ).rejects.toThrow();
  });

  it("does not call the service for an already isolated object", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const source = await sharp(
      Buffer.from(
        '<svg width="400" height="400"><rect x="90" y="60" width="220" height="280" fill="red"/></svg>',
      ),
    )
      .png()
      .toBuffer();
    const result = await prepareProductCutout(source);
    expect(result.source).toBe("heuristic");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses the aligned mask and records real provenance on a photographic backdrop", async () => {
    const source = await sharp(
      Buffer.from(
        '<svg width="100" height="100"><rect width="100" height="100" fill="#333"/><rect width="50" height="100" fill="#ddd"/><circle cx="50" cy="50" r="25" fill="red"/></svg>',
      ),
    )
      .png()
      .toBuffer();
    const mask = await sharp(
      Buffer.from(
        '<svg width="100" height="100"><rect width="100" height="100" fill="black"/><circle cx="50" cy="50" r="25" fill="white"/></svg>',
      ),
    )
      .removeAlpha()
      .png()
      .toBuffer();
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array(mask), {
        headers: {
          "content-type": "image/png",
          "x-matting-model": "test-segmenter",
        },
      }),
    );
    const result = await prepareProductCutout(source);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(result.source).toBe("matting");
    expect(result.version).toContain("test-segmenter");
    expect(result.quality.opaque).toBe(false);
    expect(result.quality.vanished).toBe(false);
  });

  it.each([401, 503])(
    "reports provider failure %s as unavailable, not a bad photo",
    async (status) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("unavailable", { status }),
      );
      const source = await sharp({
        create: { width: 50, height: 50, channels: 3, background: "white" },
      })
        .png()
        .toBuffer();
      await expect(prepareProductCutout(source)).rejects.toBeInstanceOf(
        MattingUnavailableError,
      );
    },
  );

  it("keeps the unusable verdict when the service is not configured", async () => {
    const previous = serverConfig.mattingUrl;
    serverConfig.mattingUrl = undefined;
    try {
      const source = await sharp({
        create: { width: 50, height: 50, channels: 3, background: "white" },
      })
        .png()
        .toBuffer();
      const result = await prepareProductCutout(source);
      expect(result.source).toBe("heuristic");
      expect(result.quality.vanished).toBe(true);
    } finally {
      serverConfig.mattingUrl = previous;
    }
  });
});
