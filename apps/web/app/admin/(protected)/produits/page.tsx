import type { Metadata } from "next";

import { ProductBank } from "@/components/admin/product-bank";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Banque de produits" };

export default function ProductBankPage() {
  return <ProductBank />;
}
