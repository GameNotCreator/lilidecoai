import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "mongodb";
import { mongoStore } from "./helpers/mongo-store";
import { globalRoom } from "./fixtures/spatial-room";
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/config", () => ({
  serverConfig: { openaiBaseUrl: "https://invalid.test" },
}));
import { cachedSpatialRoom } from "../lib/server/spatial-scene-cache";
let store: ReturnType<typeof mongoStore>, db: Db;
beforeEach(() => {
  store = mongoStore();
  db = { collection: () => store } as unknown as Db;
});
afterEach(() => vi.useRealTimers());
const input = () => ({
  organizationId: "org",
  assetId: "room",
  room: Buffer.from("photo"),
  model: "vision",
  expiresAt: new Date(Date.now() + 3600_000),
});
const output = () => ({
  value: globalRoom,
  durationMs: 1000,
  usage: { input_tokens: 10 },
});
describe("shared spatial room cache", () => {
  it("reuses validated analysis without retaining source pixels", async () => {
    const load = vi.fn(async () => output());
    expect((await cachedSpatialRoom(db, input(), load)).cached).toBe(false);
    expect((await cachedSpatialRoom(db, input(), load)).cached).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(store.rows)).not.toContain('"data"');
  });
  it("isolates organizations, sessions, assets, photo hashes and models", async () => {
    const args = input(),
      load = vi.fn(async () => output());
    for (const change of [
      {},
      { organizationId: "other" },
      { sessionId: "guest" },
      { assetId: "new" },
      { room: Buffer.from("new") },
      { model: "new" },
    ])
      await cachedSpatialRoom(db, { ...args, ...change }, load);
    expect(load).toHaveBeenCalledTimes(6);
  });
  it("deduplicates concurrent calls and releases failed analysis", async () => {
    let resolve!: (v: ReturnType<typeof output>) => void;
    const wait = new Promise<ReturnType<typeof output>>((done) => {
      resolve = done;
    });
    const load = vi.fn(() => wait);
    const first = cachedSpatialRoom(db, input(), load);
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    await expect(cachedSpatialRoom(db, input(), load)).rejects.toMatchObject({
      status: 409,
    });
    resolve(output());
    await first;
    expect(load).toHaveBeenCalledOnce();
    await expect(
      cachedSpatialRoom(db, { ...input(), assetId: "bad" }, async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    expect(
      (
        await cachedSpatialRoom(db, { ...input(), assetId: "bad" }, async () =>
          output(),
        )
      ).cached,
    ).toBe(false);
  });
  it("fences a late lease owner after takeover", async () => {
    vi.useFakeTimers();
    let resolve!: (v: ReturnType<typeof output>) => void;
    const wait = new Promise<ReturnType<typeof output>>((done) => {
      resolve = done;
    });
    const args = input();
    const first = cachedSpatialRoom(db, args, () => wait);
    const failure = expect(first).rejects.toMatchObject({ status: 409 });
    await vi.advanceTimersByTimeAsync(121000);
    expect(
      (await cachedSpatialRoom(db, args, async () => output())).cached,
    ).toBe(false);
    resolve(output());
    await failure;
    expect(
      (
        await cachedSpatialRoom(db, args, async () => {
          throw new Error("must hit cache");
        })
      ).cached,
    ).toBe(true);
  });
  it("refuses expired sources and malformed model output", async () => {
    const load = vi.fn(async () => output());
    await expect(
      cachedSpatialRoom(db, { ...input(), expiresAt: new Date(0) }, load),
    ).rejects.toMatchObject({ status: 410 });
    expect(load).not.toHaveBeenCalled();
    await expect(
      cachedSpatialRoom(db, input(), async () => ({
        ...output(),
        value: { invalid: true } as unknown as typeof globalRoom,
      })),
    ).rejects.toThrow();
    expect(store.rows[0]?.value).toBeUndefined();
  });
});
