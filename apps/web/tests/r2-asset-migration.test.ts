import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { Binary, MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import sharp from "sharp";

vi.mock("server-only", () => ({}));
vi.mock("../lib/server/mongodb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/server/mongodb")>()),
  database: async () => db,
}));
vi.mock("@/lib/server/mongodb", () => import("../lib/server/mongodb"));
vi.mock("@/lib/server/assets", () => import("../lib/server/assets"));
vi.mock(
  "@/lib/server/asset-access",
  () => import("../lib/server/asset-access"),
);
vi.mock("@/lib/server/admin-auth", () => ({
  requireAdminRequest: async () => {
    throw new Error("No admin session");
  },
}));
vi.mock("@/lib/server/admin-products", () => ({
  resolveAdminOrganization: vi.fn(),
}));
vi.mock("@/lib/server/auth", () => ({
  tenantsForRequest: async (request: Request) => {
    const publicSessionId = request.headers.get("x-test-session");
    return publicSessionId
      ? [{ organizationId: "shop", role: "guest", publicSessionId }]
      : [];
  },
}));

import { GET } from "../app/api/assets/[id]/route";
import {
  deleteAsset,
  deleteExpiredAsset,
  storeAsset,
  storeUploadedPhoto,
} from "../lib/server/assets";
import {
  auditMongoStorage,
  migrateR2Assets,
} from "../lib/server/r2-asset-migration";
import { getR2Storage } from "../lib/server/r2-storage";
import type { AssetDocument } from "../lib/server/types";

const bucket = "lilideco-test";
const s3Origin =
  "https://00000000000000000000000000000000.r2.cloudflarestorage.com";
const site = "https://shop.example.test";
const photo = Buffer.from("synthetic-photo-bytes");
const image = {
  buffer: photo,
  contentType: "image/png",
  organizationId: "shop",
};

let mongo: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let objects: Map<string, Buffer>;
let reportR2Reads: boolean;
let onPut: (() => Promise<void>) | undefined;
let rejectPut: boolean;

const assets = () => db.collection<AssetDocument>("assets");
const asset = (id: string) => assets().findOne({ id });
const options = { site, limit: 25 };

function getAsset(id: string, session?: string) {
  return GET(
    new Request(`${site}/api/assets/${id}`, {
      headers: session ? { "x-test-session": session } : undefined,
    }),
    { params: Promise.resolve({ id }) },
  );
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({
    instance: { storageEngine: "wiredTiger" },
  });
  client = await new MongoClient(mongo.getUri()).connect();
  db = client.db("r2_migration_test");
  await assets().createIndex({ id: 1 }, { unique: true });
}, 60_000);

afterAll(async () => {
  await client?.close();
  await mongo?.stop();
});

beforeEach(async () => {
  await assets().deleteMany({});
  objects = new Map();
  reportR2Reads = true;
  onPut = undefined;
  rejectPut = false;
  vi.stubEnv("R2_ENDPOINT", `${s3Origin}/${bucket}`);
  vi.stubEnv("R2_BUCKET", bucket);
  vi.stubEnv("R2_ACCESS_KEY_ID", "test-key");
  vi.stubEnv("R2_SECRET_ACCESS_KEY", "test-secret");
  vi.stubEnv("R2_UPLOADS_ENABLED", "false");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === site) {
        const id = url.pathname.split("/").at(-1)!;
        const response = await getAsset(id);
        if (!reportR2Reads) response.headers.delete("X-Lili-Asset-Storage");
        return response;
      }
      expect(url.origin).toBe(s3Origin);
      expect(request.headers.get("authorization")).toMatch(
        /^AWS4-HMAC-SHA256 /,
      );
      expect(url.pathname).toMatch(
        new RegExp(`^/${bucket}/assets/[a-f0-9-]+$`),
      );
      const key = url.pathname.slice(bucket.length + 2);
      if (request.method === "PUT") {
        if (rejectPut) return new Response(null, { status: 403 });
        objects.set(key, Buffer.from(await request.arrayBuffer()));
        await onPut?.();
        return new Response(null, { status: 200 });
      }
      if (request.method === "DELETE") {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      const bytes = objects.get(key);
      return bytes
        ? new Response(new Uint8Array(bytes))
        : new Response(null, { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("validates and rotates uploads before storing WebP bytes in MongoDB", async () => {
  const jpeg = await sharp({
    create: { width: 480, height: 320, channels: 3, background: "#c5734f" },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const input = {
    ...image,
    kind: "product",
    visibility: "published",
    buffer: jpeg,
  } as const;
  await expect(storeUploadedPhoto(db, input)).rejects.toThrow("format annoncé");
  expect(await assets().countDocuments()).toBe(0);

  const uploaded = await storeUploadedPhoto(db, {
    ...input,
    contentType: "image/jpeg",
  });
  expect(uploaded).toMatchObject({ width: 320, height: 480 });
  const persisted = await asset(uploaded.asset.id);
  const bytes = Buffer.from(persisted!.bytes!.value());
  expect(persisted).toMatchObject({
    contentType: "image/webp",
    size: bytes.length,
  });
  const metadata = await sharp(bytes).metadata();
  expect(metadata).toMatchObject({ format: "webp", width: 320, height: 480 });
  expect(metadata.exif).toBeUndefined();
  const response = await getAsset(uploaded.asset.id);
  expect(response.headers.get("content-type")).toBe("image/webp");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
});

it("keeps photo transparency when uploading the WebP to R2", async () => {
  vi.stubEnv("R2_UPLOADS_ENABLED", "true");
  const png = await sharp({
    create: {
      width: 320,
      height: 320,
      channels: 4,
      background: { r: 125, g: 70, b: 25, alpha: 0.4 },
    },
  })
    .png()
    .toBuffer();
  const uploaded = await storeUploadedPhoto(db, {
    ...image,
    kind: "product_view",
    visibility: "organization",
    buffer: png,
  });
  const bytes = objects.get(uploaded.asset.r2!.key)!;
  expect(uploaded.asset).toMatchObject({
    contentType: "image/webp",
    size: bytes.length,
  });
  expect(await sharp(bytes).metadata()).toMatchObject({
    format: "webp",
    hasAlpha: true,
  });
  expect((await sharp(bytes).raw().toBuffer())[3]).toBe(102);
});

it("audits inline bytes without touching assets or R2", async () => {
  await storeAsset(
    db,
    { ...image, kind: "product", visibility: "published" },
    "catalogue",
  );
  await storeAsset(
    db,
    {
      ...image,
      kind: "scene",
      visibility: { ownerSessionId: "visitor" },
      expiresAt: new Date(0),
    },
    "expired",
  );

  const audit = await auditMongoStorage(db);
  expect(audit.collections[0]).toMatchObject({ name: "assets", documents: 2 });
  expect(audit.assets).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        _id: { kind: "product", visibility: "published" },
        inlineBytes: photo.length,
        expiredInlineBytes: 0,
      }),
      expect.objectContaining({
        _id: { kind: "scene", visibility: "private" },
        inlineBytes: photo.length,
        expiredInlineBytes: photo.length,
      }),
    ]),
  );
  expect(await asset("catalogue")).not.toHaveProperty("r2");
  expect(fetch).not.toHaveBeenCalled();
});

it("copies, verifies the deployed read, and restores only verified bytes", async () => {
  const storage = getR2Storage()!;
  await storeAsset(
    db,
    { ...image, kind: "product", visibility: "published" },
    "catalogue",
  );
  const visitor = await storeAsset(
    db,
    {
      ...image,
      kind: "scene",
      visibility: { ownerSessionId: "visitor" },
      expiresAt: new Date(Date.now() + 60_000),
    },
    "visitor-photo",
  );

  const copy = await migrateR2Assets(db, storage, { ...options, mode: "copy" });
  expect(copy).toMatchObject({
    changed: 2,
    bytes: photo.length * 2,
    failed: 0,
  });
  expect(await asset("visitor-photo")).toMatchObject({
    bytes: new Binary(photo),
    ownerSessionId: "visitor",
  });
  expect(
    await migrateR2Assets(db, storage, { ...options, mode: "copy" }),
  ).toMatchObject({ inspected: 0 });

  vi.mocked(fetch).mockClear();
  expect((await getAsset("visitor-photo", "other")).status).toBe(403);
  expect(fetch).not.toHaveBeenCalled();
  const allowed = await getAsset("visitor-photo", "visitor");
  expect(allowed.headers.get("cache-control")).toBe("private, no-store");
  expect(allowed.headers.get("x-lili-asset-storage")).toBe("r2");
  expect(Buffer.from(await allowed.arrayBuffer())).toEqual(photo);

  reportR2Reads = false;
  await expect(
    migrateR2Assets(db, storage, { ...options, mode: "prune" }),
  ).rejects.toThrow("ne confirme pas");
  expect(await asset("catalogue")).toHaveProperty("bytes");

  reportR2Reads = true;
  const key = (await asset("visitor-photo"))!.r2!.key;
  objects.set(key, Buffer.from("wrong object"));
  const fallback = await getAsset("visitor-photo", "visitor");
  expect(fallback.headers.get("x-lili-asset-storage")).toBe("mongodb");
  expect(Buffer.from(await fallback.arrayBuffer())).toEqual(photo);
  const prune = await migrateR2Assets(db, storage, {
    ...options,
    mode: "prune",
  });
  expect(prune).toMatchObject({ changed: 1, bytes: photo.length, failed: 1 });
  expect(await asset("catalogue")).not.toHaveProperty("bytes");
  expect(await asset("visitor-photo")).toMatchObject(visitor);
  expect((await getAsset("catalogue")).status).toBe(200);

  const restore = await migrateR2Assets(db, storage, {
    ...options,
    mode: "restore",
  });
  expect(restore).toMatchObject({ changed: 1, bytes: photo.length, failed: 0 });
  expect(await asset("catalogue")).toMatchObject({ bytes: new Binary(photo) });
});

it("removes a verified copy when the original disappeared during upload", async () => {
  await storeAsset(
    db,
    { ...image, kind: "product", visibility: "published" },
    "removed",
  );
  onPut = () => deleteAsset(db, "removed");

  const report = await migrateR2Assets(db, getR2Storage()!, {
    ...options,
    mode: "copy",
  });
  expect(report).toMatchObject({
    inspected: 1,
    changed: 0,
    skipped: 1,
    failed: 0,
  });
  expect(await asset("removed")).toBeNull();
  expect(objects.size).toBe(0);
});

it("uses R2 for new writes when enabled and deletes replaced or expired objects", async () => {
  vi.stubEnv("R2_UPLOADS_ENABLED", "true");
  const input = {
    ...image,
    kind: "scene",
    visibility: "organization",
    expiresAt: new Date(0),
  } as const;
  rejectPut = true;
  expect(await storeAsset(db, input, "temporary")).toHaveProperty("bytes");
  rejectPut = false;

  const first = await storeAsset(db, input, "temporary");
  const replacement = await storeAsset(
    db,
    { ...input, buffer: Buffer.from("replacement") },
    "temporary",
  );
  expect(await asset("temporary")).not.toHaveProperty("bytes");
  expect(objects.has(first.r2!.key)).toBe(false);
  expect(objects.has(replacement.r2!.key)).toBe(true);
  expect(await deleteExpiredAsset(db, "temporary")).toBe(true);
  expect(await asset("temporary")).toBeNull();
  expect(objects.size).toBe(0);
});
