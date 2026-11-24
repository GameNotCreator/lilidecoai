import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  addStorefrontCategory,
  adminProductSchema,
  assertStorefrontCategory,
  createProduct,
  duplicateProduct,
  resolveAdminOrganization,
  updateProduct,
} from "../lib/server/admin-products";
import { suggestGroqProductTags } from "../lib/server/groq-product-tags";
import { collections } from "../lib/server/mongodb";
import { getStorefrontCatalog } from "../lib/server/storefront";

let mongo: MongoMemoryServer;
let client: MongoClient;
let db: Db;

const productInput = {
  name: "Vase peint",
  material: "Céramique",
  placementType: "table",
  widthCm: 18,
  heightCm: 22,
  depthCm: 18,
};

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = await new MongoClient(mongo.getUri()).connect();
  db = client.db("admin_catalogue_options");
}, 60_000);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await client?.close();
  await mongo?.stop();
});

it("keeps existing categories and adds one selectable category through concurrent writes", async () => {
  const organization = await resolveAdminOrganization(db);
  const original = await getStorefrontCatalog(db);
  const attempts = await Promise.allSettled([
    addStorefrontCategory(db, organization, "Céramiques peintes"),
    addStorefrontCategory(db, organization, "Céramiques peintes"),
  ]);
  expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(
    1,
  );
  expect(attempts.find(({ status }) => status === "rejected")).toMatchObject({
    reason: { status: 409 },
  });
  const updated = await resolveAdminOrganization(db);
  assertStorefrontCategory(updated, "ceramiques-peintes");
  expect(() => assertStorefrontCategory(updated, "introuvable")).toThrow(
    "n’existe pas",
  );
  const item = await createProduct(
    db,
    updated.id,
    adminProductSchema.parse({
      ...productInput,
      sku: "DEMO-PAINT",
      storefrontCategory: "ceramiques-peintes",
    }),
  );
  await collections(db).products.updateOne(
    { id: item.id },
    { $set: { status: "ready" } },
  );
  const published = await getStorefrontCatalog(db);
  expect(published.categories).toEqual([
    ...original.categories,
    { id: "ceramiques-peintes", label: "Céramiques peintes" },
  ]);
  expect(published.products.find(({ id }) => id === item.id)).toMatchObject({
    storefrontCategory: "ceramiques-peintes",
    storefrontCategoryLabel: "Céramiques peintes",
  });
});

it("allocates distinct SKUs concurrently, avoiding existing references and preserving manual values", async () => {
  const organization = await resolveAdminOrganization(db);
  const manual = await createProduct(
    db,
    organization.id,
    adminProductSchema.parse({
      ...productInput,
      sku: "bld-0001",
      variants: [{ label: "Petite", sku: "BLD-0002" }],
    }),
  );
  expect(manual.sku).toBe("bld-0001");
  const generated = await Promise.all(
    Array.from({ length: 4 }, () =>
      createProduct(
        db,
        organization.id,
        adminProductSchema.parse(productInput),
      ),
    ),
  );
  expect(generated.map(({ sku }) => sku).sort()).toEqual([
    "BLD-0003",
    "BLD-0004",
    "BLD-0005",
    "BLD-0006",
  ]);
  const source = generated[0]!;
  expect((await updateProduct(db, source, { name: "Vase sable" })).sku).toBe(
    source.sku,
  );
  expect((await duplicateProduct(db, source)).sku).toBe("BLD-0007");
});

it("sends only the product description to Groq and normalizes validated tags", async () => {
  vi.stubEnv("GROQ_API_KEY", "synthetic-key");
  const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
    async () =>
      Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                tags: [" Céramique ", "céramique", "vase", "bleu, blanc"],
              }),
            },
          },
        ],
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  const description = "Un vase en céramique bleue.";
  expect(await suggestGroqProductTags(description)).toEqual([
    "céramique",
    "vase",
  ]);
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
  const body = JSON.parse(String(init.body));
  expect(body.model).toBe("openai/gpt-oss-20b");
  expect(
    body.messages.filter(({ role }: { role: string }) => role === "user"),
  ).toEqual([{ role: "user", content: description }]);
  expect(init.redirect).toBe("error");
  expect(String(init.body)).not.toContain("synthetic-key");
});
