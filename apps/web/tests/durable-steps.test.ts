import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "mongodb";
import sharp from "sharp";
import { confirmedReplacementRemovalFrame } from "../lib/server/storefront-replacement";
import { restoreRoomIntegrationBackground } from "../lib/server/storefront-room-integration";
import type { RenderDocument } from "../lib/server/types";
import { mongoStore } from "./helpers/mongo-store";

const mocks = vi.hoisted(() => ({
  collections: vi.fn(),
  read: vi.fn(),
  store: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/mongodb", () => ({ collections: mocks.collections }));
vi.mock("../lib/server/assets", () => ({
  readAsset: mocks.read,
  storeAsset: mocks.store,
  privateVisibility: () => ({ ownerSessionId: "visitor" }),
}));
vi.mock("../lib/server/config", () => ({
  serverConfig: { aiMockMode: false },
}));
import {
  durableContext,
  DurableExecutionError,
} from "../lib/server/durable-context";
import { durableStep } from "../lib/server/durable-steps";

const db = {} as Db;
let renders: ReturnType<typeof mongoStore>;
let assets: ReturnType<typeof mongoStore>;
let render: RenderDocument;
beforeEach(() => {
  renders = mongoStore();
  assets = mongoStore();
  render = {
    id: "r",
    organizationId: "org",
    publicSessionId: "visitor",
    status: "processing",
    execution: {
      token: "first",
      leaseUntil: new Date(Date.now() + 90_000),
      deadlineAt: new Date(Date.now() + 900_000),
      scene: { expiresAt: new Date(Date.now() + 1000_000) },
      steps: {},
    },
  } as RenderDocument;
  renders.rows.push(
    structuredClone(render) as unknown as Record<string, unknown>,
  );
  mocks.collections.mockReturnValue({ renders, assets });
  mocks.read.mockReset();
  mocks.store.mockReset();
});
const run = <T>(call: () => Promise<T>, token = "first") =>
  durableContext.run({ render, token }, call);

describe("durable checkpoint recovery", () => {
  it("restores a real v11 provider Uint8Array in durable context and after private-asset hydration with the same full-room frame", async () => {
    const sourceWidth = 736, sourceHeight = 552;
    const original = await sharp({ create: { width: sourceWidth, height: sourceHeight, channels: 3, background: "#456789" } }).webp({ lossless: true }).toBuffer();
    const generated = await sharp({ create: { width: 1536, height: 1024, channels: 3, background: "#008800" } }).webp({ lossless: true }).toBuffer();
    const region = { xMin: 0.275, yMin: 0.595, xMax: 0.445, yMax: 0.86 };
    const frame = await confirmedReplacementRemovalFrame(original, sourceWidth, sourceHeight, region, { requestedSize: "1536x1024" });
    assets.rows.push({ id: "cleanup-v11-private", organizationId: "org", ownerSessionId: "visitor" });
    mocks.store.mockResolvedValue({ id: "cleanup-v11-private" });
    mocks.read.mockResolvedValue({ buffer: generated });
    const provider = vi.fn(async () => ({ provider: "myarchitectai", status: "succeeded", images: [{ data: new Uint8Array(generated) }] }));
    const first = await run(() => durableStep(db, "replacement-clean-v11", "image", provider));
    const firstRestored = await run(() => restoreRoomIntegrationBackground(frame.composition, frame.padded, Buffer.from(first.images[0]!.data)));
    await renders.updateOne({ id: "r" }, { $set: { "execution.token": "second" } });
    const hydrated = await run(() => durableStep(db, "replacement-clean-v11", "image", provider), "second");
    expect(hydrated.images[0]!.data).toBeInstanceOf(Uint8Array);
    expect(Buffer.isBuffer(hydrated.images[0]!.data)).toBe(false);
    const resumedRestored = await run(() => restoreRoomIntegrationBackground(frame.composition, frame.padded, Buffer.from(hydrated.images[0]!.data)), "second");
    expect(resumedRestored).toEqual(firstRestored);
    expect(provider).toHaveBeenCalledOnce();
    expect(mocks.store).toHaveBeenCalledWith(db, expect.objectContaining({ organizationId: "org", visibility: { ownerSessionId: "visitor" } }));
    const before = await sharp(original).raw().toBuffer();
    const output = await sharp(resumedRestored).raw().toBuffer();
    let exteriorDifferences = 0;
    for (let pixel = 0; pixel < sourceWidth * sourceHeight; pixel++)
      if (frame.composition.maskRaw[pixel * 4 + 3] === 255 && !output.subarray(pixel * 3, pixel * 3 + 3).equals(before.subarray(pixel * 3, pixel * 3 + 3))) exteriorDifferences++;
    expect(exteriorDifferences).toBe(0);
    expect([...output.subarray((400 * sourceWidth + 265) * 3, (400 * sourceWidth + 265) * 3 + 3)]).toEqual([0, 136, 0]);
  });

  it("reuses the private v10 cleanup before pose and contact after lease recovery without restarting v9 room refinement", async () => {
    assets.rows.push({ id: "cleaned-room", organizationId: "org", ownerSessionId: "visitor" });
    mocks.store.mockResolvedValue({ id: "cleaned-room" });
    const rawResponse = Buffer.from([1, 2, 3]);
    mocks.read.mockResolvedValue({ buffer: rawResponse });
    const cleanup = vi.fn(async () => ({ requestId: "cleanup-v10", image: rawResponse }));
    const pose = vi.fn(async () => ({ requestId: "pose-v10" }));
    const contact = vi.fn(async () => ({ requestId: "contact-v10" }));
    await run(async () => {
      await durableStep(db, "replacement-clean-v10", "image", cleanup);
      await durableStep(db, "pose-responses-v10", "image", pose);
      await durableStep(db, "harmonize-v10", "image", contact);
    });
    await renders.updateOne({ id: "r" }, { $set: { "execution.token": "second" } });
    await run(async () => {
      const result = await durableStep(db, "replacement-clean-v10", "image", cleanup);
      expect(Buffer.isBuffer(result.image)).toBe(true);
      expect(result.image).toEqual(rawResponse);
      await durableStep(db, "pose-responses-v10", "image", pose);
      await durableStep(db, "harmonize-v10", "image", contact);
    }, "second");
    expect(cleanup).toHaveBeenCalledOnce(); expect(pose).toHaveBeenCalledOnce(); expect(contact).toHaveBeenCalledOnce();
    expect(JSON.stringify(renders.rows)).not.toContain('"data":[1,2,3]');
    const row = await renders.findOne({ id: "r" });
    expect((row!.execution as RenderDocument["execution"])!.steps["room-refine-v9"]).toBeUndefined();
  });

  it.each(["replacement-clean-v10", "pose-responses-v10", "harmonize-v10", "replacement-clean-v11", "pose-responses-v11", "harmonize-v11"].flatMap(key =>
    ["running", "unknown"].map(status => [key, status] as const),
  ))("never replays an uncertain v10 paid checkpoint %s/%s after recovery", async (key, status) => {
    await renders.updateOne({ id: "r" }, { $set: { [`execution.steps.${key}`]: { status, attempts: 1, startedAt: new Date() } } });
    const image = vi.fn();
    await expect(run(() => durableStep(db, key, "image", image))).rejects.toMatchObject({ code: "provider_unknown" });
    expect(image).not.toHaveBeenCalled();
  });

  it.each(["v4", "v5", "v6"])("reuses both completed %s local images after lease recovery without replaying the historical v3 pose", async version => {
    const historicalPose = vi.fn().mockResolvedValue({ requestId: "v3-pose", imageAssetId: "private-v3-pose" });
    const myarchitect = vi.fn().mockResolvedValue({ requestId: "v4-draft", imageAssetId: "private-v4-draft" });
    const openai = vi.fn().mockResolvedValue({ requestId: "v4-refinement", imageAssetId: "private-v4-refinement" });
    await run(() => durableStep(db, "pose-responses-v3", "image", historicalPose));
    await run(() => durableStep(db, `room-image-${version}`, "image", myarchitect));
    await run(() => durableStep(db, `room-refine-${version}`, "image", openai));
    await renders.updateOne({ id: "r" }, { $set: { "execution.token": "second" } });
    expect(await run(() => durableStep(db, `room-image-${version}`, "image", myarchitect), "second")).toMatchObject({ requestId: "v4-draft" });
    expect(await run(() => durableStep(db, `room-refine-${version}`, "image", openai), "second")).toMatchObject({ requestId: "v4-refinement" });
    expect(historicalPose).toHaveBeenCalledOnce();
    expect(myarchitect).toHaveBeenCalledOnce();
    expect(openai).toHaveBeenCalledOnce();
  });

  it.each(["room-image-v4", "room-refine-v4", "room-image-v5", "room-refine-v5", "room-image-v6", "room-refine-v6"].flatMap(key => ["running", "unknown"].map(status => [key, status])))
    ("refuses to replay an uncertain paid checkpoint %s/%s", async (key, status) => {
      await renders.updateOne({ id: "r" }, { $set: { [`execution.steps.${key}`]: { status, attempts: 1, startedAt: new Date() } } });
      const image = vi.fn();
      await expect(run(() => durableStep(db, key!, "image", image))).rejects.toMatchObject({ code: "provider_unknown" });
      expect(image).not.toHaveBeenCalled();
    });

  it("keeps the Responses pose checkpoint distinct from the historical native-alpha pose and reuses both without paying twice", async () => {
    // Existing binary checkpoint storage already has its own cases; use small
    // structured metadata here to isolate version routing and paid call count.
    const historical = vi.fn().mockResolvedValue({ requestId: "legacy-pose", imageAssetId: "legacy-private-image" });
    const response = vi.fn().mockResolvedValue({ requestId: "responses-pose", imageAssetId: "responses-private-image" });
    await run(() => durableStep(db, "pose-v2", "image", historical));
    await run(() => durableStep(db, "pose-responses-v3", "image", response));
    await renders.updateOne({ id: "r" }, { $set: { "execution.token": "second" } });
    expect(await run(() => durableStep(db, "pose-v2", "image", historical), "second")).toMatchObject({ requestId: "legacy-pose" });
    expect(await run(() => durableStep(db, "pose-responses-v3", "image", response), "second")).toMatchObject({ requestId: "responses-pose" });
    expect(historical).toHaveBeenCalledOnce();
    expect(response).toHaveBeenCalledOnce();
  });

  it.each(["running", "unknown"])("never regenerates a Responses pose checkpoint left %s by another worker", async status => {
    await renders.updateOne({ id: "r" }, { $set: { "execution.steps.pose-responses-v3": { status, attempts: 1, startedAt: new Date() } } });
    const response = vi.fn();
    await expect(run(() => durableStep(db, "pose-responses-v3", "image", response))).rejects.toMatchObject({ code: "provider_unknown" });
    expect(response).not.toHaveBeenCalled();
  });

  it("yields before a new paid step while reusing completed checkpoints", async () => {
    const image = vi.fn().mockResolvedValue({ ok: true });
    await run(() => durableStep(db, "image-slice", "image", image));
    const judge = vi.fn();
    await durableContext.run(
      { render, token: "first", yieldAt: Date.now() - 1 },
      async () => {
        expect(await durableStep(db, "image-slice", "image", image)).toEqual({
          ok: true,
        });
        await expect(
          durableStep(db, "judge-slice", "analysis", judge),
        ).rejects.toMatchObject({ code: "yield" });
      },
    );
    expect(image).toHaveBeenCalledTimes(1);
    expect(judge).not.toHaveBeenCalled();
  });
  it("reuses a successful image when QA fails, then retries only QA", async () => {
    const edit = vi
      .fn()
      .mockResolvedValue({ requestId: "provider-1", metadata: { ok: true } });
    const judge = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ accepted: true });
    await run(async () => {
      await durableStep(db, "image-1", "image", edit);
      await expect(
        durableStep(db, "quality-1", "analysis", judge),
      ).rejects.toMatchObject({ code: "retry" });
    });
    await renders.updateOne(
      { id: "r" },
      { $set: { "execution.token": "second" } },
    );
    await run(async () => {
      expect(await durableStep(db, "image-1", "image", edit)).toEqual({
        requestId: "provider-1",
        metadata: { ok: true },
      });
      expect(await durableStep(db, "quality-1", "analysis", judge)).toEqual({
        accepted: true,
      });
    }, "second");
    expect(edit).toHaveBeenCalledTimes(1);
    expect(judge).toHaveBeenCalledTimes(2);
  });
  it("does not replay an image call whose response was lost", async () => {
    const edit = vi.fn().mockRejectedValue(new Error("socket closed"));
    await expect(
      run(() => durableStep(db, "image-1", "image", edit)),
    ).rejects.toMatchObject({ code: "provider_unknown" });
    await expect(
      run(() => durableStep(db, "image-1", "image", edit)),
    ).rejects.toMatchObject({ code: "provider_unknown" });
    expect(edit).toHaveBeenCalledTimes(1);
  });
  it("stops recovery after a process died in a paid image call", async () => {
    await renders.updateOne(
      { id: "r" },
      {
        $set: {
          "execution.steps.image-1": {
            status: "running",
            attempts: 1,
            startedAt: new Date(),
          },
        },
      },
    );
    const edit = vi.fn();
    await expect(
      run(() => durableStep(db, "image-1", "image", edit)),
    ).rejects.toMatchObject({ code: "provider_unknown" });
    expect(edit).not.toHaveBeenCalled();
  });
  it("retries explicit throttling, with a three-attempt stage ceiling", async () => {
    const edit = vi
      .fn()
      .mockRejectedValue(new DurableExecutionError("429", "retry"));
    for (let i = 0; i < 3; i++)
      await expect(
        run(() => durableStep(db, "image-1", "image", edit)),
      ).rejects.toMatchObject({ code: "retry" });
    await expect(
      run(() => durableStep(db, "image-1", "image", edit)),
    ).rejects.toMatchObject({ code: "permanent" });
    expect(edit).toHaveBeenCalledTimes(3);
  });
  it.each(["cancel", "expired", "reclaimed"])(
    "fences a late result after %s",
    async (scenario) => {
      const edit = async () => {
        await renders.updateOne(
          { id: "r" },
          {
            $set:
              scenario === "cancel"
                ? { status: "cancelled" }
                : scenario === "expired"
                  ? { "execution.leaseUntil": new Date(0) }
                  : { "execution.token": "new-owner" },
          },
        );
        return { image: "result" };
      };
      await expect(
        run(() => durableStep(db, "image-1", "image", edit)),
      ).rejects.toMatchObject({ code: "lease_lost" });
      const row = await renders.findOne({ id: "r" });
      expect(
        (row!.execution as RenderDocument["execution"])!.steps["image-1"]
          ?.status,
      ).toBe("running");
    },
  );
  it("persists binary output by private asset reference and restores Buffers", async () => {
    assets.rows.push({
      id: "checkpoint",
      organizationId: "org",
      ownerSessionId: "visitor",
    });
    mocks.store.mockResolvedValue({ id: "checkpoint" });
    mocks.read.mockResolvedValue({ buffer: Buffer.from([1, 2, 3]) });
    const call = vi
      .fn<() => Promise<{ data: Buffer }>>()
      .mockResolvedValue({ data: Buffer.from([1, 2, 3]) });
    await run(() => durableStep(db, "composition", "analysis", call));
    const output = await run(() =>
      durableStep(db, "composition", "analysis", call),
    );
    expect(Buffer.isBuffer(output.data)).toBe(true);
    expect(JSON.stringify(renders.rows)).not.toContain('"data":[1,2,3]');
    expect(mocks.store).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        organizationId: "org",
        visibility: { ownerSessionId: "visitor" },
      }),
    );
  });
  it("refuses a checkpoint from another organization", async () => {
    assets.rows.push({
      id: "checkpoint",
      organizationId: "other",
      ownerSessionId: "visitor",
    });
    await renders.updateOne(
      { id: "r" },
      {
        $set: {
          "execution.steps.image-1": {
            status: "completed",
            output: { __checkpointImage: "checkpoint" },
          },
        },
      },
    );
    await expect(
      run(() => durableStep(db, "image-1", "image", vi.fn())),
    ).rejects.toMatchObject({ code: "permanent" });
    expect(mocks.read).not.toHaveBeenCalled();
  });
});

describe("opt-in analysis recovery", () => {
  const retryPolicy = { maxAttempts: 2 as const, respectRetryable: true };
  it("persists a terminal refusal across worker changes", async () => {
    const judge = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("invalid review"), { retryable: false }),
      );
    await expect(
      run(() => durableStep(db, "judge", "analysis", judge, retryPolicy)),
    ).rejects.toMatchObject({ code: "permanent", message: "invalid review" });
    await renders.updateOne(
      { id: "r" },
      { $set: { "execution.token": "second" } },
    );
    await expect(
      run(
        () => durableStep(db, "judge", "analysis", judge, retryPolicy),
        "second",
      ),
    ).rejects.toMatchObject({ code: "permanent", message: "invalid review" });
    expect(judge).toHaveBeenCalledOnce();
    expect((await renders.findOne({ id: "r" }))!.execution).toMatchObject({
      steps: {
        judge: { status: "failed", attempts: 1, failure: "invalid review" },
      },
    });
  });
  it.each([
    new Error("network failure"),
    new DurableExecutionError("429", "retry"),
  ])("ends the second failed attempt immediately (%s)", async (error) => {
    const judge = vi.fn().mockRejectedValue(error);
    for (const code of ["retry", "permanent", "permanent"])
      await expect(
        run(() => durableStep(db, "judge", "analysis", judge, retryPolicy)),
      ).rejects.toMatchObject({ code });
    expect(judge).toHaveBeenCalledTimes(2);
    expect((await renders.findOne({ id: "r" }))!.execution).toMatchObject({
      steps: {
        judge: { status: "failed", attempts: 2 },
      },
    });
  });
  it("does not override lease-loss fencing with a terminal review failure", async () => {
    const judge = vi
      .fn()
      .mockRejectedValue(new DurableExecutionError("lost", "lease_lost"));
    await expect(
      run(() => durableStep(db, "judge", "analysis", judge, retryPolicy)),
    ).rejects.toMatchObject({ code: "lease_lost" });
    expect((await renders.findOne({ id: "r" }))!.execution).toMatchObject({
      steps: {
        judge: { status: "running" },
      },
    });
  });
  it("keeps three attempts for historical analysis without the opt-in policy", async () => {
    const judge = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("refused"), { retryable: false }),
      );
    for (const code of ["retry", "retry", "retry", "permanent"])
      await expect(
        run(() => durableStep(db, "judge", "analysis", judge)),
      ).rejects.toMatchObject({ code });
    expect(judge).toHaveBeenCalledTimes(3);
  });
});
