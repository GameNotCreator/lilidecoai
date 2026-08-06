import type { Metadata } from "next";
import { DemoExperience } from "@/components/demo-experience";

export const metadata: Metadata = {
  title: "Démonstration",
};

export default function DemoPage() {
  return <DemoExperience />;
}
