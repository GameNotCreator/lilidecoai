import type { Metadata } from "next";
import { StorefrontOrder } from "@/components/admin/storefront-order";
import { requireAdminPage } from "@/lib/server/admin-auth";
import { resolveAdminOrganization } from "@/lib/server/admin-products";
import { database } from "@/lib/server/mongodb";
import { readStorefrontProductOrder } from "@/lib/server/storefront";

export const metadata: Metadata = { title: "Ordre du catalogue" };

export default async function StorefrontOrderPage() {
  await requireAdminPage("/admin/produits/ordre");
  const db = await database();
  const organization = await resolveAdminOrganization(db);
  const order = await readStorefrontProductOrder(db, organization);
  return <StorefrontOrder initialOrder={order} />;
}
