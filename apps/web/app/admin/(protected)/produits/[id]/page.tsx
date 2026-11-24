import type { Metadata } from "next";

import { AdminProductForm } from "@/components/admin/admin-product-form";
import { groqTagSuggestionsAvailable } from "@/lib/server/groq-product-tags";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Fiche produit" };

export default async function EditProductPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <AdminProductForm
      productId={id}
      tagSuggestionsAvailable={groqTagSuggestionsAvailable()}
    />
  );
}
