import type { Metadata } from "next";
import { StorefrontVisualizer } from "@/components/storefront/storefront-visualizer";
export const metadata: Metadata = {
  title: "Visualisez chez vous",
  robots: { index: false, follow: false },
};
export default async function VisualizerPage({
  searchParams,
}: {
  searchParams: Promise<{ products?: string | string[] }>;
}) {
  const params = await searchParams;
  return (
    <StorefrontVisualizer
      productQuery={typeof params.products === "string" ? params.products : ""}
    />
  );
}
