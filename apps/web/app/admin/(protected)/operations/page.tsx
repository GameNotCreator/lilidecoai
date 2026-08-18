import type { Metadata } from "next";

import { AdminOperations } from "@/components/admin/admin-operations";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Opérations IA" };

export default function OperationsPage() {
  return <AdminOperations />;
}
