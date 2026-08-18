import { describe, expect, it } from "vitest";

import {
  adminProductPatchSchema,
  adminProductSchema,
  listQuerySchema,
  normalizeTags,
} from "../lib/server/admin-product-schema";

const minimal = {
  name: "Vase Sienne",
  material: "Céramique mate",
  placementType: "table",
  widthCm: 28,
  heightCm: 46,
  depthCm: 28,
};

describe("product creation payload", () => {
  it("fills the optional catalogue fields with usable defaults", () => {
    const product = adminProductSchema.parse(minimal);
    expect(product).toMatchObject({
      description: "",
      objectType: "other",
      brand: "",
      collection: "",
      currency: "TND",
      generationInstructions: "",
      lightingSource: "front",
      reflectance: "matte",
      tags: [],
      variants: [],
      sku: null,
      buyUrl: null,
      priceCents: null,
      stock: null,
      weightKg: null,
    });
  });

  it("accepts form strings and clamps the numbers", () => {
    const product = adminProductSchema.parse({
      ...minimal,
      widthCm: "28.5",
      priceCents: "18900",
      stock: 999_999_999,
      currency: "tnd",
      tags: "salon, salon , terracotta",
    });
    expect(product.widthCm).toBe(28.5);
    expect(product.priceCents).toBe(18_900);
    expect(product.stock).toBe(1_000_000);
    expect(product.currency).toBe("tnd");
    expect(product.tags).toEqual(["salon", "terracotta"]);
  });

  it("refuses a buy link that is not http(s)", () => {
    expect(() =>
      adminProductSchema.parse({ ...minimal, buyUrl: "javascript:alert(1)" }),
    ).toThrow();
    expect(
      adminProductSchema.parse({ ...minimal, buyUrl: "https://x.test/a" })
        .buyUrl,
    ).toBe("https://x.test/a");
  });

  it("requires a label on every size", () => {
    expect(() =>
      adminProductSchema.parse({ ...minimal, variants: [{ label: "" }] }),
    ).toThrow();
    const [variant] = adminProductSchema.parse({
      ...minimal,
      variants: [{ label: "Grand modèle", priceCents: 24_900 }],
    }).variants;
    expect(variant).toMatchObject({
      label: "Grand modèle",
      priceCents: 24_900,
      available: true,
      sku: null,
      widthCm: null,
    });
  });
});

describe("partial product update", () => {
  // Regression: `.partial()` keeps applying `.default()` to absent keys, which
  // erased the description, the type and the sizes on every partial update.
  it("only carries the keys actually sent", () => {
    const patch = adminProductPatchSchema.parse({ name: "Nouveau nom" });
    expect(Object.keys(patch)).toEqual(["name"]);
    expect("description" in patch).toBe(false);
    expect("objectType" in patch).toBe(false);
    expect("variants" in patch).toBe(false);
    expect("currency" in patch).toBe(false);
    expect("weightKg" in patch).toBe(false);
    expect("priceCents" in patch).toBe(false);
    expect("buyUrl" in patch).toBe(false);
    expect("sku" in patch).toBe(false);
    expect("tags" in patch).toBe(false);
  });

  it("treats an explicit null as an erasure", () => {
    const patch = adminProductPatchSchema.parse({
      priceCents: null,
      stock: null,
      buyUrl: null,
      sku: "",
    });
    expect(patch.priceCents).toBeNull();
    expect(patch.stock).toBeNull();
    expect(patch.buyUrl).toBeNull();
    expect(patch.sku).toBeNull();
  });

  it("still validates the values it receives", () => {
    expect(() => adminProductPatchSchema.parse({ name: "x" })).toThrow();
    expect(() => adminProductPatchSchema.parse({ widthCm: -4 })).toThrow();
    expect(() => adminProductPatchSchema.parse({ status: "live" })).toThrow();
  });
});

describe("catalogue query", () => {
  it("falls back to a safe default page", () => {
    expect(listQuerySchema.parse({})).toEqual({
      q: "",
      status: "all",
      objectType: "all",
      placementType: "all",
      sort: "updated",
      page: 1,
      pageSize: 24,
    });
  });

  it("caps the page size and rejects unknown filters", () => {
    expect(listQuerySchema.parse({ pageSize: "24" }).pageSize).toBe(24);
    expect(() => listQuerySchema.parse({ pageSize: 5_000 })).toThrow();
    expect(() => listQuerySchema.parse({ status: "inconnu" })).toThrow();
  });
});

describe("tags", () => {
  it("deduplicates, trims and caps the list", () => {
    expect(normalizeTags(" a , a,b ,, c ")).toEqual(["a", "b", "c"]);
    expect(normalizeTags(Array.from({ length: 30 }, (_, i) => `t${i}`)).length)
      .toBe(12);
    expect(normalizeTags(["x".repeat(60)])[0]?.length).toBe(32);
  });
});
