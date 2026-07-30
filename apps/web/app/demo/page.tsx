import type { Metadata } from "next";
import { VisualizerStudio } from "@/components/visualizer-studio";

export const metadata: Metadata = {
  title: "Démonstration",
};

export default function DemoPage() {
  return (
    <main className="demo-page">
      <div className="container">
        <VisualizerStudio />
      </div>
    </main>
  );
}

