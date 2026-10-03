import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "mongodb";

const mocks = vi.hoisted(() => ({
  collections: vi.fn(),
  config: { roomRetentionHours: 24, adminOrganizationSlug: "atelier-lili" },
}));
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/mongodb", () => ({ collections: mocks.collections }));
vi.mock("../lib/server/config", () => ({ serverConfig: mocks.config }));
vi.mock("../lib/server/assets", () => ({
  CUTOUT_VERSION: "cutout-v2",
  assetUrl: (id?: string) => (id ? `/api/assets/${id}` : null),
  deleteAsset: vi.fn(async () => undefined),
}));

import {
  archiveExpiry,
  productImageAssetIds,
  setProductStatus,
  deleteProduct,
} from "../lib/server/admin-products";
import { assetRequiredByPreparedWork } from "../lib/server/prepared-view-retention";
import type { ProductDocument } from "../lib/server/types";
import { mongoStore } from "./helpers/mongo-store";

let db: Db;

let products: ReturnType<typeof mongoStore>;
let assets: ReturnType<typeof mongoStore>;
let preparedViews: ReturnType<typeof mongoStore>;
let preparedTasks: ReturnType<typeof mongoStore>;

const product = {
  id: "p1",
  organizationId: "org",
  name: "Vase", widthCm: 20, heightCm: 30, depthCm: 20,
  material: "Céramique", placementType: "table",
  status: "ready",
  assetId: "a-main",
  cutoutAssetId: "a-cutout",
  views: [
    { id: "v1", assetId: "a-main", type: "front" },
    { id: "v2", assetId: "a-side", type: "side" },
  ],
} as unknown as ProductDocument;

beforeEach(() => {
  products = mongoStore();
  assets = mongoStore();
  preparedViews = mongoStore();
  preparedTasks = mongoStore();
  const stores = { assets, prepared_product_views: preparedViews, prepared_view_tasks: preparedTasks };
  db = { collection: (name: keyof typeof stores) => stores[name] } as unknown as Db;
  products.rows.push({ ...product });
  for (const id of ["a-main", "a-cutout", "a-side"]) {
    assets.rows.push({ id, organizationId: "org", kind: "product" });
  }
  mocks.collections.mockReturnValue({ products, assets });
});

describe("archived product retention", () => {
  it("collects every image the product owns, without duplicates", () => {
    expect(productImageAssetIds(product).sort()).toEqual([
      "a-cutout",
      "a-main",
      "a-side",
    ]);
  });

  // A17 of the audit: archiving hid the product but nothing ever stamped an
  // expiry on its images, and the purge only reads `expiresAt`.
  it("stamps a retention on the product and its images when archiving", async () => {
    const before = Date.now();
    await setProductStatus(db, product, "archived");
    const stored = products.rows[0]!;
    expect(stored.status).toBe("archived");
    expect(stored.expiresAt).toBeInstanceOf(Date);
    expect((stored.expiresAt as Date).getTime()).toBeGreaterThan(before);
    expect(assets.rows.every((row) => row.expiresAt instanceof Date)).toBe(
      true,
    );
  });

  // Found by the adversarial review of this change set: stamping without a
  // matching lift means the purge destroys the images of a live product.
  it("lifts the retention again when the product is restored", async () => {
    const archived = await setProductStatus(db, product, "archived");
    expect(archived.expiresAt).toBeInstanceOf(Date);

    const restored = await setProductStatus(db, archived, "ready");
    expect(restored.status).toBe("ready");
    expect(restored.expiresAt).toBeUndefined();
    expect(products.rows[0]!.expiresAt).toBeUndefined();
    expect(assets.rows.every((row) => row.expiresAt === undefined)).toBe(true);
  });

  it("never re-stamps an expiry an image already carries", async () => {
    const own = new Date("2026-01-01T00:00:00Z");
    assets.rows[0]!.expiresAt = own;
    await setProductStatus(db, product, "archived");
    expect(assets.rows[0]!.expiresAt).toEqual(own);
    expect(assets.rows[1]!.expiresAt).not.toEqual(own);
  });

  it("derives the archive retention from the configured room retention", () => {
    const expiry = archiveExpiry();
    const hours = (expiry.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThan(24.1);
  });

  it("retires prepared views without approving them again on product restoration", async () => {
    preparedViews.rows.push({ id: "prepared", organizationId: "org", productId: "p1", state: "approved", image: { assetId: "prepared-image" }, alpha: { assetId: "prepared-alpha" } });
    preparedViews.rows.push({ id: "incident", organizationId: "org", productId: "p1", state: "revoked", revocation: { kind: "identity_incident" } });
    preparedTasks.rows.push({ id: "task", organizationId: "org", productId: "p1", state: "needs_review" });
    for (const id of ["prepared-image", "prepared-alpha"]) assets.rows.push({ id, organizationId: "org", visibility: "public" });

    const archived = await setProductStatus(db, product, "archived");
    expect(preparedViews.rows[0]!.state).toBe("stale");
    expect(preparedViews.rows[1]!.state).toBe("revoked");
    expect(preparedTasks.rows[0]!.state).toBe("failed");
    const candidates = assets.rows.filter(row => String(row.id).startsWith("prepared-"));
    expect(candidates.every(row => row.visibility === "private" && row.expiresAt instanceof Date)).toBe(true);

    await setProductStatus(db, archived, "ready");
    expect(preparedViews.rows[0]!.state).toBe("stale");
    expect(candidates.every(row => row.expiresAt instanceof Date)).toBe(true);
  });
  it("fences queued and running workers while retaining unknown expenses and sources", async () => {
    for (const [id, state, providerState] of [["queued", "queued", "not_sent"], ["running", "preparing", "succeeded"],
      ["sent", "preparing", "sent"], ["unknown", "unknown", "unknown"]] as const) {
      preparedViews.rows.push({ id, organizationId: "org", productId: "p1", state: state === "unknown" ? "failed" : state,
        revision: 2, preparationLeaseToken: "old-worker", sources: [{ assetId: `source-${id}` }],
        reviewHistory: [{ actorId: "human-evidence" }] });
      preparedTasks.rows.push({ id, organizationId: "org", productId: "p1", state,
        lease: { token: "old-worker", expiresAt: new Date(Date.now() + 60_000) },
        sources: [{ assetId: `source-${id}` }], sourceAssetId: `source-${id}`,
        provider: { state: providerState, reservedUsd: 0.03, costUsd: providerState === "succeeded" ? 0.03 : 0 },
        checkpoint: { rawAssetId: `raw-${id}`, imageAssetId: `image-${id}`, alphaAssetId: `alpha-${id}` } });
      assets.rows.push({ id: `raw-${id}`, organizationId: "org", visibility: "private" });
    }
    await setProductStatus(db, product, "archived");
    expect(preparedTasks.rows.map(t => t.state)).toEqual(["failed", "failed", "unknown", "unknown"]);
    expect(preparedTasks.rows.every(t => t.lease === undefined)).toBe(true);
    expect(preparedTasks.rows[2]!.provider).toMatchObject({ state: "unknown", reservedUsd: 0.03 });
    expect(preparedTasks.rows[1]!.provider).toMatchObject({ state: "succeeded", costUsd: 0.03 });
    expect(preparedViews.rows.slice(0, 3).every(v => v.state === "stale" && v.preparationLeaseToken === undefined)).toBe(true);
    expect(preparedViews.rows[0]!.reviewHistory).toEqual([{ actorId: "human-evidence" }]);
    expect(await assetRequiredByPreparedWork(db, "source-sent")).toBe(true);
    expect(await assetRequiredByPreparedWork(db, "raw-unknown")).toBe(true);
    expect(await assetRequiredByPreparedWork(db, "raw-running")).toBe(false);
  });
  it("archives the product before retiring preparation records, including deletion", async () => {
    const readTasks = preparedTasks.find.bind(preparedTasks);
    preparedTasks.find = vi.fn(filter => {
      expect(products.rows[0]!.status).toBe("archived");
      return readTasks(filter);
    });
    await setProductStatus(db, product, "archived");
    products.rows[0]!.status = "ready";
    await deleteProduct(db, product);
    expect(products.rows).toHaveLength(0);
  });
});
