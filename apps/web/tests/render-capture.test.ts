import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "mongodb";

const mocks = vi.hoisted(() => ({
  collections: vi.fn(),
  store: vi.fn(),
  remove: vi.fn(),
  config: { renderStageCapture: false },
}));
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/config", () => ({ serverConfig: mocks.config }));
vi.mock("../lib/server/mongodb", () => ({ collections: mocks.collections }));
vi.mock("../lib/server/assets", () => ({
  storeAsset: mocks.store,
  deleteAsset: mocks.remove,
  privateVisibility: (id?: string) =>
    id ? { ownerSessionId: id } : "organization",
}));

import { captureStage, stageCaptureEnabled } from "../lib/server/render-capture";
import { mongoStore } from "./helpers/mongo-store";

const db = {} as Db;
const render = {
  id: "r",
  organizationId: "org",
  publicSessionId: "guest:aaa",
};
const image = Buffer.from([1, 2, 3]);

let renders: ReturnType<typeof mongoStore>;

beforeEach(() => {
  renders = mongoStore();
  renders.rows.push({ id: "r", organizationId: "org", status: "processing" });
  mocks.collections.mockReturnValue({ renders });
  mocks.store.mockReset().mockResolvedValue({ id: "asset-1" });
  mocks.remove.mockReset().mockResolvedValue(undefined);
  mocks.config.renderStageCapture = false;
});

/**
 * PRO-007: only two of the pipeline's six stages survive a normal render, so a
 * corpus case can say a render is wrong but not where it went wrong.
 */
describe("render stage capture", () => {
  it("is inert unless explicitly enabled", async () => {
    expect(stageCaptureEnabled()).toBe(false);
    await captureStage(db, render, "model_output", image, "image/webp");
    expect(mocks.store).not.toHaveBeenCalled();
    expect(renders.rows[0]!.stages).toBeUndefined();
  });

  it("stores the stage privately to the session that asked for the render", async () => {
    mocks.config.renderStageCapture = true;
    await captureStage(db, render, "model_output", image, "image/webp");
    expect(mocks.store).toHaveBeenCalledWith(db, {
      organizationId: "org",
      kind: "render",
      visibility: { ownerSessionId: "guest:aaa" },
      buffer: image,
      contentType: "image/webp",
    });
    expect(renders.rows[0]!.stages).toEqual({ model_output: "asset-1" });
  });

  it("keeps each stage under its own name", async () => {
    mocks.config.renderStageCapture = true;
    mocks.store
      .mockResolvedValueOnce({ id: "a-input" })
      .mockResolvedValueOnce({ id: "a-output" });
    await captureStage(db, render, "model_input", image, "image/webp");
    await captureStage(db, render, "model_output", image, "image/webp");
    expect(renders.rows[0]!.stages).toEqual({
      model_input: "a-input",
      model_output: "a-output",
    });
  });

  it("carries the retention it is given", async () => {
    mocks.config.renderStageCapture = true;
    const expiresAt = new Date("2026-09-08T00:00:00Z");
    await captureStage(db, render, "scene_cleaned", image, "image/webp", expiresAt);
    expect(mocks.store).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ expiresAt }),
    );
  });

  it("evaluates a lazy image only when capture is on, and inside the guard", async () => {
    const produce = vi.fn(async () => image);
    await captureStage(db, render, "model_output", produce, "image/webp");
    expect(produce).not.toHaveBeenCalled();

    mocks.config.renderStageCapture = true;
    await captureStage(db, render, "model_output", produce, "image/webp");
    expect(produce).toHaveBeenCalledOnce();
    expect(renders.rows[0]!.stages).toEqual({ model_output: "asset-1" });

    // A producer that throws is a capture failure, not a render failure.
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        captureStage(
          db,
          render,
          "model_input",
          async () => {
            throw new Error("encode failed");
          },
          "image/webp",
        ),
      ).resolves.toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  // Found by the adversarial review: a capture landing after a cancel or a
  // delete attached an image to a render nobody could reach any more.
  it("does not attach a stage to a render that is no longer running", async () => {
    mocks.config.renderStageCapture = true;
    renders.rows[0]!.status = "cancelled";
    await captureStage(db, render, "model_output", image, "image/webp");
    expect(renders.rows[0]!.stages).toBeUndefined();
    // The image it had already stored is not left orphaned.
    expect(mocks.remove).toHaveBeenCalledWith(db, "asset-1");
  });

  // Losing a diagnostic must never fail the render it documents.
  it("never throws when the capture itself fails", async () => {
    mocks.config.renderStageCapture = true;
    mocks.store.mockRejectedValue(new Error("storage down"));
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        captureStage(db, render, "model_output", image, "image/webp"),
      ).resolves.toBeUndefined();
      expect(renders.rows[0]!.stages).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });
});
