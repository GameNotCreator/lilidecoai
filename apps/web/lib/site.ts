/** Public identity only. Never derive canonical URLs from untrusted request headers. */
export function siteOrigin() {
  const configured =
    process.env.SITE_URL || "https://lilidecoai-web.vercel.app";
  const url = new URL(configured);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password)
    throw new Error("SITE_URL doit être une origine HTTP(S) publique.");
  return url.origin;
}
export const storeIdentity = {
  name: "ByLiliDeco",
  title: "ByLiliDeco — Décoration, artisanat et cadeaux en Tunisie",
  description:
    "Découvrez ByLiliDeco, boutique de décoration et d’artisanat en Tunisie. Parcourez la collection de céramiques, d’objets décoratifs et de coffrets cadeaux.",
  heroImage: {
    url: "/brand/coffret-cadeau-ceramique.jpg",
    width: 1254,
    height: 1254,
    alt: "Coffret cadeau noir, vase et coupelle en céramique sur une console en pierre claire",
  },
  telephone: "+21622300600",
  instagram: "https://www.instagram.com/bylilideco/",
  facebook: "https://www.facebook.com/892214837523390",
};
export function productPath(id: string) {
  return `/produits/${encodeURIComponent(id)}`;
}
export function categoryPath(id: string) {
  return `/categories/${encodeURIComponent(id)}`;
}
export function breadcrumbStructuredData(
  origin: string,
  pages: ReadonlyArray<{ name: string; path: string }>,
) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: pages.map(({ name, path }, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name,
      item: `${origin}${path}`,
    })),
  };
}
export function jsonLd(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
