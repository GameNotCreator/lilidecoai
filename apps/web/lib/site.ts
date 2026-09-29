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
  description:
    "Art, artisanat et design : découvrez la sélection ByLiliDeco et imaginez les objets de la boutique dans votre intérieur.",
  telephone: "+21622300600",
  instagram: "https://www.instagram.com/bylilideco/",
  facebook: "https://www.facebook.com/892214837523390",
};
export function productPath(id: string) {
  return `/produits/${encodeURIComponent(id)}`;
}
export function jsonLd(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
