import { DemoExperience } from "@/components/demo-experience";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ product?: string }>;
}) {
  const { product } = await searchParams;
  return <DemoExperience productId={product} />;
}
