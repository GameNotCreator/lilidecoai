import { describe, expect, it } from "vitest";
import {
  resolveStorefrontCategory,
  storefrontCategories,
} from "../lib/storefront-categories";
import { adminProductPatchSchema } from "../lib/server/admin-product-schema";

describe("storefront categories", () => {
  it.each([
    ["Coffret 6 sous-tasses en verre", "other", "coffrets-cadeaux"],
    ["Poisson Graphik noir et blanc", "other", "sculptures-objets-deco"],
    ["Cache-pot Graphik", "plant", "vases-cache-pots"],
    ["Sous-tasses Raku", "other", "art-de-la-table"],
    ["Lampe Boman", "lamp", "lampes-luminaires"],
    ["Affiche Mucha", "frame", "decoration-murale"],
    ["Photophore Graphik", "vase", "bougeoirs-photophores"],
    ["Étagère en bois", "other", "petit-mobilier"],
    ["Tapis Sienne", "rug", "tapis-textiles"],
    ["Panier tressé", "basket", "autres-accessoires-deco"],
  ])(
    "assigns the existing product %s from its name and type",
    (name, objectType, category) => {
      expect(resolveStorefrontCategory({ name, objectType })).toBe(category);
    },
  );

  it("honors the category selected in the back office", () => {
    expect(
      resolveStorefrontCategory({
        name: "Coffret 6 sous-tasses",
        objectType: "other",
        storefrontCategory: "art-de-la-table",
      }),
    ).toBe("art-de-la-table");
  });

  it("keeps the saved category order and appends categories added later", () => {
    const stored = [
      { id: "ceramiques-peintes", label: "Céramiques peintes" },
      { id: "edition-limitee", label: "Édition limitée" },
    ];
    const categories = storefrontCategories(stored, [
      "ceramiques-peintes",
      "vases-cache-pots",
      "category-no-longer-present",
    ]);
    expect(categories.slice(0, 2).map(({ id }) => id)).toEqual([
      "ceramiques-peintes",
      "vases-cache-pots",
    ]);
    expect(categories.at(-1)).toEqual(stored[1]);
  });

  it("accepts automatic classification and well-formed category IDs from the database", () => {
    expect(adminProductPatchSchema.parse({ storefrontCategory: null })).toEqual(
      { storefrontCategory: null },
    );
    expect(
      adminProductPatchSchema.parse({ name: "Vase Sable" }),
    ).not.toHaveProperty("storefrontCategory");
    expect(
      adminProductPatchSchema.parse({
        storefrontCategory: "ceramiques-peintes",
      }),
    ).toEqual({ storefrontCategory: "ceramiques-peintes" });
    expect(
      adminProductPatchSchema.safeParse({
        storefrontCategory: "vases/cache-pots",
      }).success,
    ).toBe(false);
  });
});
