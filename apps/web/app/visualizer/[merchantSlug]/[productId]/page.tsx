import { VisualizerStudio } from "@/components/visualizer-studio";

export default async function EmbeddedVisualizerPage({
  params,
}: {
  params: Promise<{ merchantSlug: string; productId: string }>;
}) {
  const { productId } = await params;
  return (
    <main className="embedded-page">
      <VisualizerStudio embedded initialProductId={productId} />
    </main>
  );
}

