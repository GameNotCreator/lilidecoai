import { beforeEach, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { Db } from "mongodb";
import { mongoStore } from "./helpers/mongo-store";
import type { ProductDocument } from "../lib/server/types";
const mocks = vi.hoisted(() => ({ read: vi.fn(), collections: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/assets", () => ({
  readAsset: mocks.read,
  ApiInputError: class extends Error {},
}));
vi.mock("../lib/server/mongodb", () => ({ collections: mocks.collections }));
import {
  savePlanarTexture,
  readVerifiedPlanarTexture,
} from "../lib/server/planar-texture";
import { currentPlanarTexture } from "../lib/planar-texture";
import { prepareProductGeometry } from "../lib/server/spatial-policy";
const corners = [
  { x: 0.1, y: 0.1 },
  { x: 0.9, y: 0.1 },
  { x: 0.9, y: 0.9 },
  { x: 0.1, y: 0.9 },
];
const db = {} as Db;
let product: ProductDocument,
  store: ReturnType<typeof mongoStore>,
  buffer: Buffer;
beforeEach(async () => {
  vi.clearAllMocks();
  store = mongoStore();
  mocks.collections.mockReturnValue({ products: store });
  product = {
    id: "rug",
    organizationId: "org",
    objectType: "rug",
    placementType: "floor",
    widthCm: 80,
    heightCm: 1,
    depthCm: 100,
    assetId: "main",
    updatedAt: new Date(1),
  } as ProductDocument;
  store.rows.push(
    structuredClone(product) as unknown as Record<string, unknown>,
  );
  buffer = await sharp({
    create: { width: 300, height: 400, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  mocks.read.mockResolvedValue({ buffer, asset: { organizationId: "org" } });
});
it("persists normalized corners and a content fingerprint, then verifies source bytes", async () => {
  const saved = await savePlanarTexture(db, product, {
    assetId: "main",
    corners,
  });
  expect(saved.planarTexture.widthPx).toBe(300);
  expect(saved.planarTexture.heightPx).toBe(400);
  expect((await readVerifiedPlanarTexture(db, saved)).buffer).toEqual(buffer);
  const geometry = prepareProductGeometry(saved);
  expect(geometry.planarTexture).toEqual(saved.planarTexture);
  expect(geometry.fingerprint).not.toBe(
    prepareProductGeometry(product).fingerprint,
  );
  mocks.read.mockResolvedValue({
    buffer: Buffer.from("changed"),
    asset: { organizationId: "org" },
  });
  await expect(readVerifiedPlanarTexture(db, saved)).rejects.toThrow(/changé/);
});
it("invalidates selection after replacement, changed dimensions or changed family", async () => {
  const saved = await savePlanarTexture(db, product, {
    assetId: "main",
    corners,
  });
  expect(currentPlanarTexture({ ...saved, assetId: "replacement" })).toBeNull();
  expect(currentPlanarTexture({ ...saved, widthCm: 90 })).toBeNull();
  expect(currentPlanarTexture({ ...saved, objectType: "vase" })).toBeNull();
  expect(currentPlanarTexture({ ...saved, placementType: "table" })).toBeNull();
});
it("rejects foreign, unowned, crossed and undersized references", async () => {
  await expect(
    savePlanarTexture(db, product, { assetId: "foreign", corners }),
  ).rejects.toThrow(/fiche/);
  await expect(
    savePlanarTexture(db, product, {
      assetId: "main",
      corners: [corners[0], corners[2], corners[1], corners[3]],
    }),
  ).rejects.toThrow();
  await expect(
    savePlanarTexture(db, product, {
      assetId: "main",
      corners: corners.map((p) => ({ x: p.x / 10, y: p.y / 10 })),
    }),
  ).rejects.toThrow(/petite/);
  mocks.read.mockResolvedValue({
    buffer,
    asset: { organizationId: "another" },
  });
  await expect(
    savePlanarTexture(db, product, { assetId: "main", corners }),
  ).rejects.toThrow(/boutique/);
});
it("does not overwrite a concurrent photo or product edit", async () => {
  await store.updateOne(
    { id: product.id },
    { $set: { updatedAt: new Date(2), assetId: "replacement" } },
  );
  await expect(
    savePlanarTexture(db, product, { assetId: "main", corners }),
  ).rejects.toThrow(/fiche a changé/);
  expect(store.rows[0]!.planarTexture).toBeUndefined();
});
