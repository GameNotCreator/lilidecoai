import type { Metadata } from "next";

import { AdminProductForm } from "@/components/admin/admin-product-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Nouveau produit" };

export default function NewProductPage() {
  return <AdminProductForm />;
}
