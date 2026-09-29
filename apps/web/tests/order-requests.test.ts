import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { randomUUID } from "node:crypto";

const mocks = vi.hoisted(() => ({ catalog: vi.fn(), organization: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/config", () => ({
  serverConfig: {
    sessionSecret: "private-order-tests-only-secret-32-characters",
  },
}));
vi.mock("../lib/server/storefront", () => ({
  getStorefrontCatalog: mocks.catalog,
  storefrontOrganization: mocks.organization,
}));

import { orderRequestSchema } from "../lib/checkout";
import { storefrontProductSchema } from "../lib/storefront";
import {
  checkoutAvailability,
  createOrderRequest,
  listOrderRequests,
  notifyOrderRequest,
  orderRequestRetentionDays,
  orderRequests,
  quoteOrderItems,
  retryOrderNotification,
  updateOrderRequest,
} from "../lib/server/order-requests";
import {
  buildOrderNotification,
  orderEmailConfiguration,
} from "../lib/server/order-email";
import { readOrderBody } from "../lib/server/order-http";

const id = "00000000-0000-4000-8000-000000000001";
const product = storefrontProductSchema.parse({
  id,
  name: "Grenade",
  objectType: "vase",
  widthCm: 14,
  heightCm: 14,
  depthCm: 14,
  placementType: "table",
  material: "Céramique",
  visualizationAvailable: false,
  priceCents: 11500,
  currency: "TND",
  stock: null,
});
const input = () => ({
  idempotencyKey: randomUUID(),
  fullName: "Client test",
  phone: "+216 22 000 001",
  city: "Tunis",
  email: "customer@example.test",
  address: "",
  note: "",
  consent: true as const,
  website: "" as const,
  items: [{ productId: id, quantity: 2 }],
});

describe("private order requests with real local Mongo and mocked Resend", () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let mail: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({
      instance: { storageEngine: "wiredTiger" },
    });
    client = await new MongoClient(mongo.getUri()).connect();
    db = client.db(`order_tests_${randomUUID().replaceAll("-", "")}`);
    await db.collection("rate_limits").createIndex({ id: 1 }, { unique: true });
  }, 60_000);
  afterAll(async () => {
    await client?.close();
    await mongo?.stop();
  });
  beforeEach(async () => {
    await db.collection("storefront_order_requests").deleteMany({});
    await db.collection("rate_limits").deleteMany({});
    vi.stubEnv("STOREFRONT_ORDERS_ENABLED", "true");
    vi.stubEnv("RESEND_API_KEY", "test-key-never-transmitted");
    vi.stubEnv("RESEND_FROM_EMAIL", "ByLiliDeco <shop@example.test>");
    vi.stubEnv("ORDER_EMAIL_TO", "merchant@example.test");
    vi.stubEnv("ORDER_REQUEST_RETENTION_DAYS", "90");
    mocks.catalog.mockResolvedValue({ products: [product] });
    mocks.organization.mockResolvedValue({ id: "org" });
    mail = vi.fn(async () => Response.json({ id: "mail-test-id" }));
    vi.stubGlobal("fetch", mail);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("stays closed unless explicitly enabled and email configured", async () => {
    vi.stubEnv("STOREFRONT_ORDERS_ENABLED", "false");
    expect(checkoutAvailability().available).toBe(false);
    await expect(
      createOrderRequest(db, input(), "127.0.0.1"),
    ).rejects.toMatchObject({ status: 503 });
    vi.stubEnv("STOREFRONT_ORDERS_ENABLED", "true");
    vi.stubEnv("RESEND_FROM_EMAIL", "");
    expect(checkoutAvailability().available).toBe(false);
    expect(await orderRequests(db).countDocuments()).toBe(0);
    expect(mail).not.toHaveBeenCalled();
  });

  it("calculates authoritative amounts, stores a quote, sends only to configured merchant and returns no PII", async () => {
    const request = input();
    const result = await createOrderRequest(db, request, "203.0.113.1");
    expect(result).toEqual({
      reference: expect.stringMatching(/^BLD-/),
      recorded: true,
      notification: "sent",
    });
    const saved = (await orderRequests(db).findOne({}))!;
    expect(saved.subtotalCents).toBe(23000);
    expect(saved.items[0]).toMatchObject({
      unitPriceCents: 11500,
      stockToConfirm: true,
    });
    expect(saved.status).toBe("new");
    expect(saved.expiresAt.getTime() - saved.createdAt.getTime()).toBe(
      90 * 86400_000,
    );
    const payload = JSON.parse(mail.mock.calls[0]![1].body);
    expect(payload.to).toEqual(["merchant@example.test"]);
    expect(payload.reply_to).toBe(request.email);
    expect(payload.text).toContain("Aucun paiement ni réservation");
    expect(payload).not.toHaveProperty("cc");
    expect(payload).not.toHaveProperty("bcc");
    expect(JSON.stringify(result)).not.toContain(request.phone);
    const limits = await db.collection("rate_limits").find({}).toArray();
    expect(JSON.stringify(limits)).not.toContain("203.0.113.1");
    expect(JSON.stringify(limits)).not.toContain(request.phone);
  });

  it("persists and emails once across concurrent duplicate submissions", async () => {
    const request = input();
    const results = await Promise.all(
      Array.from({ length: 2 }, () =>
        createOrderRequest(db, request, "203.0.113.2"),
      ),
    );
    expect(new Set(results.map((result) => result.reference)).size).toBe(1);
    expect(await orderRequests(db).countDocuments()).toBe(1);
    expect(mail).toHaveBeenCalledTimes(1);
    const replay = await createOrderRequest(db, request, "203.0.113.2");
    expect(replay.reference).toBe(results[0]!.reference);
    expect(mail).toHaveBeenCalledTimes(1);
  });

  it("rejects idempotency reuse with changed contact data", async () => {
    const request = input();
    await createOrderRequest(db, request, "203.0.113.3");
    await expect(
      createOrderRequest(
        db,
        { ...request, fullName: "Different customer" },
        "203.0.113.3",
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(mail).toHaveBeenCalledTimes(1);
  });

  it("keeps a request after provider failure and explicitly retries with the identical key", async () => {
    mail.mockResolvedValueOnce(
      Response.json({ message: "private provider detail" }, { status: 503 }),
    );
    const request = input();
    expect(
      (await createOrderRequest(db, request, "203.0.113.4")).notification,
    ).toBe("pending");
    const saved = (await orderRequests(db).findOne({}))!;
    expect(saved.notification.status).toBe("failed");
    expect(JSON.stringify(saved)).not.toContain("private provider detail");
    await createOrderRequest(db, request, "203.0.113.4");
    expect(mail).toHaveBeenCalledTimes(1);
    await retryOrderNotification(db, "org", saved.id);
    expect(mail).toHaveBeenCalledTimes(2);
    expect(mail.mock.calls[0]![1].headers["Idempotency-Key"]).toBe(
      mail.mock.calls[1]![1].headers["Idempotency-Key"],
    );
    expect((await orderRequests(db).findOne({}))!.notification.status).toBe(
      "sent",
    );
  });

  it("never replays an uncertain provider request beyond the safe key window", async () => {
    await createOrderRequest(db, input(), "203.0.113.5");
    const saved = (await orderRequests(db).findOne({}))!;
    await orderRequests(db).updateOne(
      { _id: saved._id },
      {
        $set: {
          notification: {
            status: "failed",
            firstAttemptAt: new Date(Date.now() - 24 * 3600_000),
          },
        },
      },
    );
    await expect(
      retryOrderNotification(db, "org", saved.id),
    ).rejects.toMatchObject({ status: 409 });
    const stale = (await orderRequests(db).findOne({}))!;
    await notifyOrderRequest(db, stale);
    expect(mail).toHaveBeenCalledTimes(1);
  });

  it("scopes reads and changes to the admin organization and omits internal fingerprints", async () => {
    await createOrderRequest(db, input(), "203.0.113.6");
    const rows = await listOrderRequests(db, "org");
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("fingerprint");
    expect(rows[0]).not.toHaveProperty("_id");
    expect(await listOrderRequests(db, "other")).toEqual([]);
    await expect(
      updateOrderRequest(db, "other", rows[0]!.id, "closed"),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      retryOrderNotification(db, "other", rows[0]!.id),
    ).rejects.toMatchObject({ status: 404 });
    await updateOrderRequest(db, "org", rows[0]!.id, "contacted");
    expect((await listOrderRequests(db, "org"))[0]!.status).toBe("contacted");
    await orderRequests(db).updateOne({}, { $set: { expiresAt: new Date(0) } });
    expect(await listOrderRequests(db, "org")).toEqual([]);
  });

  it("blocks a fourth new request on the same phone even across client IPs", async () => {
    for (let i = 0; i < 3; i++)
      await createOrderRequest(db, input(), `203.0.113.${10 + i}`);
    await expect(
      createOrderRequest(db, input(), "203.0.113.99"),
    ).rejects.toMatchObject({ status: 429 });
    expect(await orderRequests(db).countDocuments()).toBe(3);
  });

  it("escapes HTML content and omits customer email when not provided", async () => {
    const request = { ...input(), fullName: '<img src="x">', email: "" };
    await createOrderRequest(db, request, "203.0.113.7");
    const payload = JSON.parse(mail.mock.calls[0]![1].body);
    expect(payload.html).not.toContain('<img src="x">');
    expect(payload.html).toContain("&lt;img");
    expect(payload).not.toHaveProperty("reply_to");
    expect(
      buildOrderNotification((await orderRequests(db).findOne({}))!).text,
    ).toContain(request.fullName);
  });
});

describe("order input and amount boundary", () => {
  it("rejects browser prices, repeated IDs, honeypots and absent consent", () => {
    expect(
      orderRequestSchema.safeParse({ ...input(), subtotalCents: 1 }).success,
    ).toBe(false);
    expect(
      orderRequestSchema.safeParse({
        ...input(),
        items: [{ productId: id, quantity: 1, price: 1 }],
      }).success,
    ).toBe(false);
    expect(
      orderRequestSchema.safeParse({
        ...input(),
        items: [
          { productId: id, quantity: 1 },
          { productId: id, quantity: 1 },
        ],
      }).success,
    ).toBe(false);
    expect(
      orderRequestSchema.safeParse({ ...input(), website: "spam.test" })
        .success,
    ).toBe(false);
    expect(
      orderRequestSchema.safeParse({ ...input(), consent: false }).success,
    ).toBe(false);
  });
  it("rejects missing products, unavailable stock, non-TND and invalid prices", () => {
    const items = input().items;
    expect(() => quoteOrderItems(items, [])).toThrow(/plus disponible/);
    expect(() => quoteOrderItems(items, [{ ...product, stock: 1 }])).toThrow(
      /quantité/,
    );
    expect(() =>
      quoteOrderItems(items, [{ ...product, currency: "EUR" }]),
    ).toThrow(/prix/);
    expect(() =>
      quoteOrderItems(items, [{ ...product, priceCents: -1 }]),
    ).toThrow(/prix/);
    expect(
      quoteOrderItems(items, [{ ...product, priceCents: null }]).subtotalCents,
    ).toBeNull();
  });
  it("keeps a bounded retention policy and validates configured addresses", () => {
    for (const value of ["0", "-1", "NaN", "366"]) {
      vi.stubEnv("ORDER_REQUEST_RETENTION_DAYS", value);
      expect(orderRequestRetentionDays()).toBe(90);
    }
    vi.stubEnv("ORDER_REQUEST_RETENTION_DAYS", "30");
    expect(orderRequestRetentionDays()).toBe(30);
    vi.stubEnv("RESEND_API_KEY", "test");
    vi.stubEnv(
      "RESEND_FROM_EMAIL",
      "sender@example.test\nBcc: victim@example.test",
    );
    vi.stubEnv("ORDER_EMAIL_TO", "merchant@example.test");
    expect(orderEmailConfiguration()).toBeNull();
    vi.unstubAllEnvs();
  });
  it("rejects overlarge, invalid JSON and wrong content types before parsing", async () => {
    const request = (body: string, type = "application/json") =>
      new Request("https://shop.test/orders", {
        method: "POST",
        headers: { "Content-Type": type },
        body,
      });
    await expect(
      readOrderBody(request("x".repeat(17_000))),
    ).rejects.toMatchObject({ status: 413 });
    await expect(readOrderBody(request("{"))).rejects.toMatchObject({
      status: 422,
    });
    await expect(
      readOrderBody(request("{}", "application/json-invalid")),
    ).rejects.toMatchObject({ status: 415 });
    expect(await readOrderBody(request('{"ok":true}'))).toEqual({ ok: true });
  });
});
