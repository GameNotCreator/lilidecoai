import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { VisualizerStudio } from "@/components/visualizer-studio";
import { tenantForRequest } from "@/lib/server/auth";
import { canUseSpatialPilot } from "@/lib/server/spatial-policy";
import { serverConfig } from "@/lib/server/config";

export default async function SpatialStudioPage() {
  const tenant = await tenantForRequest(
    new Request("http://internal/app/spatial", { headers: await headers() }),
  );
  if (!canUseSpatialPilot(tenant, serverConfig.spatialOrganizationIds))
    notFound();
  const draftScope = `${tenant.organizationId}:${tenant.userId}`;
  return (
    <VisualizerStudio
      key={draftScope}
      internalSpatial
      draftScope={draftScope}
    />
  );
}
