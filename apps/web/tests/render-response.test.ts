import { BSON, MongoClient } from "mongodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSchema } from "@lili/types";

vi.mock("../lib/server/assets", () => ({
  assetUrl: (id?: string) => (id ? `/api/assets/${id}` : null),
}));

import { getRender, InvalidApiResponseError } from "../lib/api";
import { renderResponse, STOREFRONT_BUDGET_UNAVAILABLE_MESSAGE } from "../lib/server/serializers";
import type { RenderDocument } from "../lib/server/types";

afterEach(() => vi.unstubAllGlobals());

function admittedRender(status: RenderDocument["status"]): RenderDocument {
  const createdAt = new Date("2026-09-30T09:24:52Z");
  return {
    engine: "legacy",
    id: "6b2cd6f8-3766-478f-8b11-0af4ffba1c81",
    organizationId: "00000000-0000-4000-8000-000000000001",
    sceneId: "00000000-0000-4000-8000-000000000003",
    productId: "00000000-0000-4000-8000-000000000004",
    publicSessionId: "storefront:test-session",
    idempotencyKey: "storefront:regression",
    status,
    pipelineState: status === "succeeded" ? "completed" : "uploaded",
    mode: "insert",
    outputQuality: "final",
    // Admission explicitly sets this key even when no support is specified.
    surfaceType: undefined,
    placementPoint: { x: 0.62, y: 0.9 },
    provider: null,
    model: null,
    requestedSize: "1024x1536",
    qualityScore: null,
    creditCharged: false,
    placement: { pipelineStage: "estimating_scale" },
    ...(status === "succeeded"
      ? { resultAssetId: "00000000-0000-4000-8000-000000000005" }
      : {}),
    createdAt,
    updatedAt: createdAt,
  };
}

// Resolve the same default codec options as our MongoClient, without connecting.
const mongoBsonOptions = new MongoClient("mongodb://127.0.0.1:27017")
  .db("render-response-test")
  .collection("renders").bsonOptions;

/** MongoDB's BSON codec turns an explicitly undefined property into null. */
function persistedRender(render: RenderDocument): RenderDocument {
  return BSON.deserialize(BSON.serialize(render, mongoBsonOptions)) as RenderDocument;
}

describe("render response contract after MongoDB storage", () => {
  it.each(["queued", "processing", "succeeded", "failed", "cancelled", "deleted"] as const)(
    "keeps the admitted %s response readable after a BSON round trip",
    async (status) => {
      const admitted = admittedRender(status);
      expect(Object.hasOwn(admitted, "surfaceType")).toBe(true);
      expect(admitted.surfaceType).toBeUndefined();
      const postPayload = await Response.json(renderResponse(admitted)).json();
      expect(renderSchema.safeParse(postPayload).success).toBe(true);

      const stored = persistedRender(admitted);
      expect(stored.surfaceType).toBeNull();
      const getPayload = await Response.json(renderResponse(stored)).json();
      expect(getPayload).not.toHaveProperty("surfaceType");
      expect(getPayload).not.toHaveProperty("publicSessionId");
      expect(getPayload).not.toHaveProperty("organizationId");
      const fetch = vi.fn().mockResolvedValue(Response.json(getPayload));
      vi.stubGlobal("fetch", fetch);
      await expect(getRender(admitted.id)).resolves.toMatchObject({
        id: admitted.id,
        status,
        qualityScore: null,
      });
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("preserves an explicitly selected surface", async () => {
    const stored = persistedRender({
      ...admittedRender("processing"),
      surfaceType: "rug_zone",
    });
    const payload = await Response.json(renderResponse(stored)).json();
    expect(renderSchema.parse(payload).surfaceType).toBe("rug_zone");
  });

  it("gives storefront visitors an available action after an occupied placement", () => {
    const error = "Cet emplacement est occupé. Déplacez le point sur une zone libre, ou utilisez le parcours Remplacer pour confirmer la zone à supprimer.";
    const render = { ...admittedRender("failed"), error };
    expect(renderResponse(render).error).toBe("Cet emplacement semble occupé. Déplacez le point sur une zone libre, puis lancez une nouvelle visualisation.");
    expect(renderResponse({ ...render, publicSessionId: undefined }).error).toBe(error);
  });

  it.each(["Crédits insuffisants.", "Crédits insuffisants"])(
    "translates shop funding errors without changing the stored cause or merchant diagnostics: %s",
    async (error) => {
      const render = persistedRender({ ...admittedRender("failed"), error });
      const payload = await Response.json(renderResponse(render)).json();
      expect(renderSchema.parse(payload).error).toBe(STOREFRONT_BUDGET_UNAVAILABLE_MESSAGE);
      expect(render.error).toBe(error);
      expect(renderResponse({ ...render, publicSessionId: undefined }).error).toBe(error);
      expect(renderResponse({ ...render, publicSessionId: "guest:visitor" }).error).toBe(error);
      expect(renderResponse({ ...render, publicSessionId: "public-widget-session" }).error).toBe(error);
    },
  );
  it("preserves unrelated storefront failures verbatim", () => {
    const error = "Le contrôle du placement est indisponible.";
    expect(renderResponse({ ...admittedRender("failed"), error }).error).toBe(error);
  });

  it.each([
    { mode: "invented-mode" },
    { status: "invented-status" },
    { surfaceType: 42 },
    { placementPoint: { x: "left", y: 0.9 } },
    { provider: { name: "openai" } },
  ])("still rejects malformed public fields: %j", async (invalid) => {
    const payload = {
      ...renderResponse(persistedRender(admittedRender("processing"))),
      ...invalid,
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(payload)));
    await expect(getRender(admittedRender("processing").id)).rejects.toBeInstanceOf(
      InvalidApiResponseError,
    );
  });
});
