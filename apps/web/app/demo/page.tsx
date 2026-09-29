import type { Metadata } from "next";
import { DemoExperience } from "@/components/demo-experience";

export const metadata: Metadata = {
  title: "Démonstration",
  robots: { index: false, follow: false },
};

export default function DemoPage() {
  return <DemoExperience />;
}
