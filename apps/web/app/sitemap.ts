import type { MetadataRoute } from "next";
import { siteOrigin, productPath } from "@/lib/site";
import { productSeoImages } from "@/lib/product-seo";
import { readStorefrontPage } from "@/lib/server/storefront-page";
export const dynamic = "force-dynamic";
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const catalog = await readStorefrontPage();
  const origin = siteOrigin();
  return [
    ...["/", "/privacy", "/terms"].map((path) => ({ url: `${origin}${path}` })),
    ...catalog.products.map((product) => {
      const images = productSeoImages(product, origin);
      return {
        url: `${origin}${productPath(product.id)}`,
        lastModified: product.updatedAt,
        images: images.length ? images : undefined,
      };
    }),
  ];
}
