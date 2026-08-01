import type { Metadata } from "next";
import { ProductCreateForm } from "@/components/product-create-form";

export const metadata: Metadata = {
  title: "Ajouter un objet",
};

export default function ObjectPage() {
  return (
    <main className="object-page">
      <div className="container object-page-container">
        <ProductCreateForm afterCreate="visualizer" guestAccess />
      </div>
    </main>
  );
}
