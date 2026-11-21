import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../lib/server/config", () => ({
  assertProductionConfig: vi.fn(),
  serverConfig: {
    get mongodbUri() {
      return server.getUri();
    },
    mongodbDb: "mongodb_pool_tests",
  },
}));

import { database, mongoClient } from "../lib/server/mongodb";

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
}, 60_000);

afterEach(async () => {
  const client = await globalThis.__liliMongoClientPromise;
  await client?.close();
  globalThis.__liliMongoClientPromise = undefined;
  globalThis.__liliIndexesPromise = undefined;
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await server?.stop();
});

it("reuses a bounded Vercel client and skips index writes in production", async () => {
  vi.stubEnv("VERCEL", "1");
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("VERCEL_REGION", undefined);

  const pending = mongoClient();
  expect(mongoClient()).toBe(pending);
  const [client, first, second] = await Promise.all([
    pending,
    database(),
    database(),
  ]);
  expect(first.client).toBe(client);
  expect(second.client).toBe(client);
  expect(client.options).toMatchObject({
    minPoolSize: 0,
    maxPoolSize: 4,
    maxConnecting: 1,
    maxIdleTimeMS: 10_000,
  });
  expect(client.listenerCount("connectionCheckedOut")).toBe(1);
  expect(await first.command({ ping: 1 })).toMatchObject({ ok: 1 });
  expect(await first.listCollections().toArray()).toEqual([]);
});

it("bootstraps application indexes on a local database", async () => {
  vi.stubEnv("VERCEL", undefined);
  vi.stubEnv("VERCEL_ENV", undefined);

  const db = await database();
  expect(db.client.options.maxPoolSize).toBe(10);
  const indexes = await db.collection("assets").indexes();
  expect(indexes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ key: { id: 1 }, unique: true }),
      expect.objectContaining({
        name: "asset_expiration_lookup",
        key: { expiresAt: 1 },
      }),
    ]),
  );
  expect(indexes.every((index) => index.expireAfterSeconds === undefined)).toBe(
    true,
  );
});
