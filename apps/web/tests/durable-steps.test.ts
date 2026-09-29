import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "mongodb";
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
