import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../lib/server/config", () => ({
  serverConfig: {
    openaiApiKey: "test-key",
    aiMockMode: false,
    openaiVisionModel: "gpt-6-astra",
    openaiServiceTier: "default",
    openaiBaseUrl: "https://api.openai.com/v1",
  },
}));

import {
  extractStructuredReview,
  inspectVisualPreflight,
  parseVisualPreflight,
  parseVisualRender,
  reviewVisualRender,
  type VisualProductReference,
  type VisualReviewInput,
} from "../lib/server/ai/visual-review";
import { qualityDecision } from "../lib/server/render-quality";
import { isProviderRefusal } from "../lib/server/provider-usage";

const image = {
  data: new Uint8Array([1, 2, 3]),
  mimeType: "image/png" as const,
};
const expectedBox = { xMin: 0.3, yMin: 0.4, xMax: 0.5, yMax: 0.7 };
const products: VisualProductReference[] = [
  { id: "placement-1", name: "Lampe", image, expectedBox },
];
const check = () => ({
  passed: true,
  score: 0.95,
  reason: "Conforme aux références visibles.",
});
function renderPayload() {
  return {
    accepted: true,
    score: 0.95,
    confidence: 0.95,
    backgroundPreserved: check(),
    replacementComplete: check(),
    noUnrequestedProducts: check(),
    products: [
      {
        id: "placement-1",
        confidence: 0.95,
        observedBox: { ...expectedBox },
        foregroundOccluded: false,
        checks: {
          present: check(),
          identity: check(),
          position: check(),
          scale: check(),
          perspective: check(),
          contact: check(),
          edges: check(),
          lightingAndShadows: check(),
          occlusion: check(),
          noDuplicate: check(),
        },
      },
    ],
    feedback: "Produit conforme, naturellement intégré à la scène.",
  };
}

function preflightPayload() {
  return {
    accepted: true,
    score: 0.95,
    confidence: 0.95,
    photoUsable: check(),
    products: [
      {
        id: "placement-1",
        confidence: 0.95,
        checks: {
          supportVisible: check(),
          placementFeasible: check(),
          scalePlausible: check(),
          sourceIdentityPreserved: check(),
          sourceCutoutComplete: check(),
        },
      },
    ],
    feedback: "Photo et placement exploitables.",
  };
}

function envelope(payload: unknown) {
  return {
    status: "completed",
    output: [
      {
        type: "message",
        status: "completed",
        content: [{ type: "output_text", text: JSON.stringify(payload) }],
      },
    ],
  };
}

function input(): VisualReviewInput {
  return {
    room: image,
    composition: image,
    products,
    replacement: false,
    deadlineMs: Date.now() + 60_000,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("independent visual delivery gates", () => {
  it("accepts a complete source-grounded review and records individual evidence", () => {
    const review = parseVisualRender(renderPayload(), products, false);
    expect(qualityDecision(review, false).status).toBe("accepted");
    expect(
      review.checks?.find((item) => item.name === "placement-1.edges"),
    ).toMatchObject({ score: 0.95 });
    expect(review.scaleCorrectionFactor).toBe(1);
  });

  it.each([
    "position",
    "scale",
    "identity",
    "edges",
    "contact",
    "lightingAndShadows",
    "occlusion",
    "present",
    "noDuplicate",
  ] as const)(
    "rejects a failed %s despite an optimistic top-level verdict",
    (name) => {
      const payload = renderPayload();
      payload.products[0]!.checks[name] = {
        passed: false,
        score: 0.99,
        reason: "Défaut visible à corriger ici.",
      };
      const review = parseVisualRender(payload, products, false);
      expect(qualityDecision(review, false).status).toBe("rejected");
      expect(review.repairFeedback).toContain(`placement-1.${name}`);
    },
  );

  it("rejects a shifted product even when every verbal check passes", () => {
    const payload = renderPayload();
    payload.products[0]!.observedBox = {
      xMin: 0.55,
      xMax: 0.75,
      yMin: 0.4,
      yMax: 0.7,
    };
    const review = parseVisualRender(payload, products, false);
    expect(review.scaleAndPerspectivePlausible).toBe(false);
    expect(review.repairFeedback).toContain("geometry_position");
    expect(qualityDecision(review, false).status).toBe("rejected");
  });

  it("rejects a larger product centered at the correct location", () => {
    const payload = renderPayload();
    payload.products[0]!.observedBox = {
      xMin: 0.25,
      xMax: 0.55,
      yMin: 0.325,
      yMax: 0.775,
    };
    expect(
      parseVisualRender(payload, products, false).repairFeedback,
    ).toContain("geometry_scale");
  });

  it("allows small visual localization noise", () => {
    const payload = renderPayload();
    payload.products[0]!.observedBox = {
      xMin: 0.305,
      xMax: 0.495,
      yMin: 0.405,
      yMax: 0.695,
    };
    expect(parseVisualRender(payload, products, false).accepted).toBe(true);
  });

  it("accepts verified foreground occlusion without requiring an invisible lower silhouette", () => {
    const payload = renderPayload();
    payload.products[0]!.foregroundOccluded = true;
    payload.products[0]!.observedBox = { ...expectedBox, yMax: 0.6 };
    payload.products[0]!.checks.occlusion.reason =
      "Le rebord de table d’origine masque le tiers inférieur du vase.";
    expect(parseVisualRender(payload, products, false).accepted).toBe(true);
  });

  it("does not treat a uniformly smaller or shifted object as foreground occlusion", () => {
    const payload = renderPayload();
    payload.products[0]!.foregroundOccluded = true;
    payload.products[0]!.observedBox = {
      xMin: 0.33,
      xMax: 0.47,
      yMin: 0.445,
      yMax: 0.655,
    };
    expect(parseVisualRender(payload, products, false).accepted).toBe(false);
    payload.products[0]!.observedBox = {
      ...expectedBox,
      xMin: 0.34,
      xMax: 0.54,
    };
    expect(parseVisualRender(payload, products, false).accepted).toBe(false);
  });

  it("requires stronger evidence when foreground occlusion changes the observed extent", () => {
    const payload = renderPayload();
    payload.products[0]!.foregroundOccluded = true;
    payload.products[0]!.observedBox = { ...expectedBox, yMax: 0.6 };
    payload.products[0]!.checks.occlusion.score = 0.85;
    const review = parseVisualRender(payload, products, false);
    expect(review.accepted).toBe(false);
    expect(review.repairFeedback).toContain("foreground_occlusion_evidence");
  });

  it("rejects low confidence for any product, without trusting overall confidence", () => {
    const payload = renderPayload();
    const second = structuredClone(payload.products[0]!);
    second.id = "placement-2";
    second.confidence = 0.5;
    payload.products.push(second);
    const review = parseVisualRender(
      payload,
      [...products, { ...products[0]!, id: "placement-2" }],
      false,
    );
    expect(review.accepted).toBe(false);
    expect(review.confidence).toBe(0.5);
    expect(review.repairFeedback).toContain("placement-2.confidence");
  });

  it("requires each placement exactly once, including repeated SKUs", () => {
    const payload = renderPayload();
    payload.products.push(structuredClone(payload.products[0]!));
    expect(() =>
      parseVisualRender(
        payload,
        [...products, { ...products[0]!, id: "placement-2" }],
        false,
      ),
    ).toThrow();
    expect(() =>
      parseVisualRender(
        renderPayload(),
        [...products, { ...products[0]!, id: "placement-2" }],
        false,
      ),
    ).toThrow();
  });

  it("fails closed on missing checks, malformed booleans and non-finite scores", () => {
    const missing = structuredClone(renderPayload()) as Record<string, unknown>;
    delete missing.backgroundPreserved;
    expect(() => parseVisualRender(missing, products, false)).toThrow();
    expect(() =>
      parseVisualRender(
        { ...renderPayload(), accepted: "true" },
        products,
        false,
      ),
    ).toThrow();
    expect(() =>
      parseVisualRender({ ...renderPayload(), score: NaN }, products, false),
    ).toThrow();
  });

  it("rejects unavailable silhouettes and invalid bounding boxes", () => {
    const payload = renderPayload();
    const withNull = {
      ...payload,
      products: [{ ...payload.products[0]!, observedBox: null }],
    };
    expect(
      parseVisualRender(withNull, products, false).allProductsPresent,
    ).toBe(false);
    payload.products[0]!.observedBox = {
      xMin: 0.5,
      xMax: 0.2,
      yMin: 0.4,
      yMax: 0.7,
    };
    expect(() => parseVisualRender(payload, products, false)).toThrow();
  });

  it("requires removal evidence only when replacing an existing target", () => {
    const payload = renderPayload();
    payload.replacementComplete = {
      passed: false,
      score: 0,
      reason: "Câble de l’ancien objet encore présent.",
    };
    expect(parseVisualRender(payload, products, false).accepted).toBe(true);
    expect(parseVisualRender(payload, products, true).accepted).toBe(false);
  });
});

describe("source preflight", () => {
  it("refuses a damaged cutout before image generation", () => {
    const payload = preflightPayload();
    payload.products[0]!.checks.sourceCutoutComplete = {
      passed: false,
      score: 0.4,
      reason: "Le pied droit a été effacé au détourage.",
    };
    const result = parseVisualPreflight(payload, products);
    expect(result.accepted).toBe(false);
    expect(result.repairFeedback).toContain("Le pied droit");
  });

  it("refuses unreadable room photos and uncertainty before generation", () => {
    const payload = preflightPayload();
    payload.photoUsable = {
      passed: false,
      score: 0.2,
      reason: "Le support est flou.",
    };
    expect(parseVisualPreflight(payload, products).accepted).toBe(false);
    expect(
      parseVisualPreflight({ ...preflightPayload(), confidence: 0.6 }, products)
        .accepted,
    ).toBe(false);
  });
});

describe("bounded Responses API transport", () => {
  it("sends labeled original room, composition, output and catalog images to a private strict review", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(envelope(renderPayload()))),
      );
    vi.stubGlobal("fetch", fetchMock);
    expect(
      (await reviewVisualRender({ ...input(), generated: image })).accepted,
    ).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body).toMatchObject({
      model: "gpt-6-astra",
      store: false,
      service_tier: "default",
      reasoning: { effort: "high" },
      text: { format: { strict: true, type: "json_schema" } },
    });
    expect(body.temperature).toBeUndefined();
    const content = body.input[1].content as Array<{
      type: string;
      text?: string;
    }>;
    expect(content.filter((item) => item.type === "input_image")).toHaveLength(
      4,
    );
    expect(
      content.some((item) => item.text?.startsWith("EXPECTED COMPOSITION")),
    ).toBe(true);
    expect(content.some((item) => item.text?.startsWith("FINAL RENDER"))).toBe(
      true,
    );
  });

  it("does not require a generated image for preflight", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(envelope(preflightPayload()))),
      );
    vi.stubGlobal("fetch", fetchMock);
    expect((await inspectVisualPreflight(input())).accepted).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(
      body.input[1].content.filter(
        (item: { type: string }) => item.type === "input_image",
      ),
    ).toHaveLength(3);
  });

  it("does not start a billable call after its deadline", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      inspectVisualPreflight({ ...input(), deadlineMs: Date.now() + 500 }),
    ).rejects.toMatchObject({ code: "deadline", providerCalled: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caps timeout at 45s and within the remaining deadline", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(envelope(preflightPayload()))),
      );
    vi.stubGlobal("fetch", fetchMock);
    await inspectVisualPreflight(input());
    expect(timeout.mock.calls[0]?.[0]).toBe(45_000);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(envelope(preflightPayload()))),
    );
    await inspectVisualPreflight({
      ...input(),
      deadlineMs: Date.now() + 10_000,
    });
    expect(timeout.mock.calls[1]?.[0]).toBeLessThanOrEqual(9_000);
    timeout.mockRestore();
  });

  it("reports provider failure without leaking response bodies or retrying", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("private vendor error", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(inspectVisualPreflight(input())).rejects.toMatchObject({
      code: "http_429",
      providerCalled: true,
      retryable: true,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([400, 401, 403, 429])(
    "marks an answered HTTP %s refusal as unbilled",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("refused", { status })),
      );
      const error = await inspectVisualPreflight(input()).catch(
        (reason: unknown) => reason,
      );
      expect(isProviderRefusal(error)).toBe(true);
    },
  );

  it.each([408, 500, 503])(
    "keeps ambiguous HTTP %s outcomes billable",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("unavailable", { status })),
      );
      const error = await inspectVisualPreflight(input()).catch(
        (reason: unknown) => reason,
      );
      expect(isProviderRefusal(error)).toBe(false);
    },
  );

  it.each(["incomplete", "failed", "cancelled", "in_progress"])(
    "rejects valid-looking JSON in %s responses",
    (status) => {
      expect(() =>
        extractStructuredReview({ ...envelope(renderPayload()), status }),
      ).toThrow();
    },
  );

  it("rejects a refusal even when an output text fragment is also present", () => {
    const payload = envelope(renderPayload());
    payload.output[0]!.content.push({ type: "refusal", text: "Refused." });
    expect(() => extractStructuredReview(payload)).toThrow(/refusé/);
  });

  it("does not extract partial, concatenated or malformed structured outputs", () => {
    const payload = envelope(renderPayload());
    payload.output[0]!.content.push({ type: "output_text", text: "{}" });
    expect(() => extractStructuredReview(payload)).toThrow();
    expect(() =>
      extractStructuredReview({
        ...envelope(renderPayload()),
        incomplete_details: { reason: "max_output_tokens" },
      }),
    ).toThrow();
  });
});
