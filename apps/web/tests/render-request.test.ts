import { describe, expect, it } from "vitest";
import {
  buildRetryInput,
  snapshotRenderInput,
  type RenderInput,
} from "../lib/server/render-request";
import type { RenderDocument } from "../lib/server/types";

function request(): RenderInput {
  return {
    workflow: "simple_point",
    mode: "insert",
    idempotencyKey: "first",
    placement: {
      sceneId: "scene",
      productId: "product-0",
      xNormalized: 0.2,
      yNormalized: 0.8,
    },
    simplePlacements: [0, 1, 2].map((i) => ({
      productId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      placementPoint: { x: 0.2 + i * 0.2, y: 0.8 },
      dimensionPair: { mode: "height_length", heightCm: 30 + i, lengthCm: 15 },
      placementKind: "standing",
      pixelsPerCm: 2 + i,
    })),
    calibration: { status: "measured", points: [1, 2] },
    lighting: { temperature: "warm" },
    outputQuality: "final",
    preserveBackground: true,
    userInstructions: "Conserver les motifs.",
  };
}

describe("render request replay", () => {
  it("keeps a supplied retry key and every spatial input in a detached snapshot", () => {
    const original: RenderInput = {
      engine: "spatial",
      workflow: "standard",
      mode: "insert",
      outputQuality: "final",
      placement: {
        sceneId: "scene",
        productId: "product",
        rotationDegrees: 45,
      },
      placementPoint: { x: 0.3, y: 0.7 },
      spatialReference: {
        sceneFingerprint: "a".repeat(64),
        surfaceId: "table",
        lengthCm: 100,
        points: [
          { x: 0.1, y: 0.8 },
          { x: 0.9, y: 0.8 },
        ],
      },
      userInstructions: "Conserver le décor",
      idempotencyKey: "original",
    };
    const source = {
      id: "source",
      engine: "spatial",
      requestSnapshot: snapshotRenderInput(original),
    } as RenderDocument;
    const key = `retry:source:${crypto.randomUUID()}`;
    expect(buildRetryInput(source, key)).toEqual({
      ...original,
      idempotencyKey: key,
    });
    buildRetryInput(source, key).placement.rotationDegrees = 90;
    expect(source.requestSnapshot!.input.placement.rotationDegrees).toBe(45);
    expect(() =>
      buildRetryInput(source, `retry:other:${crypto.randomUUID()}`),
    ).toThrow(/clé/);
    expect(() => buildRetryInput(source, "retry:source:invalid")).toThrow(
      /clé/,
    );
  });
  it.each([undefined, snapshotRenderInput(request())])(
    "refuses missing or inconsistent spatial inputs instead of switching to legacy",
    (snapshot) => {
      expect(() =>
        buildRetryInput({
          id: "source",
          engine: "spatial",
          placement: {},
          requestSnapshot: snapshot,
        } as RenderDocument),
      ).toThrow(/spatiaux/);
    },
  );
  it("replays all three objects and settings from a detached snapshot", () => {
    const original = request();
    const snapshot = snapshotRenderInput(original);
    original.simplePlacements![1]!.pixelsPerCm = 99;
    const render = {
      id: "render",
      requestSnapshot: snapshot,
    } as unknown as RenderDocument;
    const replay = buildRetryInput(render);
    expect({
      ...replay,
      idempotencyKey: snapshot.input.idempotencyKey,
    }).toEqual(snapshot.input);
    expect(replay.simplePlacements![1]!.pixelsPerCm).toBe(3);
    replay.simplePlacements![0]!.placementPoint.x = 1;
    expect(snapshot.input.simplePlacements![0]!.placementPoint.x).toBe(0.2);
    expect(replay.idempotencyKey.length).toBeLessThanOrEqual(160);
    expect(buildRetryInput(render).idempotencyKey).not.toBe(
      replay.idempotencyKey,
    );
  });
  it("restores historical multi-object requests instead of changing workflow", () => {
    const original = request();
    const render = {
      id: "r",
      sceneId: "scene",
      productId: "product-0",
      placement: {
        ...original.placement,
        simplePlacements: original.simplePlacements,
      },
      mode: "insert",
      promptVersion: "simple-composite-v2.0.0",
    } as unknown as RenderDocument;
    expect(buildRetryInput(render)).toMatchObject({
      workflow: "simple_point",
      simplePlacements: original.simplePlacements,
    });
  });
  it("refuses an incomplete old simple render", () => {
    expect(() =>
      buildRetryInput({
        id: "r",
        placement: {},
        promptVersion: "simple-multi-point-v3.0.0",
      } as unknown as RenderDocument),
    ).toThrow(/incomplets/);
  });
  it("refuses unknown snapshot versions", () => {
    const render = {
      id: "r",
      requestSnapshot: { version: 2, input: request() },
    } as unknown as RenderDocument;
    expect(() => buildRetryInput(render)).toThrow(/version/);
  });
});
