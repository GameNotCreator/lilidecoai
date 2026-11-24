import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { StorefrontProductGrid } from "@/components/storefront/storefront-catalog";
import { StorefrontCatalogueView } from "@/components/storefront/storefront-measurement";
import { readStorefrontCategoryPage } from "@/lib/server/storefront-page";
import { storefrontCategorySchema } from "@/lib/storefront-categories";
import { productSeoImages } from "@/lib/product-seo";
import {
  breadcrumbStructuredData,
  categoryPath,
  jsonLd,
  siteOrigin,
  storeIdentity,
} from "@/lib/site";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ slug: string }> };

async function getCategory(params: Props["params"]) {
  const { slug } = await params;
  if (!storefrontCategorySchema.safeParse(slug).success) notFound();
  const page = await readStorefrontCategoryPage(slug);
  if (!page) notFound();
  return page;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { category, products } = await getCategory(params);
  const title = `${category.label} en Tunisie`;
  const description = products.length
    ? `Explorez la catégorie ${category.label} chez ByLiliDeco en Tunisie. Consultez les photos, les matières, les dimensions et les prix des pièces.`
    : `Retrouvez prochainement les nouveautés de la catégorie ${category.label} chez ByLiliDeco en Tunisie.`;
  const path = categoryPath(category.id);
  const first = products[0];
  const photo = first && productSeoImages(first, siteOrigin())[0];
  const images = photo
    ? [{ url: photo, alt: first.name }]
    : [storeIdentity.heroImage];
  return {
    title,
    description,
    alternates: { canonical: path },
    ...(!products.length && process.env.VERCEL_ENV !== "preview"
      ? { robots: { index: false, follow: true } }
      : {}),
    openGraph: {
      type: "website",
      locale: "fr_TN",
      siteName: storeIdentity.name,
      title,
      description,
      url: path,
      images,
    },
    twitter: { card: "summary_large_image", title, description, images },
  };
}

export default async function CategoryPage({ params }: Props) {
  const { category, categories, products, visualizationAvailable } =
    await getCategory(params);
  return (
    <main className="storefront store-page">
      <StorefrontCatalogueView categoryId={category.id} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLd(
            breadcrumbStructuredData(siteOrigin(), [
              { name: "Boutique", path: "/" },
              { name: category.label, path: categoryPath(category.id) },
            ]),
          ),
        }}
      />
      <div className="store-shell">
        <Link href="/#collection" className="store-back" prefetch={false}>
          <ArrowLeft size={16} aria-hidden="true" /> Toute la collection
        </Link>
        <header className="store-page-heading">
          <h1>{category.label}</h1>
          {!!products.length && (
            <p>
              {products.length === 1
                ? "1 pièce à découvrir"
                : `${products.length} pièces à découvrir`}
            </p>
          )}
        </header>
        {products.length ? (
          <StorefrontProductGrid
            products={products}
            categories={categories}
            visualizationAvailable={visualizationAvailable}
          />
        ) : (
          <div className="store-empty">
            <p>Les pièces de cette catégorie seront bientôt en ligne.</p>
            <Link href="/#collection" className="store-button" prefetch={false}>
              Explorer la boutique
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}
