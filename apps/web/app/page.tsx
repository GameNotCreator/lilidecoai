import { StorefrontCatalog } from "@/components/storefront/storefront-catalog";
import type { Metadata } from "next";
import { readStorefrontPage } from "@/lib/server/storefront-page";
import { jsonLd, siteOrigin, storeIdentity } from "@/lib/site";

export const dynamic = "force-dynamic";
type Props = {
  searchParams: Promise<{ q?: string | string[] }>;
};

export async function generateMetadata({
  searchParams,
}: Props): Promise<Metadata> {
  const { q } = await searchParams;
  return {
    title: { absolute: storeIdentity.title },
    alternates: { canonical: "/" },
    ...(q !== undefined && process.env.VERCEL_ENV !== "preview"
      ? { robots: { index: false, follow: true } }
      : {}),
    openGraph: {
      type: "website",
      url: "/",
      locale: "fr_TN",
      siteName: storeIdentity.name,
      title: storeIdentity.title,
      description: storeIdentity.description,
      images: [storeIdentity.heroImage],
    },
    twitter: {
      card: "summary_large_image",
      title: storeIdentity.title,
      description: storeIdentity.description,
      images: [storeIdentity.heroImage],
    },
  };
}

export default async function HomePage({ searchParams }: Props) {
  const params = await searchParams;
  // Keep the store shell and client retry available during a temporary database outage.
  const catalog = await readStorefrontPage().catch(() => null);
  const home = `${siteOrigin()}/`;
  const organization = `${home}#organisation`;
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLd({
            "@context": "https://schema.org",
            "@graph": [
              {
                "@type": "WebSite",
                "@id": `${home}#site`,
                name: storeIdentity.name,
                url: home,
                inLanguage: "fr-TN",
                publisher: { "@id": organization },
              },
              {
                "@type": "Organization",
                "@id": organization,
                name: storeIdentity.name,
                url: home,
                logo: `${home}brand/lilideco-logo.png`,
                telephone: storeIdentity.telephone,
                sameAs: [storeIdentity.instagram, storeIdentity.facebook],
              },
            ],
          }),
        }}
      />
      <StorefrontCatalog
        initialCatalog={catalog}
        initialSearch={typeof params.q === "string" ? params.q : ""}
      />
    </>
  );
}
