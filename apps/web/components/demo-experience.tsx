import { VisualizerStudio } from "@/components/visualizer-studio";
import { DEMO_PRODUCT_ID } from "@/lib/server/types";

export function DemoExperience({
  productId,
}: {
  productId?: string;
}) {
  return (
    <main className="demo-page focused-demo-page">
      <div className="container demo-container">
        <VisualizerStudio
          initialProductId={productId ?? DEMO_PRODUCT_ID}
          catalogSession
        />
        <p className="privacy-reassurance">
          Vos photos servent uniquement à créer l’aperçu et sont supprimées
          automatiquement sous 24 heures.
        </p>
      </div>
    </main>
  );
}
