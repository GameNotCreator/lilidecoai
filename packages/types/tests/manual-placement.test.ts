import { describe, expect, it } from "vitest";
import { manualPlacementSchema, renderRequestSchema } from "../src/index";

const productId = "11111111-1111-4111-8111-111111111111";
const request = {
  idempotencyKey: "manual-test", workflow: "simple_point", replaceExisting: true,
  replacementRegion: { xMin: 0.1, yMin: 0.1, xMax: 0.3, yMax: 0.3 },
  placement: { sceneId: "22222222-2222-4222-8222-222222222222", productId },
  placementPoint: { x: 0.7, y: 0.8 },
  simplePlacements: [{ productId, placementKind: "standing", placementPoint: { x: 0.7, y: 0.8 },
    manualPlacement: { box: { xMin: 0.6, yMin: 0.5, xMax: 0.8, yMax: 0.8 } } }],
};
describe("manual placement request contract", () => {
  it("does not conflate deletion and insertion boxes or require a known measurement", () => {
    expect(renderRequestSchema.safeParse(request).success).toBe(true);
    expect(renderRequestSchema.safeParse({ ...request, replaceExisting: false, replacementRegion: undefined }).success).toBe(true);
  });
  it("requires four valid plane corners for flat and mural objects", () => {
    const item = request.simplePlacements[0]!;
    expect(renderRequestSchema.safeParse({ ...request, simplePlacements: [{ ...item, placementKind: "flat" }] }).success).toBe(false);
    const plane = [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.25 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.85 }];
    for (const placementKind of ["wall", "flat"]) {
      expect(renderRequestSchema.safeParse({ ...request, simplePlacements: [{ ...item, placementKind,
        manualPlacement: { ...item.manualPlacement, plane } }] }).success).toBe(true);
    }
    expect(manualPlacementSchema.safeParse({ box: item.manualPlacement.box, plane: [plane[0], plane[2], plane[1], plane[3]] }).success).toBe(false);
  });
  it("does not allow an unconfirmed deletion region", () => {
    expect(renderRequestSchema.safeParse({ ...request, replaceExisting: false }).success).toBe(false);
  });
});
