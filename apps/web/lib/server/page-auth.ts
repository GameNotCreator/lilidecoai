import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { verifySessionToken } from "./auth";
import { serverConfig } from "./config";

export async function requireMerchantPage(returnTo: string): Promise<void> {
  if (serverConfig.demoMode) return;

  const token = (await cookies()).get("lili_session")?.value;
  const tenant = token ? await verifySessionToken(token) : null;
  if (!tenant || tenant.publicSessionId || tenant.role === "viewer") {
    redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  }
}
