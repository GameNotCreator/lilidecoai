import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Db } from "mongodb";
import { mongoStore } from "./helpers/mongo-store";
const usage = vi.hoisted(() => ({ collections: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/mongodb", () => ({ collections: usage.collections }));
vi.mock("../lib/server/config", () => ({
  serverConfig: {
    openaiBaseUrl: "https://invalid.test",
    openaiApiKey: "test",
    aiMockMode: false,
  },
}));
import {
  cachedSourceReview,
  inspectSpatialSources,
  sourceReviewFailure,
  validateSourceReview,
} from "../lib/server/spatial-source-review";
import { measureProviderCall } from "../lib/server/provider-usage";
const item = (index = 0) => ({
  index,
  sameProduct: true,
  singleUnambiguousProduct: true,
  readable: true,
  completeSilhouette: true,
  confidence: 0.9,
  reason: "Objet visible et complet",
});
const value = () => ({ references: [item()] });
const input = () => ({
  organizationId: "org",
  productFingerprint: "product",
  model: "vision",
  references: [{ view: "catalog", data: Buffer.from("photo") }],
  expiresAt: new Date(Date.now() + 3600_000),
});
let store: ReturnType<typeof mongoStore>, db: Db;
beforeEach(() => {
  store = mongoStore();
  db = { collection: () => store } as unknown as Db;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("refuses cropped primary, multiple objects, uncertainty and inconsistent variants", () => {
  for (const patch of [
    { completeSilhouette: false },
    { singleUnambiguousProduct: false },
    { confidence: 0.79 },
    { sameProduct: false },
    { readable: false },
  ])
    expect(
      sourceReviewFailure({ references: [{ ...item(), ...patch }] }),
    ).toContain("Références catalogue");
  expect(
    sourceReviewFailure({
      references: [item(), { ...item(1), completeSilhouette: false }],
    }),
  ).toBeUndefined();
  expect(() =>
    validateSourceReview({ references: [item(), item()] }, 2),
  ).toThrow();
  expect(() => validateSourceReview(value(), 2)).toThrow();
});
it("reuses refusals too, isolates tenants/models/content and never stores photos", async () => {
  const load = vi.fn(async () => ({
    value: { references: [{ ...item(), completeSilhouette: false }] },
    durationMs: 1,
  }));
  const args = input();
  await cachedSourceReview(db, args, load);
  expect(
    sourceReviewFailure(await cachedSourceReview(db, args, load)),
  ).toBeTruthy();
  expect(load).toHaveBeenCalledOnce();
  for (const change of [
    { organizationId: "other" },
    { productFingerprint: "changed" },
    { model: "other" },
    { references: [{ view: "catalog", data: Buffer.from("changed") }] },
  ])
    await cachedSourceReview(db, { ...args, ...change }, load);
  expect(load).toHaveBeenCalledTimes(5);
  expect(JSON.stringify(store.rows)).not.toContain('"data"');
});
it("holds an exclusive lease and releases it after provider failure", async () => {
  let resolve!: (result: {
    value: ReturnType<typeof value>;
    durationMs: number;
  }) => void;
  const load = vi.fn(
    () =>
      new Promise<{ value: ReturnType<typeof value>; durationMs: number }>(
        (done) => {
          resolve = done;
        },
      ),
  );
  const first = cachedSourceReview(db, input(), load);
  await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
  await expect(cachedSourceReview(db, input(), load)).rejects.toThrow(
    /en cours/,
  );
  resolve({ value: value(), durationMs: 1 });
  await first;
  const args = { ...input(), productFingerprint: "failed" };
  await expect(
    cachedSourceReview(db, args, async () => {
      throw new Error("offline");
    }),
  ).rejects.toThrow("offline");
  await expect(
    cachedSourceReview(db, args, async () => ({
      value: value(),
      durationMs: 1,
    })),
  ).resolves.toEqual(value());
});
it("refreshes an expired diagnostic before TTL cleanup without reviving expired sources", async () => {
  vi.useFakeTimers();
  const args = input(),
    load = vi.fn(async () => ({ value: value(), durationMs: 1 }));
  await cachedSourceReview(db, args, load);
  vi.setSystemTime(args.expiresAt.getTime() + 1);
  await expect(cachedSourceReview(db, args, load)).rejects.toThrow(/expirées/);
  await cachedSourceReview(
    db,
    { ...args, expiresAt: new Date(Date.now() + 60000) },
    load,
  );
  expect(load).toHaveBeenCalledTimes(2);
  expect(store.rows).toHaveLength(1);
});
it("fences a stale worker after lease takeover", async () => {
  vi.useFakeTimers();
  let resolve!: (result: {
    value: ReturnType<typeof value>;
    durationMs: number;
  }) => void;
  const load = vi.fn(
    () =>
      new Promise<{ value: ReturnType<typeof value>; durationMs: number }>(
        (done) => {
          resolve = done;
        },
      ),
  );
  const args = input(),
    first = cachedSourceReview(db, args, load);
  await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
  vi.setSystemTime(Date.now() + 121000);
  await cachedSourceReview(db, args, async () => ({
    value: value(),
    durationMs: 1,
  }));
  resolve({
    value: { references: [{ ...item(), readable: false }] },
    durationMs: 1,
  });
  await expect(first).rejects.toThrow(/en cours/);
  expect(await cachedSourceReview(db, args, load)).toEqual(value());
});
it("validates strict provider output and labels all supplied images", async () => {
  const fetch = vi.fn().mockResolvedValue(
    Response.json({
      status: "completed",
      output: [
        {
          type: "message",
          status: "completed",
          content: [{ type: "output_text", text: JSON.stringify(value()) }],
        },
      ],
    }),
  );
  vi.stubGlobal("fetch", fetch);
  expect(
    (
      await inspectSpatialSources(
        input().references,
        "vision",
        Date.now() + 60000,
      )
    ).value,
  ).toEqual(value());
  const body = JSON.parse(fetch.mock.calls[0]![1].body);
  expect(body.store).toBe(false);
  expect(body.text.format.strict).toBe(true);
  fetch.mockResolvedValueOnce(Response.json({ output_text: "{}" }));
  await expect(
    inspectSpatialSources(input().references, "vision", Date.now() + 60000),
  ).rejects.toThrow();
});

it.each([
  ["deadline", null, "failed", 0, 0],
  ["unauthorized", 401, "failed", 0, 1],
  ["rate limit", 429, "failed", 0, 1],
  ["provider timeout", 408, "unknown", 0.03, 1],
  ["provider error", 503, "unknown", 0.03, 1],
] as const)(
  "accounts source review correctly for %s",
  async (_label, status, outcome, cost, calls) => {
    const renders = mongoStore(),
      attempts = mongoStore();
    renders.rows.push({ id: "r", organizationId: "org" });
    usage.collections.mockReturnValue({ renders, renderAttempts: attempts });
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: status ?? 200 }));
    vi.stubGlobal("fetch", fetch);
    await expect(
      measureProviderCall(
        db,
        { id: "r", organizationId: "org" },
        {
          step: "spatial-source-review",
          provider: "openai",
          model: "vision",
          estimatedCostUsd: 0.03,
        },
        () =>
          inspectSpatialSources(
            input().references,
            "vision",
            Date.now() + (status === null ? 1000 : 60000),
          ),
      ),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(calls);
    expect(attempts.rows).toHaveLength(1);
    expect(attempts.rows[0]).toMatchObject({
      usageOutcome: outcome,
      estimatedCostUsd: cost,
    });
  },
);
