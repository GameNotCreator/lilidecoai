import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import sharp from "sharp";
import {
  checkSpatialMatting,
  PINNED_SPATIAL_MATTING as pin,
} from "./check-spatial-matting.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const healthy = (overrides) =>
  new Response(
    JSON.stringify({
      ready: true,
      busy: false,
      model: pin.model,
      modelSha256: pin.modelSha256,
      runtime: pin.runtime,
      ...overrides,
    }),
    { headers: { "content-type": "application/json" } },
  );
const options = {
  url: "http://127.0.0.1:7012",
  token: "smoke-test",
  timeoutMs: 1000,
};
async function fixtureFetch({
  health = {},
  maskSide = 256,
  headers = {},
} = {}) {
  const mask = await sharp(Buffer.alloc(maskSide ** 2), {
    raw: { width: maskSide, height: maskSide, channels: 1 },
  })
    .toColourspace("b-w")
    .png()
    .toBuffer();
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({
      url: String(url),
      method: init.method ?? "GET",
      redirect: init.redirect,
    });
    if (url.pathname === "/health") return healthy(health);
    assert.equal(url.pathname, "/v1/mask");
    assert.equal(init.headers.authorization, "Bearer smoke-test");
    return new Response(new Uint8Array(mask), {
      headers: {
        "content-type": "image/png",
        "x-matting-model": pin.responseModel,
        "x-matting-model-sha256": pin.modelSha256,
        "x-matting-runtime": pin.runtime,
        "x-matting-input-sha256": sha(init.body),
        "x-matting-mask-sha256": sha(mask),
        ...headers,
      },
    });
  };
  return { fetcher, calls };
}

test("one health probe and one local fixture prove the contract, not visual quality", async () => {
  const stub = await fixtureFetch();
  const report = await checkSpatialMatting({
    ...options,
    fetcher: stub.fetcher,
  });
  assert.equal(report.status, "passed");
  assert.equal(report.paidProviderCalls, 0);
  assert.equal(report.spatialQualityQualified, false);
  assert.equal(JSON.stringify(report).includes(options.token), false);
  assert.deepEqual(
    stub.calls.map((c) => c.method),
    ["GET", "POST"],
  );
  assert.ok(
    stub.calls.every(
      (c) => c.url.startsWith(options.url) && c.redirect === "error",
    ),
  );
});

test("changed health identity and busy workers stop before inference", async () => {
  for (const health of [
    { modelSha256: "0".repeat(64) },
    { runtime: "wrong" },
    { ready: false },
    { busy: true },
  ]) {
    const stub = await fixtureFetch({ health });
    await assert.rejects(
      checkSpatialMatting({ ...options, fetcher: stub.fetcher }),
    );
    assert.equal(stub.calls.length, 1);
  }
});

test("mask grid, proof identity and payload fingerprint cannot silently drift", async () => {
  for (const override of [
    { maskSide: 255 },
    { headers: { "x-matting-model-sha256": "wrong" } },
    { headers: { "x-matting-input-sha256": "wrong" } },
    { headers: { "x-matting-mask-sha256": "wrong" } },
  ]) {
    const stub = await fixtureFetch(override);
    await assert.rejects(
      checkSpatialMatting({ ...options, fetcher: stub.fetcher }),
    );
    assert.equal(stub.calls.length, 2);
  }
});

test("bad configuration is refused before transport", async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    throw Error("unreachable");
  };
  for (const invalid of [
    { url: "ftp://127.0.0.1" },
    { url: "http://example.com" },
    { token: "bad\nheader" },
    { timeoutMs: 120001 },
  ])
    await assert.rejects(
      checkSpatialMatting({ ...options, ...invalid, fetcher }),
    );
  assert.equal(calls, 0);
});

test("a stalled health response expires and does not expose a server error or token", async () => {
  const keepAlive = setInterval(() => {}, 100);
  try {
    await assert.rejects(
      checkSpatialMatting({
        ...options,
        timeoutMs: 20,
        fetcher: () => new Promise(() => {}),
      }),
      (error) => error.message === "service-timeout",
    );
    await assert.rejects(
      checkSpatialMatting({
        ...options,
        fetcher: async () => {
          throw Error(options.token);
        },
      }),
      (error) => !error.message.includes(options.token),
    );
  } finally {
    clearInterval(keepAlive);
  }
});
