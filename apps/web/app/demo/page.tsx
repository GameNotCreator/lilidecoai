import type { Metadata } from "next";
import { VisualizerStudio } from "@/components/visualizer-studio";
import { DEMO_MERCHANT_SLUG, DEMO_PRODUCT_ID } from "@/lib/server/types";

export const metadata: Metadata = {
  title: "Démonstration",
};

export default async function DemoPage({
  searchParams,
}: {
  searchParams: Promise<{ product?: string }>;
}) {
  const { product } = await searchParams;
  return (
    <main className="demo-page">
      <div className="container">
        <VisualizerStudio
          initialProductId={product ?? DEMO_PRODUCT_ID}
          merchantSlug={product ? undefined : DEMO_MERCHANT_SLUG}
        />
      </div>
    </main>
  );
}
