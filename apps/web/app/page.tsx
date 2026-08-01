import { DemoExperience } from "@/components/demo-experience";
import { serverConfig } from "@/lib/server/config";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ product?: string }>;
}) {
  const { product } = await searchParams;
  return (
    <DemoExperience
      productId={product}
      publicSession={!serverConfig.demoMode}
    />
  );
}
