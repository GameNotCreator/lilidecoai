import { afterEach, describe, expect, it, vi } from "vitest";
import {
  imageCostAllowance,
  imageQualityForModel,
  imageUsageCost,
} from "../lib/server/ai/openai-image-settings";

vi.mock("server-only", () => ({}));
vi.mock("../lib/server/config", () => ({
  serverConfig: {
    openaiApiKey: "test-only",
    openaiBaseUrl: "https://invalid.test/v1",
    openaiModel: "gpt-image-2.5-sunburst",
    openAIImageEnabled: true,
    aiMockMode: false,
  },
}));
import { OpenAIImageProvider } from "../lib/server/ai/openai";
import { selectEditingProvider } from "../lib/server/ai/registry";

afterEach(() => vi.unstubAllGlobals());

describe("image model capability and accounting", () => {
  it("honors the configured model on the photo workflow", () => {
    expect(
      selectEditingProvider("insert", "final", "openai").provider.model,
    ).toBe("gpt-image-2.5-sunburst");
  });
  it("uses max on 2.5 and a supported setting on earlier deployments", () => {
    expect(
      imageQualityForModel("gpt-image-2.5-sunburst-2026-09-08", "max"),
    ).toBe("max");
    expect(imageQualityForModel("gpt-image-2.5-flare", "xhigh")).toBe("xhigh");
    expect(imageQualityForModel("gpt-image-2", "max")).toBe("high");
    expect(imageQualityForModel("gpt-image-1.5", "medium")).toBe("medium");
  });
  it("uses reported image/text/output tokens rather than the old rate card", () => {
    expect(
      imageUsageCost("gpt-image-2.5-sunburst", {
        input_tokens_details: { text_tokens: 1_000, image_tokens: 2_000 },
        output_tokens: 10_000,
      }),
    ).toBeCloseTo(0.321);
    expect(
      imageUsageCost("gpt-image-2.5-sunburst", { output_tokens: -1 }),
    ).toBeNull();
    expect(imageUsageCost("unknown", { output_tokens: 1 })).toBeNull();
    expect(
      imageCostAllowance("gpt-image-2.5-sunburst", "max", "1024x1024"),
    ).toBeGreaterThan(1);
  });
  it("sends max, lossless output and a matching base/mask; records real usage", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: [{ b64_json: "AQID" }],
        usage: {
          input_tokens_details: { text_tokens: 1_000, image_tokens: 2_000 },
          output_tokens: 10_000,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await new OpenAIImageProvider().edit(request());
    const body = (
      fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    )[1].body as FormData;
    expect(body.get("model")).toBe("gpt-image-2.5-sunburst");
    expect(body.get("quality")).toBe("max");
    expect(body.get("output_compression")).toBe("100");
    expect(body.getAll("image[]")).toHaveLength(2);
    expect(body.get("mask")).toBeInstanceOf(Blob);
    expect(result.estimatedCostUsd).toBeCloseTo(0.321);
    expect(result.usage?.output_tokens).toBe(10_000);
  });
  it("does not start an image call if it would consume the review reserve", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await new OpenAIImageProvider().edit({
      ...request(),
      deadlineMs: Date.now() + 40_000,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.error?.code).toBe("render_deadline");
    expect(result.estimatedCostUsd).toBe(0);
  });
  it("transmits the spatial guide after the room and identity reference", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ data: [{ b64_json: "AQID" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await new OpenAIImageProvider().edit({
      ...request(),
      references: [
        {
          data: new Uint8Array([1]),
          mimeType: "image/webp",
          role: "composition",
        },
        {
          data: new Uint8Array([2]),
          mimeType: "image/webp",
          role: "product_front",
        },
        {
          data: new Uint8Array([3]),
          mimeType: "image/webp",
          role: "spatial_guide",
        },
        {
          data: new Uint8Array([4]),
          mimeType: "image/webp",
          role: "product_detail",
        },
      ],
    });
    const body = (
      fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    )[1].body as FormData;
    const images = body.getAll("image[]") as Blob[];
    expect(
      await Promise.all(
        images.map(async (file) => [
          ...new Uint8Array(await file.arrayBuffer()),
        ]),
      ),
    ).toEqual([[1], [2], [3], [4]]);
  });
});

function request() {
  const bytes = new Uint8Array([1, 2, 3]);
  return {
    scene: bytes,
    productCutout: bytes,
    composition: bytes,
    protectionMask: bytes,
    targetMask: {
      data: bytes,
      role: "target_mask" as const,
      mimeType: "image/png" as const,
    },
    prompt: "Keep the placement",
    quality: "max" as const,
    size: "1536x1024" as const,
    lighting: {
      direction: "left",
      temperature: "neutral" as const,
      hardness: "soft" as const,
    },
    placement: { x: 0.5, y: 0.7 },
    idempotencyKey: "test",
    mode: "insert" as const,
    outputQuality: "final" as const,
    preserveBackground: true,
  };
}
