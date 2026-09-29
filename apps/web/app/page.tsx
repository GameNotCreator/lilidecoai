import { StorefrontCatalog } from "@/components/storefront/storefront-catalog";
import type { Metadata } from "next";
import { readStorefrontPage } from "@/lib/server/storefront-page";
import { jsonLd, siteOrigin, storeIdentity } from "@/lib/site";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  alternates: { canonical: "/" },
  title: { absolute: "ByLiliDeco — Art, artisanat & décoration" },
};

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const params = await searchParams;
  // Keep the store shell and client retry available during a temporary database outage.
  const catalog = await readStorefrontPage().catch(() => null);
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLd({
            "@context": "https://schema.org",
            "@type": "Store",
            name: storeIdentity.name,
            url: siteOrigin(),
            logo: `${siteOrigin()}/brand/lilideco-logo.png`,
            telephone: storeIdentity.telephone,
            sameAs: [storeIdentity.instagram, storeIdentity.facebook],
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
