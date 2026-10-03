import { describe, expect, it } from "vitest";
import {
  readStorefrontDraft,
  saveStorefrontDraft,
  storefrontDraftKey,
  type StorefrontVisualizationDraft,
} from "../lib/storefront-visualization-draft";

const productId = "11111111-1111-4111-8111-111111111111";
const sceneId = "22222222-2222-4222-8222-222222222222";
const renderId = "33333333-3333-4333-8333-333333333333";
const point = { x: 0.5, y: 0.7 };
const body = JSON.stringify({
  engine: "legacy",
  workflow: "simple_point",
  mode: "insert",
  placement: {
    sceneId,
    productId,
    mode: "insert",
    surfaceType: "tabletop",
    xNormalized: 0.5,
    yNormalized: 0.7,
  },
  simplePlacements: [
    {
      productId,
      placementPoint: point,
      dimensionPair: { mode: "height_length", heightCm: 30, lengthCm: 20 },
      placementKind: "standing",
    },
  ],
  placementPoint: point,
  surfaceType: "tabletop",
  outputQuality: "final",
  preserveBackground: true,
  idempotencyKey: "44444444-4444-4444-8444-444444444444",
});
const draft = (
  extra: Partial<StorefrontVisualizationDraft> = {},
): StorefrontVisualizationDraft => ({
  version: 1,
  savedAt: 1000,
  productIds: [productId],
  sceneId,
  points: [point],
  referenceBase: null,
  referenceTop: null,
  referenceHeight: "",
  sameDepth: false,
  referenceReady: true,
  useMeasurement: false,
  replaceExisting: false,
  ...extra,
});
const storage = () => {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
    removeItem: (key: string) => {
      items.delete(key);
    },
  };
};

describe("storefront reload recovery", () => {
  it("keeps the exact uncertain submission and key across reload without storing credentials or photo bytes", () => {
    const tab = storage();
    expect(saveStorefrontDraft(tab, draft({ pendingBody: body }))).toBe(true);
    expect(readStorefrontDraft(tab, [productId], 1001)?.pendingBody).toBe(body);
    expect(tab.getItem(storefrontDraftKey([productId]))).not.toMatch(
      /accessToken|imageUrl|data:image|resultUrl/,
    );
  });
  it("replaces a pending request with its accepted identifier; a reload can perform GETs only", () => {
    const tab = storage();
    saveStorefrontDraft(tab, draft({ pendingBody: body }));
    saveStorefrontDraft(tab, draft({ renderId }));
    expect(readStorefrontDraft(tab, [productId], 1001)).toMatchObject({
      renderId,
      sceneId,
      points: [point],
    });
    expect(
      readStorefrontDraft(tab, [productId], 1001)?.pendingBody,
    ).toBeUndefined();
  });
  it("refuses duplicate or mismatched pending submissions", () => {
    const tab = storage();
    expect(
      saveStorefrontDraft(tab, draft({ renderId, pendingBody: body })),
    ).toBe(false);
    expect(
      saveStorefrontDraft(
        tab,
        draft({ pendingBody: body.replace(sceneId, renderId) }),
      ),
    ).toBe(false);
    expect(
      saveStorefrontDraft(
        tab,
        draft({ pendingBody: body.replace('"idempotencyKey"', '"unused"') }),
      ),
    ).toBe(false);
    expect(saveStorefrontDraft(tab, draft({ points: [] }))).toBe(false);
  });
  it("expires old identifiers and never restores a different product selection", () => {
    const tab = storage();
    saveStorefrontDraft(tab, draft({ renderId }));
    expect(readStorefrontDraft(tab, [sceneId], 1001)).toBeNull();
    expect(
      readStorefrontDraft(tab, [productId], 1000 + 24 * 60 * 60 * 1000 + 1),
    ).toBeNull();
    expect(tab.getItem(storefrontDraftKey([productId]))).toBeNull();
  });
  it("degrades safely for broken or disabled browser storage", () => {
    const tab = storage();
    tab.setItem(storefrontDraftKey([productId]), "broken");
    expect(readStorefrontDraft(tab, [productId], 1001)).toBeNull();
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    };
    expect(readStorefrontDraft(blocked, [productId])).toBeNull();
    expect(saveStorefrontDraft(blocked, draft())).toBe(false);
  });
});
