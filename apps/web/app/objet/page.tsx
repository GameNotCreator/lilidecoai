import type { Metadata } from "next";
import { ProductCreateForm } from "@/components/product-create-form";
import { requireMerchantPage } from "@/lib/server/page-auth";

export const metadata: Metadata = {
  title: "Ajouter un objet",
};

export default async function ObjectPage() {
  await requireMerchantPage("/objet");
  return (
    <main className="object-page">
      <div className="container object-page-container">
        <ProductCreateForm afterCreate="visualizer" />
      </div>
    </main>
  );
}
