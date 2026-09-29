import { describe, expect, it } from "vitest";
import {
  cartProductIds,
  cartQuantity,
  normalizeCart,
  parseVisualizationIds,
  productDimensionPair,
  readCart,
  safeStorefrontUrl,
  setCartQuantity,
  storefrontCatalogSchema,
  storefrontProductSchema,
  visualizationHref,
  visualizationProblem,
  type StorefrontProduct,
} from "../lib/storefront";

const id = "00000000-0000-4000-8000-000000000101";
const second = "00000000-0000-4000-8000-000000000102";
const product: StorefrontProduct = storefrontProductSchema.parse({
  id,
  name: "Vase",
  objectType: "vase",
  widthCm: 18,
  heightCm: 26,
  depthCm: 18,
  material: "Grès",
  placementType: "table",
  visualizationAvailable: true,
  priceCents: 5600,
  currency: "TND",
  stock: 4,
});

describe("storefront cart and catalog boundary", () => {
  it("rejects corrupted persistence without crashing or inventing cart items", () => {
    expect(readCart("not-json")).toEqual([]);
    expect(readCart('{"items":[]}')).toEqual([]);
    expect(
      normalizeCart([
        null,
        { productId: "x", quantity: 2 },
        { productId: id, quantity: 1.5 },
        { productId: id, quantity: -1 },
      ]),
    ).toEqual([]);
  });
  it("merges repeated items and bounds quantities, retaining order", () => {
    expect(
      normalizeCart([
        { productId: id, quantity: 2 },
        { productId: second, quantity: 1 },
        { productId: id, quantity: 110 },
      ]),
    ).toEqual([
      { productId: id, quantity: 99 },
      { productId: second, quantity: 1 },
    ]);
  });
  it("removes zero quantities and does not add malformed product IDs", () => {
    expect(setCartQuantity([{ productId: id, quantity: 1 }], id, 0)).toEqual(
      [],
    );
    expect(setCartQuantity([], "malformed", 2)).toEqual([]);
  });
  it("encodes quantities as repeated product IDs and counts units, not distinct products", () => {
    const cart = [
      { productId: id, quantity: 2 },
      { productId: second, quantity: 1 },
    ];
    expect(cartQuantity(cart)).toBe(3);
    const ids = cartProductIds(cart);
    expect(ids).toEqual([id, id, second]);
    expect(
      parseVisualizationIds(
        new URL(visualizationHref(ids), "https://store.test").searchParams.get(
          "products",
        )!,
      ),
    ).toEqual(ids);
  });
  it("rejects missing, malformed and over-limit selection instead of silently truncating", () => {
    for (const value of [
      "",
      "bad",
      `${id},`,
      `${id},bad`,
      [id, id, id, id].join(","),
    ])
      expect(parseVisualizationIds(value)).toBeNull();
    expect(parseVisualizationIds([id, id, id].join(","))).toHaveLength(3);
  });
  it("blocks a fourth unit, including copies of the same product", () => {
    expect(
      visualizationProblem([{ productId: id, quantity: 4 }], [product], true),
    ).toContain("3 articles");
    expect(
      visualizationProblem([{ productId: id, quantity: 3 }], [product], true),
    ).toBeNull();
  });
  it("reconciles deleted products, preparation state, stock and global availability", () => {
    const cart = [{ productId: id, quantity: 2 }];
    expect(visualizationProblem(cart, [], true)).toContain("plus au catalogue");
    expect(
      visualizationProblem(cart, [{ ...product, stock: 1 }], true),
    ).toContain("stock");
    expect(
      visualizationProblem(
        cart,
        [{ ...product, visualizationAvailable: false }],
        true,
      ),
    ).toContain("pas disponible");
    expect(visualizationProblem(cart, [product], false)).toContain(
      "momentanément",
    );
    expect(
      visualizationProblem(cart, [{ ...product, stock: null }], true),
    ).toBeNull();
  });
  it("takes standing dimensions from catalog width/height and flat dimensions from width/depth", () => {
    expect(productDimensionPair(product)).toEqual({
      mode: "height_length",
      heightCm: 26,
      lengthCm: 18,
    });
    expect(
      productDimensionPair({
        ...product,
        objectType: "rug",
        widthCm: 240,
        depthCm: 170,
        heightCm: 1,
      }),
    ).toEqual({ mode: "length_width", lengthCm: 240, widthCm: 170 });
    expect(
      visualizationProblem(
        [{ productId: id, quantity: 1 }],
        [{ ...product, objectType: "rug", depthCm: 0 }],
        true,
      ),
    ).toContain("dimensions");
  });
  it("strips merchant-only fields from public catalog parsing", () => {
    const catalog = storefrontCatalogSchema.parse({
      store: { name: "LiliDeco" },
      products: [
        {
          ...product,
          organizationId: "private",
          generationInstructions: "private",
          spatialMetadata: {},
        },
      ],
      visualization: { available: true },
    });
    expect(catalog.products[0]).not.toHaveProperty("organizationId");
    expect(catalog.products[0]).not.toHaveProperty("generationInstructions");
    expect(catalog.products[0]).not.toHaveProperty("spatialMetadata");
  });
  it("refuses script and network-path product links while allowing normal product and image paths", () => {
    expect(safeStorefrontUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeStorefrontUrl("//untrusted.test/x")).toBeUndefined();
    expect(safeStorefrontUrl("/\\untrusted.test")).toBeUndefined();
    expect(safeStorefrontUrl("/v1/assets/photo")).toBe("/v1/assets/photo");
    expect(safeStorefrontUrl("https://shop.test/product")).toBe(
      "https://shop.test/product",
    );
  });
});
