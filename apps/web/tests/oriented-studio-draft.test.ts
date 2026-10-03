import { describe, expect, it, vi } from "vitest";
import { orientedStudioDraftSchema } from "../lib/oriented-studio-draft";
vi.mock("server-only", () => ({}));
import { renderResponse } from "../lib/server/serializers";
import type { RenderDocument } from "../lib/server/types";

function draft() {
  return {
    productId: "11111111-1111-4111-8111-111111111111",
    variantId: "",
    surfaceType: "tabletop",
    scene: {
      id: "22222222-2222-4222-8222-222222222222",
      imageUrl: "/api/assets/private-room",
      expiresAt: "2026-10-04T00:00:00.000Z",
    },
    point: { x: 0.4, y: 0.7 },
    requestKey: "pending-request",
    preview: {
      previewUrl: "/api/assets/private-preview",
      planFingerprint: "e".repeat(64),
      reconstructed: true,
      limitations: ["Estimated scale"],
      unknownFaces: ["Back"],
    },
    job: {
      id: "33333333-3333-4333-8333-333333333333",
      status: "queued",
      resultUrl: null,
      qualityDecision: null,
    },
  };
}

describe("oriented studio saved draft boundaries", () => {
  it("retains the point, request key and private assets for recovery", () => {
    expect(orientedStudioDraftSchema.parse(draft())).toEqual(draft());
  });

  it.each(["queued", "processing", "succeeded"] as const)(
    "retains a %s API response with its nullable error across storage reload",
    (status) => {
      const job = renderResponse({
        id: draft().job.id,
        engine: "oriented",
        status,
        error: null,
        resultAssetId: status === "succeeded" ? "private-result" : null,
        createdAt: new Date("2026-10-03T00:00:00.000Z"),
      } as unknown as RenderDocument);
      const saved = JSON.parse(JSON.stringify({ ...draft(), job }));
      expect(saved.job.error).toBeNull();
      const restored = orientedStudioDraftSchema.parse(saved);
      expect(restored.requestKey).toBe(draft().requestKey);
      expect(restored.point).toEqual(draft().point);
      expect(restored.job).toMatchObject({ id: job.id, status, error: null });
    },
  );

  it.each([
    "https://example.test/image.png",
    "//example.test/image.png",
    "javascript:alert(1)",
    "/api/assets/../private",
    "/api/assets/private?token=secret",
    "/api/assets/",
  ])(
    "rejects scene and preview URLs outside the private asset route: %s",
    (url) => {
      const scene = draft();
      scene.scene.imageUrl = url;
      expect(orientedStudioDraftSchema.safeParse(scene).success).toBe(false);
      const preview = draft();
      preview.preview.previewUrl = url;
      expect(orientedStudioDraftSchema.safeParse(preview).success).toBe(false);
      expect(
        orientedStudioDraftSchema.safeParse({
          ...draft(),
          job: { ...draft().job, resultUrl: url },
        }).success,
      ).toBe(false);
    },
  );

  it.each([
    { point: { x: NaN, y: 0.5 } },
    { point: { x: 1.1, y: 0.5 } },
    {
      preview: {
        previewUrl: "/api/assets/private-preview",
        planFingerprint: "bad",
      },
    },
    { preview: { ...draft().preview, limitations: "not-an-array" } },
    { preview: { ...draft().preview, unknownFaces: [false] } },
    { scene: { ...draft().scene, expiresAt: "not-a-date" } },
    { job: { ...draft().job, status: "accepted-without-review" } },
  ])(
    "rejects malformed saved fields without handing partial objects to the component",
    (fields) => {
      expect(
        orientedStudioDraftSchema.safeParse({ ...draft(), ...fields }).success,
      ).toBe(false);
    },
  );
});
