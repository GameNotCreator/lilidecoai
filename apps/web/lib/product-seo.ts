import { productPath } from "./site";
import { safeStorefrontUrl, type StorefrontProduct } from "./storefront";
import {
  resolveStorefrontCategory,
  storefrontCategoryLabel,
} from "./storefront-categories";

export function productSeoImages(product: StorefrontProduct, origin: string) {
  const primary =
    safeStorefrontUrl(product.assetUrl) ?? safeStorefrontUrl(product.cutoutUrl);
  const staged = safeStorefrontUrl(product.stagedPhotoUrl);
  return [
    ...new Set(
      [primary, staged].flatMap((src) =>
        src ? [new URL(src, origin).href] : [],
      ),
    ),
  ];
}

export function productSeoDescription(product: StorefrontProduct) {
  const details = [product.name, product.material, product.collection]
    .map((text) => text.trim())
    .filter(Boolean);
  const description = (
    product.description.trim() ||
    `${details.join(", ")}. Découvrez cette pièce de la collection ByLiliDeco.`
  ).replace(/\s+/g, " ");
  const limit = 160;
  if (description.length <= limit) return description;
  const excerpt = description.slice(0, limit - 1);
  const breakAt = excerpt.lastIndexOf(" ");
  return `${breakAt > 120 ? excerpt.slice(0, breakAt) : excerpt}…`;
}

export function productStructuredData(
  product: StorefrontProduct,
  origin: string,
) {
  const images = productSeoImages(product, origin);
  const url = new URL(productPath(product.id), origin).href;
  const dimension = (value: number) =>
    Number.isFinite(value) && value > 0
      ? { "@type": "QuantitativeValue", value, unitCode: "CMT" }
      : undefined;
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    "@id": `${url}#produit`,
    name: product.name,
    description: product.description.trim() || productSeoDescription(product),
    url,
    image: images.length ? images : undefined,
    sku: product.sku || undefined,
    brand: product.brand
      ? { "@type": "Brand", name: product.brand }
      : undefined,
    material: product.material || undefined,
    category:
      product.storefrontCategoryLabel ??
      storefrontCategoryLabel(resolveStorefrontCategory(product)),
    width: dimension(product.widthCm),
    height: dimension(product.heightCm),
    depth: dimension(product.depthCm),
    // No Offer: this site does not accept orders or reserve inventory.
  };
}
