import type { Metadata } from "next";
import { VisualizerStudio } from "@/components/visualizer-studio";
import {
  DEMO_MERCHANT_SLUG,
  DEMO_PRODUCT_ID,
} from "@/lib/server/types";

export const metadata: Metadata = {
  title: "Démonstration",
};

export default function DemoPage() {
  return (
    <main className="demo-page">
      <div className="container">
        <VisualizerStudio
          initialProductId={DEMO_PRODUCT_ID}
          merchantSlug={DEMO_MERCHANT_SLUG}
        />
      </div>
    </main>
  );
}
