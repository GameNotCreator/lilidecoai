import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AdminLogin } from "@/components/admin/admin-login";
import {
  adminConfiguration,
  currentAdminSession,
} from "@/lib/server/admin-auth";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Back office",
  robots: { index: false, follow: false },
};

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const requested = (await searchParams).next;
  const returnTo =
    requested?.startsWith("/admin") && !requested.startsWith("//")
      ? requested
      : "/admin";
  const status = adminConfiguration();
  if (status.configured && (await currentAdminSession())) redirect(returnTo);
  return (
    <AdminLogin
      configured={status.configured}
      reason={status.configured ? null : status.reason}
      returnTo={returnTo}
    />
  );
}
