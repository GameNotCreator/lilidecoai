import { describe, expect, it } from "vitest";
import {
  readSpatialDraft,
  saveSpatialDraft,
  spatialDraftKey,
  spatialInsertionSubmissionSchema,
} from "../lib/spatial-studio-draft";

const draft = {
  version: 3,
  savedAt: 1000,
  sceneId: "22222222-2222-4222-8222-222222222222",
  productId: "11111111-1111-4111-8111-111111111111",
  surface: "tabletop",
  point: { x: 0.5, y: 0.7 },
  yaw: 45,
  instructions: "",
};
function storage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}
describe("spatial studio tab recovery", () => {
  it("preserves a pending v2 submission and its key during migration", () => {
    const store = storage();
    const pendingRequest = spatialInsertionSubmissionSchema.parse({
      engine: "spatial",
      placement: { sceneId: draft.sceneId, productId: draft.productId },
      placementPoint: draft.point,
      idempotencyKey: "web-existing-key",
    });
    store.setItem(
      spatialDraftKey("scope"),
      JSON.stringify({ ...draft, version: 2, pendingRequest }),
    );
    expect(readSpatialDraft(store, "scope", 2000)).toEqual({
      ...draft,
      pendingRequest,
    });
  });
  it.each([1, 2])(
    "migrates a v%s placement without inventing a submission",
    (version) => {
      const store = storage();
      store.setItem(
        spatialDraftKey("scope"),
        JSON.stringify({ ...draft, version }),
      );
      expect(readSpatialDraft(store, "scope", 2000)).toEqual(draft);
    },
  );
  it("preserves the placement only within its account scope", () => {
    const store = storage();
    expect(saveSpatialDraft(store, "org:user", draft)).toBe(true);
    expect(readSpatialDraft(store, "org:user", 2000)).toEqual(draft);
    expect(readSpatialDraft(store, "org:other", 2000)).toBeNull();
    expect(readSpatialDraft(store, "other:user", 2000)).toBeNull();
  });
  it.each([
    "{bad",
    JSON.stringify({ ...draft, version: 4 }),
    JSON.stringify({ ...draft, point: { x: 3, y: 0.2 } }),
    JSON.stringify({ ...draft, imageUrl: "https://untrusted" }),
  ])("discards invalid stored input %s", (raw) => {
    const store = storage();
    store.setItem(spatialDraftKey("scope"), raw);
    expect(readSpatialDraft(store, "scope", 2000)).toBeNull();
    expect(store.getItem(spatialDraftKey("scope"))).toBeNull();
  });
  it.each([999, 1000 + 86400_001])(
    "expires future or stale drafts at %s",
    (now) => {
      const store = storage();
      saveSpatialDraft(store, "scope", draft);
      expect(readSpatialDraft(store, "scope", now)).toBeNull();
    },
  );
  it("does not crash or claim persistence when storage is unavailable", () => {
    const store = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("full");
      },
      removeItem() {
        throw new Error("blocked");
      },
    };
    expect(saveSpatialDraft(store, "scope", draft)).toBe(false);
    expect(readSpatialDraft(store, "scope", 2000)).toBeNull();
  });
});
