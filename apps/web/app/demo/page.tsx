import type { Metadata } from "next";
import { DemoExperience } from "@/components/demo-experience";

export const metadata: Metadata = {
  title: "Démonstration",
};

export default async function DemoPage({
  searchParams,
}: {
  searchParams: Promise<{ product?: string }>;
}) {
  const { product } = await searchParams;
  return <DemoExperience productId={product} />;
}
