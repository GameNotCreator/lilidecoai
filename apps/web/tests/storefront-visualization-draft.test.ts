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

it("restores a four-point plane and a separate deletion region without a known height", () => {
  const tab = storage();
  const plane: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }] =
    [{ x: 0.2, y: 0.4 }, { x: 0.8, y: 0.4 }, { x: 0.95, y: 0.9 }, { x: 0.05, y: 0.9 }];
  const saved = draft({
    manualPlacements: [{ box: { xMin: 0.2, yMin: 0.2, xMax: 0.8, yMax: 0.8 }, plane }],
    planeCorners: [plane], replaceExisting: true, replacementConfirmed: true,
    replacementRegion: { xMin: 0.8, yMin: 0.1, xMax: 0.95, yMax: 0.3 },
  });
  expect(saveStorefrontDraft(tab, saved)).toBe(true);
  expect(readStorefrontDraft(tab, [productId], 1000)).toEqual(saved);
});

it("rejects a persisted manual placement whose plane crosses itself", () => {
  const tab = storage();
  expect(saveStorefrontDraft(tab, draft({ manualPlacements: [{
    box: { xMin: 0.2, yMin: 0.2, xMax: 0.8, yMax: 0.8 },
    plane: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.9, y: 0.1 }, { x: 0.1, y: 0.9 }],
  }] }))).toBe(false);
});

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


describe("visual size and explicit replacement draft", () => {
  it("restores old version-one drafts without requiring new fields", () => {
    const tab = storage();
    tab.setItem(storefrontDraftKey([productId]), JSON.stringify(draft()));
    expect(readStorefrontDraft(tab, [productId], 1001)?.points).toEqual([point]);
  });
  it("keeps chosen size and confirmed box after a reload without photo bytes", () => {
    const tab = storage();
    const region = { xMin: 0.3, yMin: 0.3, xMax: 0.7, yMax: 0.8 };
    expect(saveStorefrontDraft(tab, draft({ visualWidths: [0.24], replaceExisting: true, replacementRegion: region, replacementConfirmed: true }))).toBe(true);
    expect(readStorefrontDraft(tab, [productId], 1001)).toMatchObject({ visualWidths: [0.24], replacementRegion: region, replacementConfirmed: true });
    expect(tab.getItem(storefrontDraftKey([productId]))).not.toMatch(/data:image|imageUrl|accessToken/);
  });
  it("refuses a confirmed box without replacement and mismatched size counts", () => {
    const tab = storage();
    const region = { xMin: 0.3, yMin: 0.3, xMax: 0.7, yMax: 0.8 };
    expect(saveStorefrontDraft(tab, draft({ replacementRegion: region, replacementConfirmed: true }))).toBe(false);
    expect(saveStorefrontDraft(tab, draft({ visualWidths: [0.2, 0.3] }))).toBe(false);
    expect(saveStorefrontDraft(tab, draft({ visualWidths: [0.9] }))).toBe(false);
  });
});
