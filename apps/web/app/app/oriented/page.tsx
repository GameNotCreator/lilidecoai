import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { OrientedStudio } from "@/components/oriented-studio";
import { tenantForRequest } from "@/lib/server/auth";
import { canUseOrientedPilot } from "@/lib/server/oriented-policy";
import { serverConfig } from "@/lib/server/config";
export default async function OrientedStudioPage() {
  const tenant = await tenantForRequest(
    new Request("http://internal/app/oriented", { headers: await headers() }),
  );
  if (!canUseOrientedPilot(tenant, serverConfig.orientedOrganizationIds))
    notFound();
  return (
    <OrientedStudio
      scope={`${tenant.organizationId}:${tenant.userId}`}
      allowedProductIds={serverConfig.orientedProductIds}
    />
  );
}
