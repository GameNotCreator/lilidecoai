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
import { SPATIAL_REVIEW_EXECUTION_POLICY as reviewPolicy } from "../lib/server/spatial-review-policy";
import { visionObservation } from "../lib/server/ai/openai-vision-cost";
import { SPATIAL_VOLUME_NUMERIC_REPAIR_POLICY as numericPolicy } from "../lib/server/spatial-volume-repair";

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

it.each(["accepted", "malformed", "incomplete"])(
  "preserves paid review usage for %s responses",
  async (mode) => {
    const raw = {
      ...envelope(mode === "malformed" ? {} : renderPayload()),
      ...(mode === "incomplete" ? { status: "incomplete" } : {}),
      usage: { input_tokens: 1000, output_tokens: 500 },
      model: "gpt-6-astra",
      service_tier: "default",
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(raw, { headers: { "x-request-id": "req-test" } }),
        ),
    );
    let result: unknown;
    try {
      result = await reviewVisualRender({ ...input(), generated: image });
    } catch (reason) {
      result = reason;
    }
    expect(visionObservation(result)).toMatchObject({
      usage: raw.usage,
      requestId: "req-test",
      serviceTier: "default",
    });
    if (mode === "accepted")
      expect(JSON.stringify(result)).not.toContain("input_tokens");
    else expect(result).toBeInstanceOf(Error);
  },
);

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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("independent visual delivery gates", () => {
  const spatialProduct = (): VisualProductReference => ({
    id: "placement-1",
    name: "Cylindre",
    image,
    expectedBox: {
      xMin: 0.28604774184791426,
      xMax: 0.7139522581520857,
      yMin: 0.43562429978857115,
      yMax: 0.894710061620633,
    },
    expectedGeometry: { kind: "volume-envelope", contact: { x: 0.5, y: 0.75 } },
    scaleVerified: false,
  });
  const cylinderPayload = () => {
    const payload = renderPayload();
    return {
      ...payload,
      products: [
        {
          ...payload.products[0]!,
          observedBox: {
            xMin: 0.34678944457649263,
            xMax: 0.6532105554235074,
            yMin: 0.4504959096240219,
            yMax: 0.8453297905925947,
          },
          observedContact: { x: 0.5, y: 0.75 } as {
            x: number;
            y: number;
          } | null,
        },
      ],
    };
  };
  it.each(["accepted", "oversized", "contact-missing", "unlocalized"])(
    "retains validated observations only with v13 opt-in, without changing %s QA",
    (mode) => {
      const product = spatialProduct(),
        payload = cylinderPayload();
      if (mode === "oversized") payload.products[0]!.observedBox.xMin = 0.1;
      if (mode === "contact-missing")
        payload.products[0]!.observedContact = null;
      if (mode === "unlocalized")
        (payload.products[0] as { observedBox: unknown }).observedBox = null;
      const historical = parseVisualRender(payload, [product], false);
      const { geometryObservations, ...current } = parseVisualRender(
        payload,
        [product],
        false,
        numericPolicy,
      );
      expect(current).toEqual(historical);
      expect(historical).not.toHaveProperty("geometryObservations");
      expect(qualityDecision(current, false)).toEqual(
        qualityDecision(historical, false),
      );
      expect(current.accepted).toBe(mode === "accepted");
      expect(geometryObservations).toEqual({
        policy: numericPolicy,
        source: "validated-visual-review",
        coordinateSpace: "normalized-original-room",
        reviewConfidence: payload.confidence,
        products: [
          {
            productId: product.id,
            confidence: payload.products[0]!.confidence,
            foregroundOccluded: false,
            expectedBox: product.expectedBox,
            expectedContact: product.expectedGeometry!.contact,
            observedBox: payload.products[0]!.observedBox,
            observedContact: payload.products[0]!.observedContact,
          },
        ],
      });
      expect(JSON.parse(JSON.stringify(geometryObservations))).toEqual(
        geometryObservations,
      );
    },
  );
  it("keeps the inspector request and thresholds identical when opting into numeric observation persistence", async () => {
    const fetch = vi
      .fn()
      .mockImplementation(async () =>
        Response.json(envelope(cylinderPayload())),
      );
    vi.stubGlobal("fetch", fetch);
    const request = {
      ...input(),
      products: [spatialProduct()],
      generated: image,
    };
    await reviewVisualRender(request);
    const current = await reviewVisualRender({
      ...request,
      geometryObservationPolicy: numericPolicy,
    });
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual(
      JSON.parse(fetch.mock.calls[0]![1].body),
    );
    expect(current.geometryObservations?.policy).toBe(numericPolicy);
  });
  it.each(["unknown-policy", "silhouette", "invalid-contact", "invalid-box"])(
    "rejects invalid numeric review contract %s before contacting the provider",
    async (kind) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const request: VisualReviewInput & { generated: typeof image } = {
        ...input(),
        products: [spatialProduct()],
        generated: image,
        geometryObservationPolicy: numericPolicy,
      };
      if (kind === "unknown-policy")
        (
          request as { geometryObservationPolicy: string }
        ).geometryObservationPolicy = "future-policy";
      if (kind === "silhouette") delete request.products[0]!.expectedGeometry;
      if (kind === "invalid-contact")
        request.products[0]!.expectedGeometry!.contact.x = 1.1;
      if (kind === "invalid-box") request.products[0]!.expectedBox!.xMin = 1;
      await expect(reviewVisualRender(request)).rejects.toMatchObject({
        code: "invalid_input",
        providerCalled: false,
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("rejects malformed provider boxes even when numeric persistence is requested", () => {
    const payload = cylinderPayload();
    payload.products[0]!.observedBox.xMin =
      payload.products[0]!.observedBox.xMax;
    expect(() =>
      parseVisualRender(payload, [spatialProduct()], false, numericPolicy),
    ).toThrow();
  });
  it("does not require the exact cylinder to fill a rotated cuboid, while keeping silhouette contracts strict", () => {
    const product = spatialProduct(),
      payload = cylinderPayload();
    expect(parseVisualRender(payload, [product], false).accepted).toBe(true);
    const old = renderPayload();
    old.products[0]!.observedBox = payload.products[0]!.observedBox;
    expect(
      parseVisualRender(
        old,
        [{ ...product, expectedGeometry: undefined }],
        false,
      ).checks,
    ).toContainEqual(
      expect.objectContaining({ name: "placement-1.geometry_scale", score: 0 }),
    );
  });
  it.each([
    "outside",
    "moved-contact",
    "missing-contact",
    "weak-scale",
    "weak-position",
    "weak-contact",
    "low-confidence",
  ])("refuses an envelope with %s despite top-level acceptance", (reason) => {
    const payload = cylinderPayload(),
      item = payload.products[0]!;
    if (reason === "outside") item.observedBox.xMin = 0.1;
    if (reason === "moved-contact") item.observedContact = { x: 0.7, y: 0.75 };
    if (reason === "missing-contact") item.observedContact = null;
    if (reason === "weak-scale") item.checks.scale.score = 0.85;
    if (reason === "weak-position") item.checks.position.score = 0.85;
    if (reason === "weak-contact") item.checks.contact.score = 0.85;
    if (reason === "low-confidence") item.confidence = 0.85;
    expect(parseVisualRender(payload, [spatialProduct()], false).accepted).toBe(
      false,
    );
  });
  it("requests the observed contact in a strict schema only for the new spatial contract", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json(envelope(cylinderPayload())));
    vi.stubGlobal("fetch", fetch);
    await reviewVisualRender({
      ...input(),
      products: [spatialProduct()],
      generated: image,
    });
    const body = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(
      body.text.format.schema.properties.products.items.required,
    ).toContain("observedContact");
    expect(JSON.stringify(body.input)).toContain("volume-envelope");
  });
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
  it("labels additional views as evidence for the same placement", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json(envelope(renderPayload())));
    vi.stubGlobal("fetch", fetchMock);
    await reviewVisualRender({
      ...input(),
      generated: image,
      products: [{ ...products[0]!, views: [{ view: "top", image }] }],
    });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    const content = body.input[1].content as Array<{
      type: string;
      text?: string;
    }>;
    expect(content.filter((item) => item.type === "input_image")).toHaveLength(
      5,
    );
    expect(
      content.some((item) =>
        item.text?.includes(
          'ADDITIONAL CATALOG VIEW "top" for the SAME placement "placement-1"',
        ),
      ),
    ).toBe(true);
  });
  it.each([undefined, reviewPolicy.version])(
    "sends unchanged original images and strict settings (%s)",
    async (executionPolicy) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify(envelope(renderPayload()))),
        );
      vi.stubGlobal("fetch", fetchMock);
      expect(
        (
          await reviewVisualRender({
            ...input(),
            generated: image,
            executionPolicy,
          })
        ).accepted,
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
      expect(body.max_output_tokens).toBe(13_000);
      expect(
        body.input[1].content.filter(
          (item: { type: string }) => item.type === "input_image",
        ),
      ).toEqual(
        Array.from({ length: 4 }, () => ({
          type: "input_image",
          detail: "original",
          image_url: "data:image/png;base64,AQID",
        })),
      );
      const content = body.input[1].content as Array<{
        type: string;
        text?: string;
      }>;
      expect(
        content.filter((item) => item.type === "input_image"),
      ).toHaveLength(4);
      expect(
        content.some((item) => item.text?.startsWith("EXPECTED COMPOSITION")),
      ).toBe(true);
      expect(
        content.some((item) => item.text?.startsWith("FINAL RENDER")),
      ).toBe(true);
    },
  );

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

  it("caps preflight timeout at 45s and within the remaining deadline", async () => {
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

  it("allows final inspection 150s but never extends the render deadline or retries", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(envelope(renderPayload()))),
    );
    vi.stubGlobal("fetch", fetchMock);
    await reviewVisualRender({ ...input(), generated: image, deadlineMs: Date.now() + 180_000 });
    expect(timeout.mock.calls[0]?.[0]).toBe(150_000);
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockResolvedValue(new Response(JSON.stringify(envelope(renderPayload()))));
    await reviewVisualRender({ ...input(), generated: image, deadlineMs: Date.now() + 10_000 });
    expect(timeout.mock.calls[1]?.[0]).toBeLessThanOrEqual(9_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    timeout.mockRestore();
  });

  it("accepts a final response after 120s without retrying or changing acceptance gates", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
      setTimeout(() => resolve(new Response(JSON.stringify(envelope(renderPayload())))), 120_000);
    }));
    vi.stubGlobal("fetch", fetchMock);
    const result = expect(reviewVisualRender({
      ...input(), generated: image, deadlineMs: Date.now() + 180_000,
    })).resolves.toMatchObject({ accepted: true });
    await vi.advanceTimersByTimeAsync(120_000);
    await result;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(AbortSignal.timeout).toHaveBeenCalledWith(150_000);
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

describe("spatial review execution limits", () => {
  function spatialInput() {
    return {
      ...input(),
      generated: image,
      deadlineMs: Date.now() + 180_000,
      executionPolicy: reviewPolicy.version,
    };
  }
  it("allows a 60-second response with the same acceptance gates", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException("Timed out", "TimeoutError")),
        ms,
      );
      return controller.signal;
    });
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          init.signal!.addEventListener("abort", () =>
            reject(init.signal!.reason),
          );
          setTimeout(
            () =>
              resolve(new Response(JSON.stringify(envelope(renderPayload())))),
            60_000,
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = expect(
      reviewVisualRender(spatialInput()),
    ).resolves.toMatchObject({ accepted: true });
    await vi.advanceTimersByTimeAsync(60_000);
    await result;
    expect(AbortSignal.timeout).toHaveBeenCalledWith(90_000);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("caps a review by the job deadline and refuses a budget below 30 seconds", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi
      .fn()
      .mockImplementation(
        async () => new Response(JSON.stringify(envelope(renderPayload()))),
      );
    vi.stubGlobal("fetch", fetchMock);
    await reviewVisualRender({
      ...spatialInput(),
      deadlineMs: Date.now() + 40_000,
    });
    expect(timeout).toHaveBeenCalledWith(39_000);
    await expect(
      reviewVisualRender({
        ...spatialInput(),
        deadlineMs: Date.now() + 30_999,
      }),
    ).rejects.toMatchObject({
      code: "deadline",
      retryable: false,
      providerCalled: false,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("rechecks the deadline after encoding original images", async () => {
    vi.useFakeTimers();
    const stringify = JSON.stringify;
    vi.spyOn(JSON, "stringify").mockImplementationOnce((value) => {
      vi.setSystemTime(Date.now() + 31_000);
      return stringify(value);
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      reviewVisualRender({
        ...spatialInput(),
        deadlineMs: Date.now() + 60_000,
      }),
    ).rejects.toMatchObject({ code: "deadline", providerCalled: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["headers", "body"])(
    "refuses a late successful response at the %s phase",
    async (phase) => {
      vi.useFakeTimers();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          if (phase === "headers") vi.setSystemTime(Date.now() + 90_000);
          return {
            ok: true,
            json: async () => {
              if (phase === "body") vi.setSystemTime(Date.now() + 90_000);
              return envelope(renderPayload());
            },
          };
        }),
      );
      await expect(reviewVisualRender(spatialInput())).rejects.toMatchObject({
        code: "timeout",
        retryable: true,
        providerCalled: true,
      });
    },
  );
  it("aborts an unresponsive provider at 90 seconds without a local retry", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException("Timed out", "TimeoutError")),
        ms,
      );
      return controller.signal;
    });
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener("abort", () =>
            reject(init.signal!.reason),
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = expect(
      reviewVisualRender(spatialInput()),
    ).rejects.toMatchObject({
      code: "timeout",
      retryable: true,
      providerCalled: true,
    });
    await vi.advanceTimersByTimeAsync(90_000);
    await result;
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("treats a malformed JSON response as a terminal review failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json")));
    await expect(reviewVisualRender(spatialInput())).rejects.toMatchObject({
      code: "invalid_review",
      retryable: false,
      providerCalled: true,
    });
  });
});
