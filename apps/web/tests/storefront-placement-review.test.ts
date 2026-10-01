import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/config", () => ({
  serverConfig: {
    openaiApiKey: "test-only",
    aiMockMode: false,
    openaiVisionModel: "gpt-6-astra",
    openaiServiceTier: "default",
    openaiBaseUrl: "https://invalid.test/v1",
  },
}));
import {
  parseStorefrontPlacementReview,
  reviewStorefrontPlacement,
  storefrontPlacementReviewAllowance,
  STOREFRONT_PLACEMENT_REVIEW_VERSION,
} from "../lib/server/ai/storefront-placement-review";
import type { VisualReviewInput } from "../lib/server/ai/visual-review";

const bounds = { xMin: 0.4, yMin: 0.3, xMax: 0.6, yMax: 0.6 };
const image = {
  data: new Uint8Array([1, 2, 3]),
  mimeType: "image/webp" as const,
};
const product = {
  id: "p1:0",
  name: "Panier",
  image,
  expectedBox: bounds,
  scaleVerified: false,
};
const input = (): VisualReviewInput & { generated: typeof image } => ({
  room: image,
  composition: image,
  generated: image,
  products: [product],
  replacement: false,
  deadlineMs: Date.now() + 180_000,
});
const pass = () => ({
  passed: true,
  score: 0.95,
  reason: "Conforme aux sources.",
});
function accepted() {
  return {
    accepted: true,
    score: 0.95,
    confidence: 0.95,
    photoUsable: pass(),
    backgroundPreserved: pass(),
    noUnrequestedProducts: pass(),
    products: [
      {
        id: product.id,
        confidence: 0.95,
        observedBox: { ...bounds },
        foregroundOccluded: false,
        checks: {
          present: pass(),
          identity: pass(),
          position: pass(),
          scale: pass(),
          perspective: pass(),
          contact: pass(),
          edges: pass(),
          occlusion: pass(),
          noDuplicate: pass(),
        },
      },
    ],
    feedback: "Conforme.",
  };
}
const envelope = (value: unknown, status = "completed") => ({
  status,
  output: [
    {
      type: "message",
      status: "completed",
      content: [{ type: "output_text", text: JSON.stringify(value) }],
    },
  ],
});
afterEach(() => vi.unstubAllGlobals());

describe("storefront placement-only qualification", () => {
  it("accepts faithful geometry without inventing lighting or photorealism evidence", () => {
    const decision = parseStorefrontPlacementReview(accepted(), [product]);
    expect(decision).toMatchObject({
      status: "accepted",
      version: STOREFRONT_PLACEMENT_REVIEW_VERSION,
    });
    expect(decision.feedback).toContain("lumière et ombres indicatives");
    expect(
      decision.checks.some((check) =>
        /lighting|photorealistic/i.test(check.name),
      ),
    ).toBe(false);
  });
  it.each([
    "present",
    "identity",
    "position",
    "scale",
    "perspective",
    "contact",
    "edges",
    "occlusion",
    "noDuplicate",
  ] as const)("rejects %s even if the model claims acceptance", (name) => {
    const data = accepted();
    data.products[0]!.checks[name].passed = false;
    expect(parseStorefrontPlacementReview(data, [product]).status).toBe(
      "rejected",
    );
  });
  it.each([
    "photoUsable",
    "backgroundPreserved",
    "noUnrequestedProducts",
  ] as const)("rejects %s defects", (name) => {
    const data = accepted();
    data[name].score = 0.7;
    expect(parseStorefrontPlacementReview(data, [product]).status).toBe(
      "rejected",
    );
  });
  it("rejects a displaced or enlarged object using the existing geometry tolerances", () => {
    const data = accepted();
    data.products[0]!.observedBox = {
      xMin: 0.2,
      yMin: 0.1,
      xMax: 0.65,
      yMax: 0.8,
    };
    expect(
      parseStorefrontPlacementReview(data, [product])
        .checks.filter((check) => check.name.includes("geometry"))
        .every((check) => check.score === 0),
    ).toBe(true);
  });
  it("rejects an unseen silhouette and an unproven foreground-occlusion exception", () => {
    const data = accepted();
    Object.assign(data.products[0]!, { observedBox: null });
    expect(parseStorefrontPlacementReview(data, [product]).status).toBe(
      "rejected",
    );
    const occluded = accepted();
    occluded.products[0]!.foregroundOccluded = true;
    occluded.products[0]!.confidence = 0.85;
    expect(parseStorefrontPlacementReview(occluded, [product]).status).toBe(
      "rejected",
    );
  });
  it("requires exact coverage including duplicate SKU placements", () => {
    const data = accepted();
    data.products.push({ ...data.products[0]! });
    expect(() =>
      parseStorefrontPlacementReview(data, [
        product,
        { ...product, id: "p1:1" },
      ]),
    ).toThrow(/exactement/);
    expect(() =>
      parseStorefrontPlacementReview(accepted(), [
        { ...product, id: "different" },
      ]),
    ).toThrow(/exactement/);
  });
  it("does not reuse old lighting-review schemas or accept missing fields", () => {
    const data = accepted();
    Object.assign(data.products[0]!.checks, { lightingAndShadows: pass() });
    expect(() => parseStorefrontPlacementReview(data, [product])).toThrow();
    const missing = accepted();
    delete (missing as Partial<typeof missing>).backgroundPreserved;
    expect(() => parseStorefrontPlacementReview(missing, [product])).toThrow();
  });
  it("reserves the verified full Astra allowance instead of a nominal three cents", () => {
    expect(storefrontPlacementReviewAllowance().estimatedCostUsd).toBe(0.55);
  });
  it("sends one focused medium request with source room, actual output and all originals", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(envelope(accepted())),
    );
    vi.stubGlobal("fetch", fetcher);
    expect((await reviewStorefrontPlacement(input())).status).toBe("accepted");
    expect(fetcher).toHaveBeenCalledOnce();
    const request = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(request).toMatchObject({
      reasoning: { effort: "medium" },
      max_output_tokens: 6000,
      text: { format: { name: "storefront_placement_review" } },
    });
    expect(
      request.input[1].content.filter(
        (entry: { type: string }) => entry.type === "input_image",
      ),
    ).toHaveLength(3);
    expect(request.input[0].content[0].text).toContain(
      "Do not assess aesthetic lighting",
    );
  });
  it("rejects truncated provider answers and never retries itself", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(envelope(accepted(), "incomplete")),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(reviewStorefrontPlacement(input())).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("refuses a request without enough remaining time and refuses a late answer", async () => {
    const fetcher = vi.fn(async () => Response.json(envelope(accepted())));
    vi.stubGlobal("fetch", fetcher);
    await expect(
      reviewStorefrontPlacement({ ...input(), deadlineMs: Date.now() + 1000 }),
    ).rejects.toThrow(/Temps insuffisant/);
    expect(fetcher).not.toHaveBeenCalled();
    const originalNow = Date.now;
    const start = originalNow();
    fetcher.mockImplementation(async () => {
      vi.spyOn(Date, "now").mockReturnValue(start + 181_000);
      return Response.json(envelope(accepted()));
    });
    try {
      await expect(
        reviewStorefrontPlacement({ ...input(), deadlineMs: start + 180_000 }),
      ).rejects.toThrow(/délai/);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
