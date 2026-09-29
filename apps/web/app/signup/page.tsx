import { AuthForm } from "@/components/auth-form";
import type { Metadata } from "next";
export const metadata: Metadata = {
  title: "Inscription",
  robots: { index: false, follow: false },
};

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const requested = (await searchParams).next;
  const returnTo =
    requested?.startsWith("/") && !requested.startsWith("//")
      ? requested
      : "/app";
  return <AuthForm mode="signup" returnTo={returnTo} />;
}
