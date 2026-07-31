import { AuthForm } from "@/components/auth-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const requested = (await searchParams).next;
  const returnTo =
    requested?.startsWith("/") && !requested.startsWith("//")
      ? requested
      : "/app";
  return <AuthForm mode="login" returnTo={returnTo} />;
}
