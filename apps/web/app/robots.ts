import type { MetadataRoute } from "next";
import { siteOrigin } from "@/lib/site";
export default function robots(): MetadataRoute.Robots {
  if (process.env.VERCEL_ENV === "preview")
    return { rules: { userAgent: "*", disallow: "/" } };
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/api/assets/"],
      disallow: [
        "/admin",
        "/app",
        "/v1/",
        "/api/",
        "/visualiser",
        "/panier",
        "/demo",
        "/login",
        "/signup",
      ],
    },
    sitemap: `${siteOrigin()}/sitemap.xml`,
  };
}
