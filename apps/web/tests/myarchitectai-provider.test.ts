import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageEditingRequest, ImageReference } from "@lili/ai-router";
import {
  ORIENTED_HARMONIZATION_PROMPT_VERSION,
  PREPARED_VIEW_PROMPT_VERSION,
  shouldRetryAttempt,
} from "@lili/ai-router";

const fixtures = vi.hoisted(() => ({
  dns: vi.fn(),
  https: vi.fn(),
  config: {
    myArchitectAIApiKey: "test-only-secret-never-print",
    myArchitectAITimeoutMs: 120_000,
    myArchitectAIEditCostUsd: 0.03,
    aiMockMode: false,
  },
}));
vi.mock("server-only", () => ({}));
vi.mock("node:dns/promises", () => ({ lookup: fixtures.dns }));
vi.mock("node:https", () => ({ request: fixtures.https }));
vi.mock("../lib/server/config", () => ({ serverConfig: fixtures.config }));
import { MyArchitectAIImageProvider } from "../lib/server/ai/myarchitectai";
import { durableContext } from "../lib/server/durable-context";
import type { RenderDocument } from "../lib/server/types";
import { STOREFRONT_HYBRID_PROMPT_VERSION } from "../lib/server/storefront-hybrid";

const publicHost =
  "https://cdn.myarchitectai.com/generated/image.png?signature=private";
const image: ImageReference = {
  data: new Uint8Array([1, 2, 3]),
  mimeType: "image/png",
  role: "room_original",
};
const product: ImageReference = {
  data: new Uint8Array([4, 5, 6]),
  mimeType: "image/jpeg",
  role: "product_front",
};

beforeEach(() => {
  fixtures.dns
    .mockReset()
    .mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  fixtures.https.mockReset();
  fixtures.config.myArchitectAIApiKey = "test-only-secret-never-print";
  fixtures.config.aiMockMode = false;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function api(payload: unknown, status = 200) {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(Response.json(payload, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function serveImage(
  bytes: Buffer,
  options: { status?: number; headers?: Record<string, string> } = {},
) {
  fixtures.https.mockImplementationOnce(
    (
      _url: URL,
      _options: RequestOptions,
      callback: (res: IncomingMessage) => void,
    ) => {
      const req = new EventEmitter() as EventEmitter & { end: () => void };
      req.end = () =>
        queueMicrotask(() => {
          const response = Readable.from([bytes]) as IncomingMessage;
          response.statusCode = options.status ?? 200;
          response.headers = options.headers ?? { "content-type": "image/png" };
          callback(response);
        });
      return req;
    },
  );
}

async function png(width = 8, height = 6) {
  return sharp({
    create: { width, height, channels: 3, background: "#abcabc" },
  })
    .png()
    .toBuffer();
}

function request(): ImageEditingRequest {
  return {
    scene: image.data,
    productCutout: product.data,
    composition: image.data,
    protectionMask: image.data,
    prompt: "Place the lamp on the table.",
    quality: "high",
    size: "1536x1024",
    lighting: { direction: "left", temperature: "neutral", hardness: "soft" },
    placement: { x: 0.5, y: 0.6 },
    idempotencyKey: "test-idempotency",
    mode: "insert",
    preserveBackground: true,
    references: [image, product],
  };
}

describe("MyArchitectAI documented edit contract", () => {
  it("posts the exact JSON fields, downloads without secrets and normalizes to WebP", async () => {
    const fetchMock = api({
      output: publicHost,
      cost: 0.031,
      balance: 5.5,
      requestId: 214,
    });
    serveImage(await png());
    const result = await new MyArchitectAIImageProvider().editImage({
      image,
      referenceImage: product,
      prompt: "Keep this exact lamp.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.myarchitectai.com/v1/edit-by-prompt");
    expect(options.method).toBe("POST");
    expect(options.redirect).toBe("error");
    expect(options.headers).toEqual({
      "Content-Type": "application/json",
      "x-api-key": fixtures.config.myArchitectAIApiKey,
    });
    expect(JSON.parse(options.body as string)).toEqual({
      image: "data:image/png;base64,AQID",
      referenceImage: "data:image/jpeg;base64,BAUG",
      prompt: "Keep this exact lamp.",
    });
    const [, downloadOptions] = fixtures.https.mock.calls[0] as [
      URL,
      RequestOptions,
    ];
    expect(downloadOptions.headers).toEqual({
      Accept: "image/png,image/jpeg,image/webp",
    });
    expect(JSON.stringify(downloadOptions)).not.toContain(
      fixtures.config.myArchitectAIApiKey,
    );
    expect(downloadOptions.agent).toBe(false);
    const resolved = vi.fn();
    downloadOptions.lookup!("cdn.myarchitectai.com", { all: true }, resolved);
    expect(resolved).toHaveBeenCalledWith(null, [
      { address: "8.8.8.8", family: 4 },
    ]);
    expect(result).toMatchObject({
      provider: "myarchitectai",
      model: "edit-by-prompt",
      requestId: "214",
      status: "succeeded",
      estimatedCostUsd: 0.031,
      attemptCount: 1,
    });
    expect(result.images[0]).toMatchObject({
      mimeType: "image/webp",
      width: 8,
      height: 6,
    });
    expect((await sharp(result.images[0]!.data).metadata()).format).toBe(
      "webp",
    );
    expect(JSON.stringify(result)).not.toContain("signature=private");
  });

  it("allows a room-only edit and does not invent optional API parameters", async () => {
    const fetchMock = api({ error: "test refusal", cost: 0, requestId: 1 });
    await new MyArchitectAIImageProvider().editImage({
      image,
      prompt: "Make the wall green.",
    });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      image: "data:image/png;base64,AQID",
      prompt: "Make the wall green.",
    });
  });

  it("uses the composition and one product reference, with explicit image mapping but no mask field", async () => {
    const fetchMock = api({ error: "refused", cost: 0 });
    const composition: ImageReference = {
      ...image,
      data: new Uint8Array([7]),
      role: "composition",
    };
    await new MyArchitectAIImageProvider().edit({
      ...request(),
      references: [image, product, composition],
      targetMask: { ...image, role: "target_mask" },
    });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.image).toBe("data:image/png;base64,Bw==");
    expect(body.referenceImage).toBe("data:image/jpeg;base64,BAUG");
    expect(body.prompt).toContain("Place the lamp on the table.");
    expect(body.prompt).toContain("do not add a duplicate");
    expect(Object.keys(body).sort()).toEqual([
      "image",
      "prompt",
      "referenceImage",
    ]);
  });

  it.each([
    [
      [image, product, { ...product, role: "product_detail" }],
      "unsupported_product_references",
    ],
    [
      [image, product, { ...image, role: "spatial_guide" }],
      "unsupported_spatial_guide",
    ],
  ] as const)(
    "refuses unsupported reference topologies before a paid call",
    async (references, code) => {
      const fetchMock = api({});
      const result = await new MyArchitectAIImageProvider().edit({
        ...request(),
        references: [...references],
      });
      expect(result.error?.code).toBe(code);
      expect(result.estimatedCostUsd).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("does not consume the quality review reserve", async () => {
    const fetchMock = api({});
    const result = await new MyArchitectAIImageProvider().generate({
      ...request(),
      deadlineMs: Date.now() + 40_000,
    });
    expect(result.error?.code).toBe("render_deadline");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("honors mock mode and an absent key without making a real call", async () => {
    const fetchMock = api({});
    fixtures.config.aiMockMode = true;
    expect(new MyArchitectAIImageProvider().isAvailable()).toBe(false);
    expect(
      (
        await new MyArchitectAIImageProvider().editImage({
          image,
          prompt: "Edit",
        })
      ).error?.code,
    ).toBe("provider_unavailable");
    fixtures.config.aiMockMode = false;
    fixtures.config.myArchitectAIApiKey = "";
    expect(new MyArchitectAIImageProvider().isAvailable()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("limits the complete UTF-8 JSON body to 10 MiB", async () => {
    const fetchMock = api({});
    const result = await new MyArchitectAIImageProvider().editImage({
      image,
      prompt: "é".repeat(5 * 1024 * 1024),
    });
    expect(result.error?.code).toBe("request_too_large");
    expect(result.estimatedCostUsd).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("MyArchitectAI public storefront composition contract", () => {
  async function storefrontRequest(): Promise<ImageEditingRequest> {
    const composition: ImageReference = {
      data: await png(32, 32),
      mimeType: "image/png",
      role: "composition",
    };
    return {
      ...request(),
      operation: "storefront_integration",
      composition: composition.data,
      // Original references remain available to the separate reviewer. They
      // must never become a second MyArchitectAI image or catalogue fallback.
      references: [image, product, composition],
      prompt: "Keep this room and product geometry. Add soft contact shading only.",
    };
  }

  it("posts only the actual composition and exact prompt, never the catalogue or mask", async () => {
    const input = await storefrontRequest();
    const fetchMock = api({ output: publicHost, cost: 0.03, requestId: 801 });
    serveImage(await png(32, 32));
    const result = await new MyArchitectAIImageProvider().edit(input);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body).toEqual({
      image: `data:image/png;base64,${Buffer.from(input.composition).toString("base64")}`,
      prompt: input.prompt,
    });
    expect(body).not.toHaveProperty("referenceImage");
    expect(body.prompt).not.toContain("image 2");
    expect(result).toMatchObject({
      status: "succeeded",
      requestId: "801",
      estimatedCostUsd: 0.03,
      attemptCount: 1,
      usage: {
        operation: "storefront_integration",
        promptVersion: STOREFRONT_HYBRID_PROMPT_VERSION,
        providerOutcome: "succeeded",
      },
    });
  });

  it("does not revive the legacy productCutout fallback when explicit references are absent", async () => {
    const input = await storefrontRequest();
    const fetchMock = api({ error: "refused", cost: 0, requestId: 802 });
    await new MyArchitectAIImageProvider().edit({ ...input, references: [] });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      image: `data:image/webp;base64,${Buffer.from(input.composition).toString("base64")}`,
      prompt: input.prompt,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a refunded provider refusal distinct from a successful image and never replays it", async () => {
    const fetchMock = api({ error: "provider refusal", cost: 0, requestId: 803 });
    const result = await new MyArchitectAIImageProvider().edit(await storefrontRequest());
    expect(result).toMatchObject({
      status: "failed",
      requestId: "803",
      estimatedCostUsd: 0,
      images: [],
      error: { code: "provider_error", retryable: false },
      usage: { operation: "storefront_integration", refundConfirmed: true, providerOutcome: "rejected" },
    });
    expect(shouldRetryAttempt(result)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fixtures.https).not.toHaveBeenCalled();
  });

  it("retains the paid receipt when downloading the storefront result fails, without another POST", async () => {
    const fetchMock = api({ output: publicHost, cost: 0.029, requestId: 804 });
    serveImage(Buffer.from("expired"), { status: 404 });
    const result = await new MyArchitectAIImageProvider().edit(await storefrontRequest());
    expect(result).toMatchObject({
      status: "failed", requestId: "804", estimatedCostUsd: 0.029,
      error: { code: "image_download_failed", retryable: false },
      usage: { operation: "storefront_integration", providerOutcome: "succeeded" },
    });
    expect(shouldRetryAttempt(result)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("signature=private");
  });

  it("does not begin a paid storefront request when only the review reserve remains", async () => {
    const input = await storefrontRequest();
    const fetchMock = api({});
    const result = await new MyArchitectAIImageProvider().edit({ ...input, deadlineMs: Date.now() + 40_000 });
    expect(result).toMatchObject({
      status: "failed", estimatedCostUsd: 0,
      error: { code: "render_deadline", retryable: false },
      usage: { operation: "storefront_integration", providerOutcome: "not_sent" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts an in-flight paid POST at the worker deadline and records an unknown outcome without retry", async () => {
    const input = await storefrontRequest();
    const deadline = new AbortController();
    let sentSignal: AbortSignal | undefined;
    let announceStarted!: () => void;
    const started = new Promise<void>(resolve => { announceStarted = resolve; });
    const fetchMock = vi.fn((_url: string, options: RequestInit) => {
      sentSignal = options.signal!;
      announceStarted();
      return new Promise<Response>((_resolve, reject) => {
        sentSignal!.addEventListener("abort", () => reject(sentSignal!.reason), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const pending = durableContext.run({ render: {} as RenderDocument, token: "deadline-test", signal: deadline.signal },
      () => new MyArchitectAIImageProvider().edit({ ...input, deadlineMs: Date.now() + 180_000 }));
    await started;
    expect(sentSignal?.aborted).toBe(false);
    deadline.abort(new DOMException("Storefront hard deadline", "AbortError"));
    const result = await pending;
    expect(sentSignal?.aborted).toBe(true);
    expect(result).toMatchObject({
      status: "failed", estimatedCostUsd: 0.03, images: [],
      error: { code: "timeout", retryable: false },
      usage: { operation: "storefront_integration", providerOutcome: "unknown" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fixtures.https).not.toHaveBeenCalled();
    expect(shouldRetryAttempt(result)).toBe(false);
  });
});

describe("MyArchitectAI explicit oriented operations", () => {
  const orientation = { azimuthDeg: 20, elevationDeg: 45, rollDeg: 0 };

  it("prepares a private product-only candidate and records requested orientation separately", async () => {
    const fetchMock = api({ output: publicHost, cost: 0.029, requestId: 701 });
    const source = {
      ...product,
      mimeType: "image/png" as const,
      data: await png(),
    };
    serveImage(await png());
    const result = await new MyArchitectAIImageProvider().prepareView({
      productImage: source,
      requestedOrientation: orientation,
    });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(Object.keys(body).sort()).toEqual(["image", "prompt"]);
    expect(body.image).toBe(
      `data:image/png;base64,${Buffer.from(source.data).toString("base64")}`,
    );
    expect(body.prompt).toContain("elevation 45 degrees");
    expect(body.prompt).not.toMatch(/image 2/i);
    expect(result).toMatchObject({
      status: "succeeded",
      estimatedCostUsd: 0.029,
      usage: {
        operation: "prepared_view",
        promptVersion: PREPARED_VIEW_PROMPT_VERSION,
        requestedOrientation: orientation,
        candidateOnly: true,
        providerOutcome: "succeeded",
        configurationVersion: "myarchitectai-edit-v2",
        configuration: { modelVersion: "unspecified_by_provider" },
      },
    });
    expect(result.usage).not.toHaveProperty("approvedCoverage");
    expect(result.usage).not.toHaveProperty("measuredOrientation");
  });

  it("sends a second preparation reference only when explicitly provided", async () => {
    const fetchMock = api({ error: "refused", cost: 0 });
    const source = {
      ...product,
      mimeType: "image/png" as const,
      data: await png(),
    };
    const second = {
      ...source,
      role: "product_side" as const,
      data: await png(12, 8),
    };
    await new MyArchitectAIImageProvider().prepareView({
      productImage: source,
      referenceImage: second,
      requestedOrientation: orientation,
    });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.referenceImage).toBe(
      `data:image/png;base64,${Buffer.from(second.data).toString("base64")}`,
    );
    expect(body.prompt).toContain(
      "Image 2 is an additional authentic catalogue reference",
    );
  });

  it.each([
    { azimuthDeg: NaN, elevationDeg: 45, rollDeg: 0 },
    { azimuthDeg: 0, elevationDeg: 91, rollDeg: 0 },
    { azimuthDeg: 181, elevationDeg: 45, rollDeg: 0 },
  ])(
    "refuses invalid requested orientation before a paid call",
    async (requestedOrientation) => {
      const fetchMock = api({});
      const result = await new MyArchitectAIImageProvider().prepareView({
        productImage: product,
        requestedOrientation,
      });
      expect(result).toMatchObject({
        estimatedCostUsd: 0,
        error: { code: "invalid_prepared_view_input" },
        usage: { providerOutcome: "not_sent", operation: "prepared_view" },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("refuses scene references and unreadable product files before preparing", async () => {
    const fetchMock = api({});
    const provider = new MyArchitectAIImageProvider();
    expect(
      (
        await provider.prepareView({
          productImage: image,
          requestedOrientation: orientation,
        })
      ).error?.code,
    ).toBe("invalid_prepared_view_input");
    expect(
      (
        await provider.prepareView({
          productImage: product,
          requestedOrientation: orientation,
        })
      ).error?.code,
    ).toBe("invalid_input");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("harmonizes only the precomposed image and never sends a frontal fallback or image 2 mapping", async () => {
    const fetchMock = api({ output: publicHost, cost: 0.03, requestId: 702 });
    const composition = {
      ...image,
      role: "composition" as const,
      data: await png(),
    };
    serveImage(await png());
    const result = await new MyArchitectAIImageProvider().edit({
      ...request(),
      operation: "oriented_harmonization",
      references: [
        image,
        product,
        composition,
        { ...product, role: "product_side" },
      ],
    });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(Object.keys(body).sort()).toEqual(["image", "prompt"]);
    expect(body.image).toBe(
      `data:image/png;base64,${Buffer.from(composition.data).toString("base64")}`,
    );
    expect(body.prompt).not.toMatch(/image 2/i);
    expect(result).toMatchObject({
      status: "succeeded",
      usage: {
        operation: "oriented_harmonization",
        promptVersion: ORIENTED_HARMONIZATION_PROMPT_VERSION,
      },
    });
  });

  it("supports the explicit harmonization method without any productCutout input", async () => {
    const fetchMock = api({ error: "refused", cost: 0 });
    await new MyArchitectAIImageProvider().harmonize({
      composition: { ...image, role: "composition", data: await png() },
    });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).not.toHaveProperty(
      "referenceImage",
    );
  });

  it("rejects stale two-image instructions instead of silently sending the wrong contract", async () => {
    const fetchMock = api({});
    const result = await new MyArchitectAIImageProvider().harmonize({
      composition: { ...image, role: "composition", data: await png() },
      instructions: "Preserve the identity in image 2.",
    });
    expect(result.error?.code).toBe("invalid_harmonization_input");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the historical cutout fallback and mapping for an omitted operation", async () => {
    const fetchMock = api({ error: "refused", cost: 0 });
    const result = await new MyArchitectAIImageProvider().edit({
      ...request(),
      references: [image],
    });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.referenceImage).toBe("data:image/webp;base64,BAUG");
    expect(body.prompt).toContain(
      "image 2 is the attached product catalogue reference",
    );
    expect(result.usage?.operation).toBe("legacy_composition");
  });

  it("preserves known paid success when oriented output is locally rejected for aspect ratio", async () => {
    const fetchMock = api({ output: publicHost, cost: 0.025, requestId: 703 });
    serveImage(await png(10, 10));
    const result = await new MyArchitectAIImageProvider().harmonize({
      composition: { ...image, role: "composition", data: await png() },
    });
    expect(result).toMatchObject({
      status: "failed",
      estimatedCostUsd: 0.025,
      requestId: "703",
      error: { code: "output_aspect_ratio_mismatch", retryable: false },
      usage: {
        providerOutcome: "succeeded",
        operation: "oriented_harmonization",
      },
    });
    expect(shouldRetryAttempt(result)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("persists a known response and cost before download, without exposing its private URL in the result", async () => {
    api({ output: publicHost, cost: 0.023, requestId: 704 });
    serveImage(Buffer.from("not available"), { status: 404 });
    const onProviderResponse = vi.fn(async () => {
      expect(fixtures.https).not.toHaveBeenCalled();
    });
    const result = await new MyArchitectAIImageProvider().prepareView({
      productImage: { ...product, data: await png(), mimeType: "image/png" },
      requestedOrientation: orientation,
      onProviderResponse,
    });
    expect(onProviderResponse).toHaveBeenCalledExactlyOnceWith({
      requestId: "704",
      estimatedCostUsd: 0.023,
      outcome: "succeeded",
      outputReference: publicHost,
    });
    expect(result).toMatchObject({
      status: "failed",
      estimatedCostUsd: 0.023,
      usage: { providerOutcome: "succeeded" },
      error: { code: "image_download_failed", retryable: false },
    });
    expect(JSON.stringify(result)).not.toContain("signature=private");
  });

  it("retains cost and blocks replay if persisting the paid response fails", async () => {
    const fetchMock = api({ output: publicHost, cost: 0.021, requestId: 705 });
    const result = await new MyArchitectAIImageProvider().prepareView({
      productImage: { ...product, data: await png(), mimeType: "image/png" },
      requestedOrientation: orientation,
      onProviderResponse: async () => {
        throw new Error("storage failure");
      },
    });
    expect(result).toMatchObject({
      status: "failed",
      estimatedCostUsd: 0.021,
      usage: { providerOutcome: "succeeded" },
      error: { code: "provider_checkpoint_failed", retryable: false },
    });
    expect(fixtures.https).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("recovers an already paid private output without a key or a second POST", async () => {
    const fetchMock = api({});
    fixtures.config.myArchitectAIApiKey = "";
    serveImage(await png());
    const result =
      await new MyArchitectAIImageProvider().downloadPreparedResponse({
        observation: {
          requestId: "paid-before-crash",
          estimatedCostUsd: 0.028,
          outcome: "succeeded",
          outputReference: publicHost,
        },
        productImage: { ...product, data: await png(), mimeType: "image/png" },
        requestedOrientation: orientation,
      });
    expect(result).toMatchObject({
      status: "succeeded",
      requestId: "paid-before-crash",
      estimatedCostUsd: 0.028,
      usage: {
        recoveredResponse: true,
        providerOutcome: "succeeded",
        operation: "prepared_view",
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fixtures.dns).toHaveBeenCalledTimes(1);
  });

  it("recovers harmonization and checks the composition ratio without another POST", async () => {
    const fetchMock = api({});
    serveImage(await png(10, 10));
    const result =
      await new MyArchitectAIImageProvider().downloadHarmonizationResponse({
        observation: {
          requestId: "paid-render",
          estimatedCostUsd: 0.028,
          outcome: "succeeded",
          outputReference: publicHost,
        },
        composition: { ...image, role: "composition", data: await png() },
      });
    expect(result).toMatchObject({
      status: "failed",
      estimatedCostUsd: 0.028,
      usage: {
        providerOutcome: "succeeded",
        operation: "oriented_harmonization",
        recoveredResponse: true,
      },
      error: { code: "output_aspect_ratio_mismatch", retryable: false },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps paid accounting if recovery expires before downloading", async () => {
    const fetchMock = api({});
    const result =
      await new MyArchitectAIImageProvider().downloadPreparedResponse({
        observation: {
          requestId: "paid-before-crash",
          estimatedCostUsd: 0.028,
          outcome: "succeeded",
          outputReference: publicHost,
        },
        productImage: product,
        requestedOrientation: orientation,
        deadlineMs: Date.now() - 1,
      });
    expect(result).toMatchObject({
      status: "failed",
      estimatedCostUsd: 0.028,
      usage: { providerOutcome: "succeeded" },
      error: { code: "render_deadline", retryable: false },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fixtures.https).not.toHaveBeenCalled();
  });

  it("labels a lost preparation response as unknown and never replays it", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("lost response"));
    vi.stubGlobal("fetch", fetchMock);
    const result = await new MyArchitectAIImageProvider().prepareView({
      productImage: { ...product, data: await png(), mimeType: "image/png" },
      requestedOrientation: orientation,
    });
    expect(result).toMatchObject({
      status: "failed",
      estimatedCostUsd: 0.03,
      usage: { providerOutcome: "unknown", operation: "prepared_view" },
      error: { retryable: false },
    });
    expect(shouldRetryAttempt(result)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("MyArchitectAI pipeline output proportions", () => {
  it("rejects a square output for a landscape base without dropping its charge or request ID", async () => {
    const fetchMock = api({ output: publicHost, cost: 0.031, requestId: 79 });
    serveImage(await png(1024, 1024));
    const result = await new MyArchitectAIImageProvider().edit({
      ...request(),
      references: [{ ...image, data: await png(736, 552) }, product],
    });
    expect(result).toMatchObject({
      status: "failed",
      requestId: "79",
      estimatedCostUsd: 0.031,
      images: [],
      error: { code: "output_aspect_ratio_mismatch", retryable: false },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [736, 552, 1184, 896],
    [736, 736, 1024, 1024],
  ])(
    "accepts %i×%i to %i×%i when the ratio differs by less than 2 percent",
    async (baseWidth, baseHeight, outputWidth, outputHeight) => {
      api({ output: publicHost, cost: 0.03, requestId: 80 });
      serveImage(await png(outputWidth, outputHeight));
      const result = await new MyArchitectAIImageProvider().generate({
        ...request(),
        references: [
          { ...image, data: await png(baseWidth, baseHeight) },
          product,
        ],
      });
      expect(result.status).toBe("succeeded");
      expect(result.images[0]).toMatchObject({
        width: outputWidth,
        height: outputHeight,
      });
    },
  );

  it("fails closed when the base dimensions cannot be verified after a paid output", async () => {
    api({ output: publicHost, cost: 0.03, requestId: 81 });
    serveImage(await png());
    const result = await new MyArchitectAIImageProvider().edit(request());
    expect(result).toMatchObject({
      status: "failed",
      requestId: "81",
      estimatedCostUsd: 0.03,
      images: [],
      error: { code: "unverifiable_image_dimensions", retryable: false },
    });
  });
});

describe("MyArchitectAI errors and paid attempt accounting", () => {
  it("treats a documented HTTP 200 error as a refunded failure and suppresses upstream secrets", async () => {
    const fetchMock = api({
      error: `Bad image ${fixtures.config.myArchitectAIApiKey}`,
      cost: 0,
      requestId: 9,
    });
    const result = await new MyArchitectAIImageProvider().edit(request());
    expect(result).toMatchObject({
      status: "failed",
      estimatedCostUsd: 0,
      requestId: "9",
      images: [],
      error: { code: "provider_error", retryable: false },
    });
    expect(JSON.stringify(result)).not.toContain(
      fixtures.config.myArchitectAIApiKey,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fixtures.https).not.toHaveBeenCalled();
  });

  it.each([
    [401, 0, false],
    [402, 0, false],
    [413, 0, false],
    [429, 0, true],
    [408, 0.03, false],
    [503, 0.03, false],
  ])(
    "handles HTTP %i without automatically repeating the paid POST",
    async (status, cost, retryable) => {
      const fetchMock = api(
        { error: fixtures.config.myArchitectAIApiKey },
        status as number,
      );
      const result = await new MyArchitectAIImageProvider().edit(request());
      expect(result).toMatchObject({
        status: "failed",
        estimatedCostUsd: cost,
        error: { code: `http_${status}`, httpStatus: status, retryable },
      });
      expect(JSON.stringify(result)).not.toContain(
        fixtures.config.myArchitectAIApiKey,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["TimeoutError", "TypeError"])(
    "retains the allowance on an uncertain %s outcome",
    async (name) => {
      const reason = new Error(fixtures.config.myArchitectAIApiKey);
      reason.name = name;
      const fetchMock = vi.fn().mockRejectedValue(reason);
      vi.stubGlobal("fetch", fetchMock);
      const result = await new MyArchitectAIImageProvider().edit(request());
      expect(result).toMatchObject({
        status: "failed",
        estimatedCostUsd: 0.03,
        error: {
          code: name === "TimeoutError" ? "timeout" : "network_error",
          retryable: false,
        },
      });
      expect(JSON.stringify(result)).not.toContain(
        fixtures.config.myArchitectAIApiKey,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    {},
    { output: "", cost: 0.03 },
    { output: "", cost: 0 },
    null,
    [],
    { cost: -1 },
  ])(
    "retains allowance when HTTP 200 has no usable output",
    async (payload) => {
      api(payload);
      const result = await new MyArchitectAIImageProvider().edit(request());
      expect(result.status).toBe("failed");
      expect(result.estimatedCostUsd).toBe(0.03);
      expect(result.error?.retryable).toBe(false);
    },
  );

  it("retains allowance on a malformed JSON response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{not json")),
    );
    const result = await new MyArchitectAIImageProvider().edit(request());
    expect(result.error?.code).toBe("invalid_response");
    expect(result.estimatedCostUsd).toBe(0.03);
  });

  it("retains the provider's charged cost when output download fails", async () => {
    const fetchMock = api({ output: publicHost, cost: 0.025, requestId: 4 });
    serveImage(Buffer.from("not available"), { status: 404 });
    const result = await new MyArchitectAIImageProvider().edit(request());
    expect(result).toMatchObject({
      status: "failed",
      estimatedCostUsd: 0.025,
      requestId: "4",
      error: { code: "image_download_failed", retryable: false },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an output that is not an image without losing its charged cost", async () => {
    api({ output: publicHost, cost: 0.03 });
    serveImage(Buffer.from("not an image"));
    const result = await new MyArchitectAIImageProvider().edit(request());
    expect(result.error?.code).toBe("invalid_output_image");
    expect(result.estimatedCostUsd).toBe(0.03);
  });
});

describe("MyArchitectAI output download boundaries", () => {
  it.each([
    "http://cdn.myarchitectai.com/image.png",
    "https://127.0.0.1/image.png",
    "https://[::1]/image.png",
    "https://user:password@cdn.myarchitectai.com/image.png",
    "https://metadata.internal/image.png",
    "https://localhost/image.png",
    "https://cdn.myarchitectai.com:8443/image.png",
  ])("blocks unsafe output URL %s before DNS or download", async (output) => {
    api({ output, cost: 0.03 });
    const result = await new MyArchitectAIImageProvider().edit(request());
    expect(result.error?.code).toBe("image_download_failed");
    expect(fixtures.dns).not.toHaveBeenCalled();
    expect(fixtures.https).not.toHaveBeenCalled();
  });

  it.each([
    "127.0.0.1",
    "10.2.3.4",
    "169.254.169.254",
    "172.20.1.1",
    "192.168.1.1",
    "100.64.1.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
  ])("blocks DNS pointing to %s", async (address) => {
    api({ output: publicHost, cost: 0.03 });
    fixtures.dns.mockResolvedValue([
      { address, family: address.includes(":") ? 6 : 4 },
    ]);
    const result = await new MyArchitectAIImageProvider().edit(request());
    expect(result.error?.code).toBe("image_download_failed");
    expect(fixtures.https).not.toHaveBeenCalled();
  });

  it("checks all DNS answers rather than only the first public answer", async () => {
    api({ output: publicHost, cost: 0.03 });
    fixtures.dns.mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    const result = await new MyArchitectAIImageProvider().edit(request());
    expect(result.error?.code).toBe("image_download_failed");
    expect(fixtures.https).not.toHaveBeenCalled();
  });

  it("rejects a redirect toward a local host", async () => {
    api({ output: publicHost, cost: 0.03 });
    serveImage(Buffer.alloc(0), {
      status: 302,
      headers: { location: "https://127.0.0.1/private" },
    });
    const result = await new MyArchitectAIImageProvider().edit(request());
    expect(result.error?.code).toBe("image_download_failed");
    expect(fixtures.https).toHaveBeenCalledTimes(1);
  });

  it("resolves and pins each public CDN redirect without forwarding the API key", async () => {
    api({ output: publicHost, cost: 0.03 });
    serveImage(Buffer.alloc(0), {
      status: 302,
      headers: { location: "https://images.myarchitectai.com/final.png" },
    });
    serveImage(await png());
    const result = await new MyArchitectAIImageProvider().edit({
      ...request(),
      references: [{ ...image, data: await png() }, product],
    });
    expect(result.status).toBe("succeeded");
    expect(fixtures.dns).toHaveBeenCalledTimes(2);
    expect(fixtures.https).toHaveBeenCalledTimes(2);
    for (const [, options] of fixtures.https.mock.calls)
      expect(JSON.stringify(options)).not.toContain(
        fixtures.config.myArchitectAIApiKey,
      );
  });

  it("rejects an advertised download over the byte limit", async () => {
    api({ output: publicHost, cost: 0.03 });
    serveImage(Buffer.alloc(0), {
      headers: {
        "content-length": String(21 * 1024 * 1024),
        "content-type": "image/png",
      },
    });
    const result = await new MyArchitectAIImageProvider().edit(request());
    expect(result.error?.code).toBe("image_download_failed");
    expect(result.estimatedCostUsd).toBe(0.03);
  });

  it("enforces the byte limit on streamed bodies without Content-Length", async () => {
    api({ output: publicHost, cost: 0.03 });
    serveImage(Buffer.alloc(21 * 1024 * 1024));
    const result = await new MyArchitectAIImageProvider().edit(request());
    expect(result.error?.code).toBe("image_download_failed");
    expect(result.estimatedCostUsd).toBe(0.03);
  });

  it("enforces the decoded pixel limit on small compressed files", async () => {
    api({ output: publicHost, cost: 0.03 });
    const oversized = await sharp({
      create: { width: 5_001, height: 5_000, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    serveImage(oversized);
    const result = await new MyArchitectAIImageProvider().edit(request());
    expect(result.error?.code).toBe("invalid_output_image");
    expect(result.estimatedCostUsd).toBe(0.03);
  });
});
