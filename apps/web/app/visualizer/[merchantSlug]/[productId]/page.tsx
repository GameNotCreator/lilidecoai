import { VisualizerStudio } from "@/components/visualizer-studio";

export default async function EmbeddedVisualizerPage({
  params,
}: {
  params: Promise<{ merchantSlug: string; productId: string }>;
}) {
  const { merchantSlug, productId } = await params;
  return (
    <main className="embedded-page">
      <VisualizerStudio
        embedded
        initialProductId={productId}
        merchantSlug={merchantSlug}
      />
    </main>
  );
}
