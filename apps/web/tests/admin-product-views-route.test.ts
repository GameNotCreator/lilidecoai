import { isDeepStrictEqual } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "mongodb";
import { mongoStore } from "./helpers/mongo-store";

const mocks = vi.hoisted(() => ({
  collections: vi.fn(),
  storeAsset: vi.fn(),
  deleteAsset: vi.fn(),
  validateImage: vi.fn(),
  normalizeImage: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("sharp", () => ({
  default: () => ({ metadata: async () => ({ width: 400, height: 600 }) }),
}));
vi.mock("../lib/server/config", () => ({
  serverConfig: { roomRetentionHours: 24 },
}));
vi.mock("../lib/server/mongodb", () => ({ collections: mocks.collections }));
vi.mock("@/lib/server/mongodb", () => ({ collections: mocks.collections }));
vi.mock("../lib/server/assets", () => ({
  ...mocks,
  CUTOUT_VERSION: "cutout-v2",
  assetUrl: (id?: string) => (id ? `/api/assets/${id}` : null),
  ApiInputError: class extends Error {},
}));
vi.mock("@/lib/server/assets", async () => import("../lib/server/assets"));
vi.mock(
  "@/lib/server/admin-products",
  async () => import("../lib/server/admin-products"),
);
vi.mock(
  "@/lib/server/product-visibility",
  async () => import("../lib/server/product-visibility"),
);
vi.mock("@/lib/server/admin-route", () => ({
  withAdmin: async (
    _request: Request,
    handler: (context: unknown) => Promise<Response>,
  ) => {
    try {
      return await handler({ db: {}, organization: { id: "org" } });
    } catch (reason) {
      return Response.json(
        { detail: (reason as Error).message },
        { status: (reason as { status?: number }).status ?? 500 },
      );
    }
  },
}));

import { POST, DELETE } from "../app/api/admin/products/[id]/views/route";
import { setProductStatus } from "../lib/server/admin-products";
import type { ProductDocument } from "../lib/server/types";

let products: ReturnType<typeof mongoStore>;
let assets: ReturnType<typeof mongoStore>;
let bytes: Map<string, Buffer>;
const expiry = new Date("2030-01-01");
const originalDate = new Date("2026-09-29T00:00:00Z");
const context = { params: Promise.resolve({ id: "product" }) };
const load = async () =>
  (await products.findOne({ id: "product" })) as unknown as ProductDocument;
function upload(type = "front") {
  const form = new FormData();
  form.set(
    "file",
    new File(["new image bytes"], "photo.webp", { type: "image/webp" }),
  );
  form.set("viewType", type);
  return new Request("https://shop.test/api/admin/products/product/views", {
    method: "POST",
    body: form,
  });
}
const remove = (type: string) =>
  new Request(
    `https://shop.test/api/admin/products/product/views?type=${type}`,
    { method: "DELETE" },
  );

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  products = mongoStore();
  assets = mongoStore();
  // The shared memory store supports only scalar operators; model Mongo's
  // exact array/document $eq here without altering production or shared tests.
  const scalarUpdate = products.updateOne.bind(products);
  products.updateOne = async (filter, update, options) => {
    const scalar = { ...filter };
    for (const key of ["views", "productPreparation"]) {
      const expected = scalar[key];
      if (expected && typeof expected === "object" && "$eq" in expected) {
        const row = products.rows.find(
          (p) =>
            p.id === filter.id && p.organizationId === filter.organizationId,
        );
        if (!row || !isDeepStrictEqual(row[key], expected.$eq))
          return { matchedCount: 0, modifiedCount: 0 };
        delete scalar[key];
      }
    }
    return scalarUpdate(scalar, update, options);
  };
  products.rows.push({
    id: "product",
    organizationId: "org",
    createdByUserId: "demo-catalog",
    name: "Vase",
    description: "",
    sku: null,
    objectType: "vase",
    widthCm: 20,
    heightCm: 30,
    depthCm: 20,
    material: "ceramic",
    placementType: "table",
    generationInstructions: "",
    lightingProfile: {},
    buyUrl: null,
    status: "ready",
    assetId: "source",
    cutoutAssetId: "cutout",
    createdAt: originalDate,
    updatedAt: originalDate,
    views: [
      {
        id: "front-view",
        assetId: "source",
        type: "front",
        widthPx: 400,
        heightPx: 600,
        validationStatus: "valid",
        createdAt: originalDate,
      },
      {
        id: "back-view",
        assetId: "back",
        type: "back",
        widthPx: 400,
        heightPx: 600,
        validationStatus: "valid",
        createdAt: originalDate,
      },
    ],
  });
  bytes = new Map(
    ["source", "cutout", "back"].map((id) => [id, Buffer.from(`old ${id}`)]),
  );
  for (const id of bytes.keys())
    assets.rows.push({
      id,
      organizationId: "org",
      visibility: "published",
      kind: id === "cutout" ? "cutout" : "product",
      expiresAt: expiry,
    });
  mocks.collections.mockReturnValue({ products, assets });
  mocks.validateImage.mockResolvedValue(undefined);
  mocks.normalizeImage.mockImplementation(async (buffer) => buffer);
  mocks.storeAsset.mockImplementation(async (_db, input) => {
    const id = `new-${mocks.storeAsset.mock.calls.length}`;
    bytes.set(id, input.buffer);
    await assets.insertOne({
      id,
      organizationId: input.organizationId,
      kind: input.kind,
      visibility: "private",
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    });
    return { id };
  });
  mocks.deleteAsset.mockImplementation(async (_db, id: string) => {
    bytes.delete(id);
    await assets.deleteOne({ id });
  });
});

describe("admin product view retention and concurrency", () => {
  it.each(["upload", "delete"])(
    "requires explicit restoration before %s of an archived photo",
    async (action) => {
      products.rows[0]!.status = "archived";
      const before = await load();
      const response =
        action === "upload"
          ? await POST(upload(), context)
          : await DELETE(remove("front"), context);
      expect(response.status).toBe(409);
      expect(await load()).toEqual(before);
      expect(mocks.validateImage).not.toHaveBeenCalled();
      expect(mocks.storeAsset).not.toHaveBeenCalled();
      expect(mocks.deleteAsset).not.toHaveBeenCalled();
      expect(bytes.size).toBe(3);
    },
  );

  it("replaces a front photo without deleting source/cutout bytes or their expiration", async () => {
    const response = await POST(upload(), context);
    expect(response.status).toBe(201);
    const product = await load();
    expect(product.assetId).toBe("new-1");
    expect(product.status).toBe("processing");
    expect(product.cutoutAssetId).toBeUndefined();
    expect(product.views?.map((v) => v.assetId)).toEqual(["back", "new-1"]);
    for (const id of ["source", "cutout"]) {
      expect(bytes.get(id)).toEqual(Buffer.from(`old ${id}`));
      expect(await assets.findOne({ id })).toMatchObject({
        visibility: "private",
        expiresAt: expiry,
      });
    }
    expect(mocks.deleteAsset).not.toHaveBeenCalled();
  });

  it.each(["front", "back"])(
    "detaches %s without deleting its bytes or unrelated views",
    async (type) => {
      const response = await DELETE(remove(type), context);
      expect(response.status).toBe(200);
      expect((await load()).views?.map((v) => v.type)).toEqual(
        type === "front" ? ["back"] : ["front"],
      );
      expect(bytes.size).toBe(3);
      expect(
        await assets.findOne({ id: type === "front" ? "source" : "back" }),
      ).toMatchObject({ visibility: "private", expiresAt: expiry });
      expect((await load()).status).toBe(type === "front" ? "draft" : "ready");
      expect(mocks.deleteAsset).not.toHaveBeenCalled();
    },
  );

  it("stores an additional published-product view privately until its CAS succeeds", async () => {
    let beforeCommitVisibility: unknown;
    const update = products.updateOne.bind(products);
    vi.spyOn(products, "updateOne").mockImplementation(
      async (filter, change, options) => {
        beforeCommitVisibility = (await assets.findOne({ id: "new-1" }))
          ?.visibility;
        return update(filter, change, options);
      },
    );
    expect((await POST(upload("side"), context)).status).toBe(201);
    expect(mocks.storeAsset.mock.calls[0]?.[1].visibility).toBe("organization");
    expect(beforeCommitVisibility).toBe("private");
    expect(await assets.findOne({ id: "new-1" })).toMatchObject({
      visibility: "published",
    });
  });

  it("lets only one concurrent upload commit and removes only the losing new asset", async () => {
    let release!: () => void;
    let arrived = 0;
    const bothSnapshotsRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.normalizeImage.mockImplementation(async (buffer) => {
      if (++arrived === 2) release();
      await bothSnapshotsRead;
      return buffer;
    });
    const responses = await Promise.all([
      POST(upload("side"), context),
      POST(upload("top"), context),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    const product = await load();
    expect(product.views).toHaveLength(3);
    expect(product.views?.some((v) => v.assetId === "source")).toBe(true);
    expect(product.views?.some((v) => v.assetId === "back")).toBe(true);
    expect(mocks.deleteAsset).toHaveBeenCalledTimes(1);
    const discarded = mocks.deleteAsset.mock.calls[0]![1];
    expect(discarded).toMatch(/^new-/);
    expect(product.views?.some((v) => v.assetId === discarded)).toBe(false);
    expect(
      bytes.has("source") && bytes.has("cutout") && bytes.has("back"),
    ).toBe(true);
  });

  it("rejects a deletion after another view changes even with an unchanged timestamp", async () => {
    const update = products.updateOne.bind(products);
    vi.spyOn(products, "updateOne").mockImplementationOnce(
      async (filter, change, options) => {
        (products.rows[0]!.views as unknown[]).push({
          id: "concurrent",
          assetId: "other",
          type: "side",
        });
        return update(filter, change, options);
      },
    );
    expect((await DELETE(remove("back"), context)).status).toBe(409);
    expect((await load()).views).toHaveLength(3);
    expect(await assets.findOne({ id: "back" })).toMatchObject({
      visibility: "published",
    });
    expect(mocks.deleteAsset).not.toHaveBeenCalled();
  });

  it.each(["draft", "archived"])(
    "refuses upload over a concurrent publication-state change to %s",
    async (status) => {
      const update = products.updateOne.bind(products);
      vi.spyOn(products, "updateOne").mockImplementationOnce(
        async (filter, change, options) => {
          products.rows[0]!.status = status;
          return update(filter, change, options);
        },
      );
      expect((await POST(upload("side"), context)).status).toBe(409);
      expect((await load()).status).toBe(status);
      expect((await load()).views).toHaveLength(2);
      expect(mocks.deleteAsset).toHaveBeenCalledWith({}, "new-1");
    },
  );

  it("refuses publication using the old snapshot after front replacement", async () => {
    const old = await load();
    expect((await POST(upload(), context)).status).toBe(201);
    await expect(
      setProductStatus({} as Db, old, "ready"),
    ).rejects.toMatchObject({ status: 409 });
    expect((await load()).status).toBe("processing");
    expect(await assets.findOne({ id: "new-1" })).toMatchObject({
      visibility: "private",
    });
  });

  it("preserves the upload when a database error hides whether the CAS committed", async () => {
    const update = products.updateOne.bind(products);
    vi.spyOn(products, "updateOne").mockImplementationOnce(
      async (filter, change, options) => {
        await update(filter, change, options);
        throw new Error("uncertain database response");
      },
    );
    expect((await POST(upload(), context)).status).toBe(500);
    expect((await load()).assetId).toBe("new-1");
    expect(bytes.has("new-1")).toBe(true);
    expect(mocks.deleteAsset).not.toHaveBeenCalled();
  });
});
