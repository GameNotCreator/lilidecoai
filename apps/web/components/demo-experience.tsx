import { VisualizerStudio } from "@/components/visualizer-studio";
import { DEMO_MERCHANT_SLUG, DEMO_PRODUCT_ID } from "@/lib/server/types";

export function DemoExperience({
  productId,
  publicSession = true,
}: {
  productId?: string;
  publicSession?: boolean;
}) {
  return (
    <main className="demo-page focused-demo-page">
      <div className="container demo-container">
        <VisualizerStudio
          initialProductId={productId ?? DEMO_PRODUCT_ID}
          merchantSlug={
            publicSession && !productId ? DEMO_MERCHANT_SLUG : undefined
          }
        />
        <p className="privacy-reassurance">
          Vos photos servent uniquement à créer l’aperçu et sont supprimées
          automatiquement sous 24 heures.
        </p>
      </div>
    </main>
  );
}
