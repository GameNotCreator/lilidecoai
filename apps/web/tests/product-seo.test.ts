import { describe, it, expect } from "vitest";
import {
  productSeoDescription,
  productSeoImages,
  productStructuredData,
} from "../lib/product-seo";
import { jsonLd } from "../lib/site";
import { storefrontProductSchema } from "../lib/storefront";

describe("public product SEO", () => {
  const product = storefrontProductSchema.parse({
    id: "00000000-0000-4000-8000-000000000001",
    name: "Grenade </script>",
    material: "Céramique",
    objectType: "other",
    widthCm: 14,
    heightCm: 14,
    depthCm: 0,
    placementType: "table",
    visualizationAvailable: false,
  });
  it("omits unknown dimensions and does not invent sale offers or ratings", () => {
    const result = JSON.parse(
      JSON.stringify(productStructuredData(product, "https://example.com")),
    );
    expect(result.width.value).toBe(14);
    expect(result).not.toHaveProperty("depth");
    expect(result).not.toHaveProperty("offers");
    expect(result).not.toHaveProperty("aggregateRating");
  });
  it("escapes product content before putting it into an HTML script", () => {
    expect(
      jsonLd(productStructuredData(product, "https://example.com")),
    ).not.toContain("</script>");
    expect(JSON.parse(jsonLd(product)).name).toBe(product.name);
  });
  it("does not publish unsafe image schemes", () => {
    expect(
      productStructuredData(
        { ...product, assetUrl: "javascript:alert(1)" },
        "https://example.com",
      ).image,
    ).toBeUndefined();
  });
  it("uses the catalogue image first and deduplicates public image URLs", () => {
    const withPhotos = {
      ...product,
      assetUrl: "/api/assets/primary",
      cutoutUrl: "/api/assets/cutout",
      stagedPhotoUrl: "/api/assets/staged",
    };
    expect(
      productStructuredData(withPhotos, "https://example.com").image,
    ).toEqual([
      "https://example.com/api/assets/primary",
      "https://example.com/api/assets/staged",
    ]);
    expect(
      productSeoImages(
        {
          ...withPhotos,
          assetUrl: null,
          stagedPhotoUrl: "https://example.com/api/assets/cutout",
        },
        "https://example.com",
      ),
    ).toEqual(["https://example.com/api/assets/cutout"]);
  });
  it("describes a product from its catalogue data when its description is empty", () => {
    const synopsis = productSeoDescription({
      ...product,
      name: "Cache-pot Graphik",
      description: " ",
      collection: "Noun",
    });
    expect(synopsis).toContain("Cache-pot Graphik, Céramique, Noun");
    const long = productSeoDescription({
      ...product,
      description: "Pièce en céramique.\n".repeat(20),
    });
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long).not.toContain("\n");
    expect(long.endsWith("…")).toBe(true);
  });
});
