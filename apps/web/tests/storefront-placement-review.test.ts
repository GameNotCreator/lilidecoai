import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const config = vi.hoisted(() => ({
    openaiApiKey: "test-only",
    aiMockMode: false,
    openaiVisionModel: "gpt-6-astra",
    openaiServiceTier: "default",
    openaiBaseUrl: "https://invalid.test/v1",
}));
vi.mock("../lib/server/config", () => ({ serverConfig: config }));
import {
  parseStorefrontPlacementReview,
  reviewStorefrontPlacement,
  storefrontPlacementReviewAllowance,
  STOREFRONT_PLACEMENT_REVIEW_VERSION,
  STOREFRONT_REALISTIC_PLACEMENT_REVIEW_VERSION,
  type StorefrontScaleReference,
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
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  config.openaiApiKey = "test-only";
  config.aiMockMode = false;
});

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

const realisticProduct = {
  ...product,
  dimensionsCm: { width: 40, height: 40, depth: 40 },
  placementKind: "standing" as const,
  placementPoint: { x: 0.5, y: 0.6 },
};
const measuredReference: StorefrontScaleReference = {
  realHeightCm: 75,
  basePoint: { x: 0.15, y: 0.8 },
  topPoint: { x: 0.15, y: 0.45 },
  sameDepthConfirmed: true,
};
const realisticInput = () => ({
  ...input(),
  realism: true,
  products: [realisticProduct],
});
function realisticAccepted(withReference = false) {
  const data = accepted();
  return {
    ...data,
    products: data.products.map((entry) => ({
      ...entry,
      observedContact: { ...realisticProduct.placementPoint },
      checks: {
        ...entry.checks,
        gravity: pass(),
        silhouetteComplete: pass(),
        photographicCoherence: pass(),
        referenceScale: withReference ? pass() : null,
      },
    })),
  };
}

describe("storefront photographic placement qualification", () => {
  it("accepts a corrected pose and box only when the actual placement anchor stays fixed", () => {
    const data = realisticAccepted();
    data.products[0]!.observedBox = {
      xMin: 0.34, yMin: 0.14, xMax: 0.66, yMax: 0.6,
    };
    const decision = parseStorefrontPlacementReview(data, [realisticProduct], { realism: true });
    expect(decision).toMatchObject({ status: "accepted", version: STOREFRONT_REALISTIC_PLACEMENT_REVIEW_VERSION });
    expect(decision.checks.some((check) => check.name.endsWith("geometry_scale"))).toBe(false);
    expect(decision.feedback).toContain("sans référence mesurée");
    expect(parseStorefrontPlacementReview(accepted(), [product]).version).toBe(STOREFRONT_PLACEMENT_REVIEW_VERSION);
  });

  it.each(["perspective", "gravity", "photographicCoherence", "silhouetteComplete", "identity"] as const)(
    "rejects %s defects despite a matching planned box and claimed acceptance", (name) => {
      const data = realisticAccepted();
      data.products[0]!.checks[name] = {
        passed: false, score: 0.95,
        reason: name === "perspective" ? "Vue catalogue frontale incompatible avec la pièce plongeante." : "Défaut visible dans le résultat.",
      };
      expect(parseStorefrontPlacementReview(data, [realisticProduct], { realism: true }).status).toBe("rejected");
    },
  );

  it("rejects a measured-scale contradiction even when the box exactly matches the initial estimate", () => {
    const data = realisticAccepted(true);
    data.products[0]!.checks.referenceScale = {
      passed: false, score: 0.95,
      reason: "Le panier de 40 cm dépasse la référence verticale de 75 cm au même niveau.",
    };
    const decision = parseStorefrontPlacementReview(data, [realisticProduct], { realism: true, scaleReference: measuredReference });
    expect(decision.status).toBe("rejected");
    expect(decision.checks.find((check) => check.name.endsWith("referenceScale"))?.score).toBeLessThan(0.8);
  });

  it("does not allow an omitted reference check to claim calibrated scale", () => {
    const data = realisticAccepted();
    expect(parseStorefrontPlacementReview(data, [realisticProduct], { realism: true, scaleReference: measuredReference }).status).toBe("rejected");
    const missing = realisticAccepted(true);
    delete (missing.products[0]!.checks as Partial<typeof missing.products[0]["checks"]>).referenceScale;
    expect(() => parseStorefrontPlacementReview(missing, [realisticProduct], { realism: true, scaleReference: measuredReference })).toThrow();
  });

  it("reports a reference comparison without promising an exact metric measurement", () => {
    const decision = parseStorefrontPlacementReview(realisticAccepted(true), [realisticProduct], { realism: true, scaleReference: measuredReference });
    expect(decision.status).toBe("accepted");
    expect(decision.feedback).toContain("cohérente avec votre référence");
    expect(decision.feedback).toContain("pas une mesure garantie");
    expect(parseStorefrontPlacementReview(realisticAccepted(true), [realisticProduct], { realism: true }).status).toBe("rejected");
  });

  it("rejects a moved base and an invented contact outside the visible silhouette", () => {
    const moved = realisticAccepted();
    moved.products[0]!.observedContact.x = 0.6;
    expect(parseStorefrontPlacementReview(moved, [realisticProduct], { realism: true }).status).toBe("rejected");
    const falseContact = realisticAccepted();
    falseContact.products[0]!.observedBox = { xMin: 0.1, yMin: 0.1, xMax: 0.3, yMax: 0.3 };
    expect(parseStorefrontPlacementReview(falseContact, [realisticProduct], { realism: true }).status).toBe("rejected");
    const missingContact = realisticAccepted();
    Object.assign(missingContact.products[0]!, { observedContact: null });
    expect(parseStorefrontPlacementReview(missingContact, [realisticProduct], { realism: true }).status).toBe("rejected");
  });

  it("uses a centre anchor for flat and wall products instead of pretending their base is on a floor", () => {
    const data = realisticAccepted();
    const centred = { ...realisticProduct, placementKind: "wall" as const, placementPoint: { x: 0.5, y: 0.45 } };
    data.products[0]!.observedContact = { x: 0.5, y: 0.6 };
    expect(parseStorefrontPlacementReview(data, [centred], { realism: true }).status).toBe("accepted");
    expect(parseStorefrontPlacementReview(data, [{ ...centred, placementKind: "flat" }], { realism: true }).status).toBe("accepted");
  });

  it("rejects old schemas and missing photographic evidence instead of silently falling back to preview qualification", () => {
    expect(() => parseStorefrontPlacementReview(accepted(), [realisticProduct], { realism: true })).toThrow();
    const missing = realisticAccepted();
    delete (missing.products[0]!.checks as Partial<typeof missing.products[0]["checks"]>).silhouetteComplete;
    expect(() => parseStorefrontPlacementReview(missing, [realisticProduct], { realism: true })).toThrow();
  });

  it("requires distinct complete placement IDs in photographic mode too", () => {
    const data = realisticAccepted();
    data.products.push({ ...data.products[0]! });
    expect(() => parseStorefrontPlacementReview(data, [realisticProduct, { ...realisticProduct, id: "p1:1" }], { realism: true })).toThrow(/exactement/);
  });

  it("sends one photographic review capped at30s with authoritative dimensions and the measured reference", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetcher = vi.fn<typeof globalThis.fetch>(async () => Response.json(envelope(realisticAccepted(true))));
    vi.stubGlobal("fetch", fetcher);
    const decision = await reviewStorefrontPlacement({ ...realisticInput(), scaleReference: measuredReference });
    expect(decision.status).toBe("accepted");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(timeout).toHaveBeenCalledWith(30_000);
    const request = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(request.text.format.name).toBe("storefront_realistic_placement_review");
    expect(request.max_output_tokens).toBe(6000);
    expect(request.input[0].content[0].text).toContain("camera elevation, pitch, yaw");
    expect(request.input[0].content[0].text).toContain("printed text and distinctive motif");
    expect(request.input[0].content[0].text).not.toContain("Do not assess");
    expect(request.input[1].content[0].text).toContain(JSON.stringify(measuredReference));
    expect(request.input[1].content[0].text).toContain('"height":40');
  });

  it.each([
    { ...measuredReference, realHeightCm: 0 },
    { ...measuredReference, topPoint: measuredReference.basePoint },
    { ...measuredReference, sameDepthConfirmed: false },
    { ...measuredReference, topPoint: { x: 1.2, y: 0.45 } },
  ])("rejects an invalid reference before any provider call", async (reference) => {
    const fetcher = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetcher);
    await expect(reviewStorefrontPlacement({ ...realisticInput(), scaleReference: reference as StorefrontScaleReference })).rejects.toThrow(/Référence/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses a reference without product dimensions before spending", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetcher);
    await expect(reviewStorefrontPlacement({ ...realisticInput(), products: [product], scaleReference: measuredReference })).rejects.toThrow(/Dimensions/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses invalid placement contracts before spending on a photographic review", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetcher);
    await expect(reviewStorefrontPlacement({
      ...realisticInput(),
      products: [{ ...realisticProduct, expectedBox: undefined }],
    })).rejects.toThrow(/Contrat/);
    await expect(reviewStorefrontPlacement({
      ...realisticInput(),
      products: [{ ...realisticProduct, placementPoint: { x: 2, y: 0.6 } }],
    })).rejects.toThrow(/Ancrage/);
    await expect(reviewStorefrontPlacement({
      ...realisticInput(),
      products: [{ ...realisticProduct, dimensionsCm: { width: 0, height: 40, depth: 40 } }],
    })).rejects.toThrow(/Dimensions/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a photographic answer after30s even if a provider ignores its abort signal", async () => {
    const start = Date.now();
    const fetcher = vi.fn<typeof globalThis.fetch>(async () => {
      vi.spyOn(Date, "now").mockReturnValue(start + 31_000);
      return Response.json(envelope(realisticAccepted()));
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(reviewStorefrontPlacement({ ...realisticInput(), deadlineMs: start + 180_000 })).rejects.toThrow(/délai/);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("never accepts unavailable, truncated or omitted photographic provider evidence", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>(async () => Response.json({}, { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(reviewStorefrontPlacement(realisticInput())).rejects.toThrow(/indisponible/);
    expect(fetcher).toHaveBeenCalledOnce();
    fetcher.mockClear();
    fetcher.mockImplementation(async () => Response.json(envelope(realisticAccepted(), "incomplete")));
    await expect(reviewStorefrontPlacement(realisticInput())).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
    fetcher.mockClear();
    fetcher.mockImplementation(async () => Response.json(envelope(accepted())));
    await expect(reviewStorefrontPlacement(realisticInput())).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not turn missing provider configuration into a photographic acceptance", async () => {
    config.openaiApiKey = "";
    const fetcher = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetcher);
    await expect(reviewStorefrontPlacement(realisticInput())).rejects.toThrow(/configuré/);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
