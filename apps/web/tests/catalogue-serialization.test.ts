import { expect, it, vi } from "vitest";
import { productSchema } from "@lili/types";
vi.mock("server-only", () => ({}));
import { productResponse } from "../lib/server/serializers";
import type { ProductDocument } from "../lib/server/types";

it("serializes a newly created catalogue product without optional Mongo null metadata", () => {
  const product = {
    id: "11111111-1111-4111-8111-111111111111", name: "Vase", description: "", objectType: "vase", sku: null,
    widthCm: 20, heightCm: 30, depthCm: 20, material: "Grès", placementType: "table", generationInstructions: "", lightingProfile: {},
    status: "draft", buyUrl: null, spatialMetadata: null, createdAt: new Date(), updatedAt: new Date(),
  } as unknown as ProductDocument;
  const response = JSON.parse(JSON.stringify(productResponse(product)));
  expect(response).not.toHaveProperty("spatialMetadata");
  expect(productSchema.safeParse(response).success).toBe(true);
});
