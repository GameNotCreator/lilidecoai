import type { Metadata } from "next";
import Link from "next/link";
import { StorefrontVisualizer } from "@/components/storefront/storefront-visualizer";
import { serverConfig } from "@/lib/server/config";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Visualisation",
  robots: { index: false, follow: false },
};
export default async function VisualizerPage({
  searchParams,
}: {
  searchParams: Promise<{ products?: string | string[] }>;
}) {
  if (serverConfig.storefrontVisualizationPaused) {
    return (
      <main className="storefront store-shell store-page">
        <div className="store-empty">
          <h1>La visualisation est en pause.</h1>
          <Link href="/#collection" className="store-button">
            Retour à la collection
          </Link>
        </div>
      </main>
    );
  }
  const params = await searchParams;
  return (
    <StorefrontVisualizer
      productQuery={typeof params.products === "string" ? params.products : ""}
    />
  );
}
