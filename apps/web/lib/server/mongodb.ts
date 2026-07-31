import "server-only";

import {
  MongoClient,
  ServerApiVersion,
  type Collection,
  type Db,
} from "mongodb";

import { assertProductionConfig, serverConfig } from "./config";
import type {
  AssetDocument,
  CalibrationDocument,
  CreditTransactionDocument,
  OrganizationDocument,
  ProductDocument,
  RenderAttemptDocument,
  RenderDocument,
  SceneDocument,
  UserDocument,
  WalletDocument,
} from "./types";

declare global {
  var __liliMongoClientPromise: Promise<MongoClient> | undefined;
  var __liliIndexesPromise: Promise<void> | undefined;
}

function createClient(): MongoClient {
  return new MongoClient(serverConfig.mongodbUri, {
    appName: "lilidecoai-vercel",
    maxPoolSize: 10,
    minPoolSize: 0,
    maxIdleTimeMS: 30_000,
    serverSelectionTimeoutMS: 8_000,
    serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true,
    },
  });
}

export function mongoClient(): Promise<MongoClient> {
  if (!globalThis.__liliMongoClientPromise) {
    const client = createClient();
    globalThis.__liliMongoClientPromise = client.connect().catch((error) => {
      globalThis.__liliMongoClientPromise = undefined;
      throw error;
    });
  }
  return globalThis.__liliMongoClientPromise;
}

export async function database(): Promise<Db> {
  assertProductionConfig();
  const client = await mongoClient();
  const db = client.db(serverConfig.mongodbDb);
  await ensureIndexes(db);
  return db;
}

export function collections(db: Db) {
  return {
    assets: db.collection<AssetDocument>("assets"),
    organizations: db.collection<OrganizationDocument>("organizations"),
    products: db.collection<ProductDocument>("products"),
    scenes: db.collection<SceneDocument>("scenes"),
    calibrations: db.collection<CalibrationDocument>("calibrations"),
    renders: db.collection<RenderDocument>("renders"),
    renderAttempts: db.collection<RenderAttemptDocument>("render_attempts"),
    wallets: db.collection<WalletDocument>("wallets"),
    creditTransactions: db.collection<CreditTransactionDocument>(
      "credit_transactions",
    ),
    users: db.collection<UserDocument>("users"),
    analytics: db.collection("analytics_events"),
    auditLogs: db.collection("audit_logs"),
  };
}

async function ensureIndexes(db: Db): Promise<void> {
  if (!globalThis.__liliIndexesPromise) {
    globalThis.__liliIndexesPromise = createIndexes(db).catch((error) => {
      globalThis.__liliIndexesPromise = undefined;
      throw error;
    });
  }
  await globalThis.__liliIndexesPromise;
}

async function createIndexes(db: Db): Promise<void> {
  const c = collections(db);
  // Cloudinary objects must be deleted before their metadata disappears.
  // Remove the legacy TTL index if this database already has it.
  await c.assets.dropIndex("expiresAt_1").catch(() => undefined);
  await Promise.all([
    c.assets.createIndex({ id: 1 }, { unique: true }),
    c.assets.createIndex({ expiresAt: 1 }, { name: "asset_expiration_lookup" }),
    c.products.createIndex({ organizationId: 1, id: 1 }, { unique: true }),
    c.organizations.createIndex({ id: 1 }, { unique: true }),
    c.organizations.createIndex({ slug: 1 }, { unique: true }),
    c.products.createIndex({ organizationId: 1, createdAt: -1 }),
    c.scenes.createIndex({ organizationId: 1, id: 1 }, { unique: true }),
    c.scenes.createIndex({ publicSessionId: 1 }, { sparse: true }),
    c.scenes.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    c.calibrations.createIndex({ organizationId: 1, id: 1 }, { unique: true }),
    c.renders.createIndex({ organizationId: 1, id: 1 }, { unique: true }),
    c.renders.createIndex({ publicSessionId: 1 }, { sparse: true }),
    c.renders.createIndex(
      { organizationId: 1, idempotencyKey: 1 },
      { unique: true },
    ),
    c.renderAttempts.createIndex({ organizationId: 1, createdAt: -1 }),
    c.wallets.createIndex({ organizationId: 1 }, { unique: true }),
    c.creditTransactions.createIndex(
      { organizationId: 1, idempotencyKey: 1 },
      { unique: true },
    ),
    c.users.createIndex({ email: 1 }, { unique: true }),
    c.analytics.createIndex({ organizationId: 1, createdAt: -1 }),
  ]);
}

export async function pingMongo(): Promise<boolean> {
  const db = await database();
  const result = await db.command({ ping: 1 });
  return result.ok === 1;
}

export type TypedCollection<T extends { id?: string }> = Collection<T>;
