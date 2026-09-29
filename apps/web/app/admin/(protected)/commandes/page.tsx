import type { Metadata } from "next";
import { AdminOrderRequests } from "@/components/admin/admin-order-requests";

export const metadata: Metadata = { title: "Demandes de commande" };
export default function OrdersPage() {
  return <AdminOrderRequests />;
}
