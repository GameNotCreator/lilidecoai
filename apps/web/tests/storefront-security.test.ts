import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "mongodb";
import sharp from "sharp";
import { mongoStore } from "./helpers/mongo-store";

const mocks = vi.hoisted(() => ({
  collections: vi.fn(),
  tenant: vi.fn(),
  render: vi.fn(),
  seed: vi.fn(),
  refill: vi.fn(),
  readAsset: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/assets", async (original) => ({
  ...(await original<object>()),
  readAsset: mocks.readAsset,
}));
vi.mock("../lib/server/seed", () => ({
  ensureDemoSeed: mocks.seed,
  ensureDemoCredits: mocks.refill,
}));
vi.mock("../lib/server/mongodb", () => ({
  database: async () => ({}),
  collections: mocks.collections,
}));
vi.mock("../lib/server/config", async (original) => ({
  ...(await original<object>()),
  serverConfig: {
    demoMode: false,
    aiMockMode: true,
    adminOrganizationSlug: "lili",
    spatialOrganizationIds: ["org"],
  },
}));
vi.mock("../lib/server/auth", async (original) => ({
  ...(await original<object>()),
  tenantForRequest: mocks.tenant,
}));
vi.mock("../lib/server/rendering", async (original) => ({
  ...(await original<object>()),
  createRender: mocks.render,
}));
import { dispatchApi } from "../lib/server/api";
import { serverConfig } from "../lib/server/config";
import { STOREFRONT_BUDGET_UNAVAILABLE_MESSAGE } from "../lib/server/serializers";
import {
  getStorefrontCatalog,
  normalizeStorefrontRender,
} from "../lib/server/storefront";
import {
  DEMO_CATALOG_USER_ID,
  type ProductDocument,
} from "../lib/server/types";
import type { Tenant } from "../lib/server/auth";
import type { RenderInput } from "../lib/server/render-request";
import {
  ADMIN_MASK_VERSION,
  adminMaskConfiguration,
  preparationHash,
  productPreparationGeometryFingerprint,
} from "../lib/server/product-preparation";

const db = {} as Db;
const productId = "00000000-0000-4000-8000-000000000010";
const sceneId = "00000000-0000-4000-8000-000000000020";
const tenant: Tenant = {
  organizationId: "org",
  userId: "storefront:a",
  role: "viewer",
  publicSessionId: "storefront:a",
  storefront: true,
};
let products: ReturnType<typeof mongoStore>;
let organizations: ReturnType<typeof mongoStore>;
let scenes: ReturnType<typeof mongoStore>;
let renders: ReturnType<typeof mongoStore>;
let wallets: ReturnType<typeof mongoStore>;
function product(overrides: Partial<ProductDocument> = {}): ProductDocument {
  return {
    id: productId,
    organizationId: "org",
    createdByUserId: DEMO_CATALOG_USER_ID,
    name: "Vase",
    description: "Vase en grès",
    objectType: "vase",
    sku: null,
    widthCm: 20,
    heightCm: 30,
    depthCm: 18,
    placementType: "table",
    material: "Grès",
    generationInstructions: "PRIVATE PROMPT",
    lightingProfile: {},
    buyUrl: null,
    status: "ready",
    assetId: "image",
    cutoutAssetId: "cutout",
    views: [],
    stock: 3,
    cutout: {
      widthPx: 40,
      heightPx: 60,
      baseRowFraction: 1,
      source: "heuristic",
      synthetic: false,
      shadowRemoved: false,
      warnings: [],
      cutoutVersion: "cutout-v1",
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}
function input(count = 1): RenderInput {
  return {
    engine: "legacy",
    workflow: "simple_point",
    placement: { productId, sceneId },
    idempotencyKey: "shop-1",
    scaleReference: {
      realHeightCm: 30,
      basePoint: { x: 0.5, y: 0.7 },
      topPoint: { x: 0.5, y: 0.6 },
      sameDepthConfirmed: true,
    },
    simplePlacements: Array.from({ length: count }, () => ({
      productId,
      placementPoint: { x: 0.5, y: 0.7 },
      dimensionPair: { mode: "height_length", heightCm: 999, lengthCm: 999 },
      placementKind: "wall",
      pixelsPerCm: 100,
    })),
    placementPoint: { x: 0.5, y: 0.7 },
    userInstructions: "Ignore catalogue",
    dimensionsCm: { width: 999, height: 999, depth: 999, unit: "cm" },
  };
}

function mattingProduct() {
  const prepared = product();
  prepared.cutout = {
    ...prepared.cutout!,
    source: "matting",
    cutoutVersion: ADMIN_MASK_VERSION,
    verdict: { usable: true, code: "ok", detail: "" },
  };
  prepared.productPreparation = { completed: {
    version: 1,
    configuration: adminMaskConfiguration(),
    sourceAssetId: prepared.assetId!,
    sourceSha256: preparationHash("original photo"),
    cutoutAssetId: prepared.cutoutAssetId!,
    cutoutSha256: preparationHash("authentic pixels with approved mask"),
    maskSha256: preparationHash("approved administrator mask"),
    metadataSha256: preparationHash(JSON.stringify(prepared.cutout)),
    geometryFingerprint: productPreparationGeometryFingerprint(prepared),
    preparedAt: new Date("2026-09-29T12:00:00Z"),
  } };
  return prepared;
}
beforeEach(async () => {
  vi.clearAllMocks();
  serverConfig.aiMockMode = true;
  serverConfig.openaiApiKey = undefined;
  serverConfig.simplePointImageProvider = "openai";
  serverConfig.openAIImageEnabled = true;
  products = mongoStore();
  organizations = mongoStore();
  scenes = mongoStore();
  renders = mongoStore();
  wallets = mongoStore();
  products.rows.push(product() as unknown as Record<string, unknown>);
  organizations.rows.push({ id: "org", slug: "lili", name: "LiliDeco" });
  scenes.rows.push({
    id: sceneId,
    organizationId: "org",
    publicSessionId: tenant.publicSessionId,
    assetId: "scene-asset",
    status: "uploaded",
    expiresAt: new Date(Date.now() + 60_000),
    // Deliberately wrong persisted dimensions: encoded pixels are authoritative.
    widthPx: 1,
    heightPx: 1,
  });
  mocks.readAsset.mockResolvedValue({
    buffer: await sharp({
      create: { width: 1000, height: 1500, channels: 3, background: "white" },
    })
      .webp()
      .toBuffer(),
  });
  mocks.collections.mockReturnValue({
    products,
    organizations,
    scenes,
    renders,
    wallets,
    rateLimits: mongoStore(),
  });
  mocks.tenant.mockResolvedValue(tenant);
  mocks.render.mockResolvedValue({ id: "render" });
});
describe("public concept store boundary", () => {
  it.each([undefined, false, true])("only preserves explicit replacement consent (%s)", async (replaceExisting) => {
    const normalized = await normalizeStorefrontRender(db, tenant, { ...input(), replaceExisting });
    if (replaceExisting === true) expect(normalized.replaceExisting).toBe(true);
    else expect(normalized).not.toHaveProperty("replaceExisting");
    expect(normalized.mode).toBe("insert");
    expect(normalized.preserveBackground).toBe(true);
  });
  it("cannot read or expire another visitor's overdue render", async () => {
    const renderId = "00000000-0000-4000-8000-000000000030";
    const otherRender = {
      id: renderId,
      organizationId: tenant.organizationId,
      publicSessionId: "storefront:other",
      engine: "legacy",
      status: "processing",
      createdAt: new Date(Date.now() - 180_000),
      requestSnapshot: { version: 1, input: { workflow: "simple_point" } },
    };
    renders.rows.push(otherRender);
    const response = await dispatchApi(
      new Request(`http://test/v1/renders/${renderId}`),
      ["renders", renderId],
    );
    expect(response.status).toBe(404);
    expect(renders.rows[0]).toEqual(otherRender);
    expect(renders.rows[0]).not.toHaveProperty("error");
    expect(renders.rows[0]).not.toHaveProperty("execution");
  });
  it("cannot replenish a production store through the old demo endpoints", async () => {
    expect(
      (
        await dispatchApi(
          new Request("http://test/v1/auth/signup", {
            method: "POST",
            body: JSON.stringify({
              email: "new@example.com",
              password: "test-password-value",
            }),
          }),
          ["auth", "signup"],
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await dispatchApi(
          new Request("http://test/v1/auth/guest", { method: "POST" }),
          ["auth", "guest"],
        )
      ).status,
    ).toBe(403);
    organizations.rows[0]!.slug = "atelier-lili";
    expect(
      (
        await dispatchApi(
          new Request(`http://test/v1/visualizer/atelier-lili/${productId}`),
          ["visualizer", "atelier-lili", productId],
        )
      ).status,
    ).toBe(200);
    expect(mocks.seed).not.toHaveBeenCalled();
    expect(mocks.refill).not.toHaveBeenCalled();
  });
  it("closes widget token minting and previously signed visitor sessions for the managed store", async () => {
    expect(
      (
        await dispatchApi(
          new Request(`http://test/v1/visualizer/lili/${productId}`),
          ["visualizer", "lili", productId],
        )
      ).status,
    ).toBe(403);
    mocks.tenant.mockResolvedValue({
      organizationId: "org",
      userId: "public:old",
      role: "viewer",
      publicSessionId: "old",
      publicProductId: productId,
    });
    expect(
      (
        await dispatchApi(
          new Request("http://test/v1/renders/final", {
            method: "POST",
            body: JSON.stringify(input()),
          }),
          ["renders", "final"],
        )
      ).status,
    ).toBe(403);
    expect(mocks.render).not.toHaveBeenCalled();
  });
  it("does not expose paid scale estimation before a reserved render", async () => {
    expect(
      (
        await dispatchApi(
          new Request(`http://test/v1/scenes/${sceneId}/scale`, {
            method: "POST",
            body: JSON.stringify({ points: [{ x: 0.5, y: 0.5 }] }),
          }),
          ["scenes", sceneId, "scale"],
        )
      ).status,
    ).toBe(403);
    expect(mocks.render).not.toHaveBeenCalled();
  });
  it("lists only the managed published catalogue without internal instructions", async () => {
    for (const overrides of [
      { status: "draft" },
      { status: "archived" },
      { organizationId: "other" },
      { createdByUserId: "guest:a" },
    ])
      products.rows.push(
        product({
          id: crypto.randomUUID(),
          ...overrides,
        } as Partial<ProductDocument>) as unknown as Record<string, unknown>,
      );
    const catalog = await getStorefrontCatalog(db);
    expect(catalog.products).toHaveLength(1);
    expect(catalog.products[0]?.visualizationAvailable).toBe(true);
    expect(JSON.stringify(catalog)).not.toContain("PRIVATE PROMPT");
    expect(catalog.products[0]).not.toHaveProperty("organizationId");
  });
  it("does not create an organization or fund a wallet when browsing an empty store", async () => {
    organizations.rows.length = 0;
    expect((await getStorefrontCatalog(db)).products).toEqual([]);
    expect(organizations.rows).toEqual([]);
  });
  it("lists a published commercial product without a cutout but refuses its visualization", async () => {
    delete products.rows[0]!.cutoutAssetId;
    delete products.rows[0]!.cutout;
    const catalog = await getStorefrontCatalog(db);
    expect(catalog.products).toHaveLength(1);
    expect(catalog.products[0]?.visualizationAvailable).toBe(false);
    await expect(
      normalizeStorefrontRender(db, tenant, input()),
    ).rejects.toThrow("indisponible");
    expect(mocks.render).not.toHaveBeenCalled();
  });
  it("keeps a published product with a validated administrator mask available", async () => {
    products.rows[0] = mattingProduct() as unknown as Record<string, unknown>;
    expect((await getStorefrontCatalog(db)).products[0]?.visualizationAvailable).toBe(true);
    const normalized = await normalizeStorefrontRender(db, tenant, input());
    expect(normalized.simplePlacements?.[0]?.productId).toBe(productId);
  });
  it.each(["dimensions", "source", "cutout", "metadata", "missing-mask", "invalid-mask", "configuration", "failure", "veto", "lease"])(
    "keeps the matting product blocked after %s changes", async (change) => {
      const prepared = mattingProduct();
      const completed = prepared.productPreparation!.completed!;
      if (change === "dimensions") prepared.widthCm += 1;
      if (change === "source") prepared.assetId = "other-source";
      if (change === "cutout") prepared.cutoutAssetId = "other-cutout";
      if (change === "metadata") prepared.cutout!.widthPx += 1;
      if (change === "missing-mask") delete completed.maskSha256;
      if (change === "invalid-mask") completed.maskSha256 = "invalid";
      if (change === "configuration") completed.configuration = "unknown-method";
      if (change === "failure") prepared.productPreparation!.failure = { sourceAssetId: prepared.assetId!, detail: "Masque refusé", at: new Date() };
      if (change === "veto") prepared.visualizationBlockedReason = "Identité à revérifier";
      if (change === "lease") prepared.productPreparation!.lease = { token: "active", sourceAssetId: prepared.assetId!, expiresAt: new Date(Date.now() + 60_000) };
      products.rows[0] = prepared as unknown as Record<string, unknown>;
      expect((await getStorefrontCatalog(db)).products[0]?.visualizationAvailable).toBe(false);
      await expect(normalizeStorefrontRender(db, tenant, input())).rejects.toThrow("indisponible");
      expect(mocks.render).not.toHaveBeenCalled();
    },
  );
  it("applies a catalog veto even to an otherwise trusted legacy cutout without preparation tracking", async () => {
    products.rows[0]!.visualizationBlockedReason =
      "Photo avec plante non incluse dans le produit";
    const catalog = await getStorefrontCatalog(db);
    expect(catalog.products).toHaveLength(1);
    expect(catalog.products[0]?.visualizationAvailable).toBe(false);
    expect(catalog.products[0]).not.toHaveProperty(
      "visualizationBlockedReason",
    );
    await expect(
      normalizeStorefrontRender(db, tenant, input()),
    ).rejects.toThrow("indisponible");
    expect(mocks.render).not.toHaveBeenCalled();
  });
  it.each([
    {},
    {
      failure: {
        sourceAssetId: "image",
        detail: "Photo à reprendre",
        at: new Date(),
      },
    },
    {
      lease: {
        token: "preparing",
        sourceAssetId: "image",
        expiresAt: new Date(Date.now() + 60_000),
      },
    },
  ])(
    "blocks new visualization while a tracked preparation is not ready: %j",
    async (preparation) => {
      products.rows[0]!.productPreparation = preparation;
      expect(
        (await getStorefrontCatalog(db)).products[0]?.visualizationAvailable,
      ).toBe(false);
      await expect(
        normalizeStorefrontRender(db, tenant, input()),
      ).rejects.toThrow("indisponible");
      expect(mocks.render).not.toHaveBeenCalled();
    },
  );
  it("uses catalogue dimensions and placement instead of client overrides", async () => {
    const normalized = await normalizeStorefrontRender(db, tenant, input(3));
    expect(normalized.simplePlacements).toHaveLength(3);
    expect(normalized.simplePlacements?.[0]).toEqual({
      productId,
      placementPoint: { x: 0.5, y: 0.7 },
      dimensionPair: { mode: "height_length", heightCm: 30, lengthCm: 20 },
      placementKind: "standing",
      pixelsPerCm: expect.closeTo(5, 8),
    });
    expect(normalized).not.toHaveProperty("userInstructions");
    expect(normalized).not.toHaveProperty("dimensionsCm");
    expect(normalized.preserveBackground).toBe(true);
  });
  it("admits an estimated placement without a reference while dropping arbitrary client scale", async () => {
    const request = input();
    delete request.scaleReference;
    const response = await dispatchApi(
      new Request("http://test/v1/renders/final", {
        method: "POST",
        body: JSON.stringify(request),
      }),
      ["renders", "final"],
    );
    expect(response.status).toBe(201);
    expect(mocks.render).toHaveBeenCalledOnce();
    expect(mocks.render.mock.calls[0]?.[2]).not.toHaveProperty(
      "scaleReference",
    );
    expect(
      mocks.render.mock.calls[0]?.[2].simplePlacements[0],
    ).not.toHaveProperty("pixelsPerCm");
    expect(mocks.readAsset).not.toHaveBeenCalled();
  });
  it("refuses a reference on another depth, a horizontal measure and a reference too small", async () => {
    for (const patch of [
      { basePoint: { x: 0.5, y: 0.9 }, topPoint: { x: 0.5, y: 0.8 } },
      { topPoint: { x: 0.7, y: 0.7 } },
      { topPoint: { x: 0.5, y: 0.699 } },
    ])
      await expect(
        normalizeStorefrontRender(db, tenant, {
          ...input(),
          scaleReference: { ...input().scaleReference!, ...patch },
        }),
      ).rejects.toThrow();
    expect(mocks.render).not.toHaveBeenCalled();
  });
  it("uses EXIF-oriented encoded dimensions instead of a forged client scale or scene width", async () => {
    const rotated = await sharp({
      create: { width: 1500, height: 1000, channels: 3, background: "white" },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    mocks.readAsset.mockResolvedValue({ buffer: rotated });
    const normalized = await normalizeStorefrontRender(db, tenant, input());
    expect(normalized.simplePlacements?.[0]?.pixelsPerCm).toBeCloseTo(5);
    expect(normalized.scaleReference).toEqual(input().scaleReference);
  });
  it("does not read another visitor's scene bytes while normalizing a reference", async () => {
    scenes.rows[0]!.publicSessionId = "storefront:other";
    await expect(
      normalizeStorefrontRender(db, tenant, input()),
    ).rejects.toThrow("photo");
    expect(mocks.readAsset).not.toHaveBeenCalled();
  });
  it.each([0, 4])("rejects %i items", async (count) => {
    await expect(
      normalizeStorefrontRender(db, tenant, input(count)),
    ).rejects.toThrow("un et trois");
  });
  it.each([
    { status: "draft" },
    { status: "archived" },
    { organizationId: "other" },
    { createdByUserId: "guest:a" },
    { stock: 0 },
    { cutout: undefined },
  ])("rejects unavailable product %j", async (patch) => {
    Object.assign(products.rows[0]!, patch);
    await expect(
      normalizeStorefrontRender(db, tenant, input()),
    ).rejects.toThrow();
  });
  it("counts duplicate quantities against stock", async () => {
    products.rows[0]!.stock = 2;
    await expect(
      normalizeStorefrontRender(db, tenant, input(3)),
    ).rejects.toThrow("stock");
  });
  it("rejects internal spatial and standard workflows explicitly", async () => {
    await expect(
      normalizeStorefrontRender(db, tenant, { ...input(), engine: "spatial" }),
    ).rejects.toThrow("pas ouvert");
    await expect(
      normalizeStorefrontRender(db, tenant, {
        ...input(),
        workflow: "standard",
      }),
    ).rejects.toThrow("pas ouvert");
  });
  it("never starts provider work for a different visitor's scene", async () => {
    scenes.rows[0]!.publicSessionId = "storefront:other";
    const response = await dispatchApi(
      new Request("http://test/v1/renders/final", {
        method: "POST",
        body: JSON.stringify(input()),
      }),
      ["renders", "final"],
    );
    expect(response.status).toBe(403);
    expect(mocks.render).not.toHaveBeenCalled();
  });
  it("normalizes the public API before starting the render", async () => {
    const response = await dispatchApi(
      new Request("http://test/v1/renders/final", {
        method: "POST",
        body: JSON.stringify({ ...input(), replaceExisting: true }),
      }),
      ["renders", "final"],
    );
    expect(response.status).toBe(201);
    expect(
      mocks.render.mock.calls[0]?.[2].simplePlacements[0].dimensionPair
        .heightCm,
    ).toBe(30);
    expect(mocks.render.mock.calls[0]?.[3]).toBe("storefront:a");
    expect(mocks.render.mock.calls[0]?.[2].replaceExisting).toBe(true);
  });
  it.each([
    null,
    { organizationId: "org", balance: 0 },
    { organizationId: "org", balance: -1 },
    {
      organizationId: "org",
      balance: 0,
      reserved: 1,
      holds: [{ key: "render:in-flight" }],
    },
    { organizationId: "other", balance: 100 },
  ])(
    "refuses an unfunded real shop request before admission without spending or replenishing: %j",
    async (wallet) => {
      serverConfig.aiMockMode = false;
      serverConfig.openaiApiKey = "test-configuration-only";
      if (wallet) wallets.rows.push(wallet);
      const walletBefore = structuredClone(wallets.rows);
      const lookup = vi.spyOn(wallets, "findOne");
      const response = await dispatchApi(
        new Request("http://test/v1/renders/final", {
          method: "POST",
          body: JSON.stringify(input()),
        }),
        ["renders", "final"],
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        detail: STOREFRONT_BUDGET_UNAVAILABLE_MESSAGE,
      });
      expect(lookup).toHaveBeenCalledWith({
        organizationId: "org",
        balance: { $gte: 1 },
      });
      expect(mocks.render).not.toHaveBeenCalled();
      expect(renders.rows).toEqual([]);
      expect(wallets.rows).toEqual(walletBefore);
      expect(mocks.seed).not.toHaveBeenCalled();
      expect(mocks.refill).not.toHaveBeenCalled();
    },
  );
  it("admits a funded real shop request without consuming the worker's reservation", async () => {
    serverConfig.aiMockMode = false;
    serverConfig.openaiApiKey = "test-configuration-only";
    wallets.rows.push({
      organizationId: "org",
      balance: 1,
      reserved: 0,
      holds: [],
    });
    const response = await dispatchApi(
      new Request("http://test/v1/renders/final", {
        method: "POST",
        body: JSON.stringify(input()),
      }),
      ["renders", "final"],
    );
    expect(response.status).toBe(201);
    expect(mocks.render).toHaveBeenCalledOnce();
    expect(wallets.rows).toEqual([
      { organizationId: "org", balance: 1, reserved: 0, holds: [] },
    ]);
  });
  it("recovers an admitted real shop request even after the wallet is empty and its product archived", async () => {
    serverConfig.aiMockMode = false;
    serverConfig.openaiApiKey = "test-configuration-only";
    wallets.rows.push({ organizationId: "org", balance: 0 });
    const lookup = vi.spyOn(wallets, "findOne");
    const renderId = "00000000-0000-4000-8000-000000000030";
    renders.rows.push({
      id: renderId,
      organizationId: "org",
      publicSessionId: "storefront:a",
      engine: "legacy",
      idempotencyKey: "shop-1",
      status: "queued",
      createdAt: new Date(),
      placement: { sceneId, productId },
    });
    products.rows[0]!.status = "archived";
    const response = await dispatchApi(
      new Request("http://test/v1/renders/final", {
        method: "POST",
        body: JSON.stringify(input()),
      }),
      ["renders", "final"],
    );
    expect(response.status).toBe(200);
    expect((await response.json()).id).toBe(renderId);
    expect(lookup).not.toHaveBeenCalled();
    expect(mocks.render).not.toHaveBeenCalled();
    expect(wallets.rows).toEqual([{ organizationId: "org", balance: 0 }]);
  });
  it("refuses a new paid retry before admission when the shop wallet is empty", async () => {
    serverConfig.aiMockMode = false;
    serverConfig.openaiApiKey = "test-configuration-only";
    wallets.rows.push({ organizationId: "org", balance: 0 });
    renders.rows.push({
      id: "old",
      organizationId: "org",
      publicSessionId: "storefront:a",
      engine: "legacy",
      status: "failed",
      requestSnapshot: { version: 1, input: input() },
    });
    const rendersBefore = structuredClone(renders.rows);
    const response = await dispatchApi(
      new Request("http://test/v1/renders/old/retry", { method: "POST" }),
      ["renders", "old", "retry"],
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      detail: STOREFRONT_BUDGET_UNAVAILABLE_MESSAGE,
    });
    expect(mocks.render).not.toHaveBeenCalled();
    expect(renders.rows).toEqual(rendersBefore);
    expect(wallets.rows).toEqual([{ organizationId: "org", balance: 0 }]);
  });
  it("rechecks publication when retrying an old render", async () => {
    renders.rows.push({
      id: "old",
      organizationId: "org",
      publicSessionId: "storefront:a",
      engine: "legacy",
      requestSnapshot: { version: 1, input: input() },
    });
    products.rows[0]!.status = "archived";
    const response = await dispatchApi(
      new Request("http://test/v1/renders/old/retry", { method: "POST" }),
      ["renders", "old", "retry"],
    );
    expect(response.status).toBe(409);
    expect(mocks.render).not.toHaveBeenCalled();
  });
  it("recovers a lost response from the same session after the product was archived", async () => {
    renders.rows.push({
      id: "admitted",
      organizationId: "org",
      publicSessionId: "storefront:a",
      engine: "legacy",
      idempotencyKey: "shop-1",
      status: "queued",
      createdAt: new Date(),
      placement: { sceneId, productId },
    });
    products.rows[0]!.status = "archived";
    const response = await dispatchApi(
      new Request("http://test/v1/renders/final", {
        method: "POST",
        body: JSON.stringify(input()),
      }),
      ["renders", "final"],
    );
    expect(response.status).toBe(200);
    expect((await response.json()).id).toBe("admitted");
    expect(mocks.render).not.toHaveBeenCalled();
    renders.rows[0]!.publicSessionId = "storefront:other";
    expect(
      (
        await dispatchApi(
          new Request("http://test/v1/renders/final", {
            method: "POST",
            body: JSON.stringify(input()),
          }),
          ["renders", "final"],
        )
      ).status,
    ).toBe(409);
  });
  it.each([
    ["products"],
    ["credits"],
    ["scenes", sceneId, "prepare"],
    ["renders", "by-request", "key"],
  ])("refuses unrelated API routes %j", async (...path) => {
    const response = await dispatchApi(
      new Request(`http://test/v1/${path.join("/")}`),
      path,
    );
    expect(response.status).toBe(403);
  });
  it("rejects cross-origin mutations before generating", async () => {
    const response = await dispatchApi(
      new Request("http://test/v1/renders/final", {
        method: "POST",
        headers: { origin: "https://other.test" },
        body: JSON.stringify(input()),
      }),
      ["renders", "final"],
    );
    expect(response.status).toBe(403);
    expect(mocks.render).not.toHaveBeenCalled();
  });
});
