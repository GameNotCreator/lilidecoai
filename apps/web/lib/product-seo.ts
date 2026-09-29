import { productPath } from "./site";
import { safeStorefrontUrl, type StorefrontProduct } from "./storefront";
export function productStructuredData(
  product: StorefrontProduct,
  origin: string,
) {
  const source = safeStorefrontUrl(product.assetUrl);
  const dimension = (value: number) =>
    Number.isFinite(value) && value > 0
      ? { "@type": "QuantitativeValue", value, unitCode: "CMT" }
      : undefined;
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.name,
    description: product.description || undefined,
    url: `${origin}${productPath(product.id)}`,
    image: source ? new URL(source, origin).href : undefined,
    sku: product.sku || undefined,
    brand: product.brand
      ? { "@type": "Brand", name: product.brand }
      : undefined,
    material: product.material || undefined,
    width: dimension(product.widthCm),
    height: dimension(product.heightCm),
    depth: dimension(product.depthCm),
    // No Offer: this site does not accept orders or reserve inventory.
  };
}
