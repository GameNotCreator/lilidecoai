import type { Metadata } from "next";

import { AdminShell } from "@/components/admin/admin-shell";
import { requireAdminPage } from "@/lib/server/admin-auth";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "Back office", template: "%s — Back office" },
  robots: { index: false, follow: false },
};

export default async function BackOfficeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireAdminPage("/admin");
  return <AdminShell username={session.username}>{children}</AdminShell>;
}
