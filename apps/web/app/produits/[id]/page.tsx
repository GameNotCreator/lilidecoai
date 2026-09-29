import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { readStorefrontPage } from "@/lib/server/storefront-page";
import { jsonLd, productPath, siteOrigin } from "@/lib/site";
import { productStructuredData } from "@/lib/product-seo";
import {
  productDimensions,
  productPrice,
  safeStorefrontUrl,
} from "@/lib/storefront";
import { ProductImage } from "@/components/storefront/storefront-catalog";
import { ProductActions } from "@/components/storefront/product-actions";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ id: string }> };
async function getProduct(params: Props["params"]) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const catalog = await readStorefrontPage();
  const product = catalog.products.find((item) => item.id === id);
  if (!product) notFound();
  return { product, available: catalog.visualization.available };
}
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { product } = await getProduct(params);
  const description =
    product.description ||
    `${product.name} — ${productDimensions(product)}. Découvrez cette pièce de la sélection ByLiliDeco.`;
  const image = safeStorefrontUrl(product.assetUrl);
  return {
    title: product.name,
    description,
    alternates: { canonical: productPath(product.id) },
    openGraph: {
      title: product.name,
      description,
      url: productPath(product.id),
      ...(image ? { images: [{ url: image, alt: product.name }] } : {}),
    },
    twitter: {
      card: image ? "summary_large_image" : "summary",
      title: product.name,
      description,
      ...(image ? { images: [image] } : {}),
    },
  };
}
export default async function ProductPage({ params }: Props) {
  const { product, available } = await getProduct(params);
  const buyUrl = safeStorefrontUrl(product.buyUrl);
  return (
    <main className="storefront store-product-page">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLd(productStructuredData(product, siteOrigin())),
        }}
      />
      <div className="store-shell">
        <Link href="/#collection" className="store-back">
          <ArrowLeft size={16} aria-hidden="true" />
          Retour à la collection
        </Link>
        <div className="store-product-page-grid">
          <ProductImage product={product} eager />
          <div className="store-product-page-copy">
            <p className="store-kicker">{product.brand || "BY LILIDECO"}</p>
            <h1>{product.name}</h1>
            <p className="store-product-page-price">{productPrice(product)}</p>
            {product.description && <p>{product.description}</p>}
            <dl className="store-specs">
              <div>
                <dt>Dimensions</dt>
                <dd>{productDimensions(product)}</dd>
              </div>
              {product.material && (
                <div>
                  <dt>Matière</dt>
                  <dd>{product.material}</dd>
                </div>
              )}
              {product.sku && (
                <div>
                  <dt>Référence</dt>
                  <dd>{product.sku}</dd>
                </div>
              )}
              <div>
                <dt>Disponibilité</dt>
                <dd>
                  {product.stock === null
                    ? "À confirmer auprès de la boutique"
                    : product.stock === 0
                      ? "Épuisé"
                      : `${product.stock} disponible${product.stock > 1 ? "s" : ""}`}
                </dd>
              </div>
            </dl>
            <ProductActions product={product} available={available} />
            <p className="store-small-note">
              Votre panier permet de préparer votre sélection. Il ne constitue
              ni une commande ni une réservation.
            </p>
            {buyUrl && (
              <a
                href={buyUrl}
                className="store-text-link"
                target="_blank"
                rel="noopener noreferrer"
              >
                Voir le produit sur la boutique partenaire{" "}
                <ArrowUpRight size={16} aria-hidden="true" />
              </a>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
