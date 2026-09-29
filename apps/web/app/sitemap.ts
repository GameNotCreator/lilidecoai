import type { MetadataRoute } from "next";
import { siteOrigin, productPath } from "@/lib/site";
import { readStorefrontPage } from "@/lib/server/storefront-page";
export const dynamic = "force-dynamic";
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const catalog = await readStorefrontPage();
  return [
    "/",
    "/privacy",
    "/terms",
    ...catalog.products.map((p) => productPath(p.id)),
  ].map((path) => ({ url: `${siteOrigin()}${path}` }));
}
