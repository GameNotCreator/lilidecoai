import {
  getVisualizationBudget,
  grantVisualizationCapacity,
  visualizationCapacityGrantSchema,
} from "../../../../lib/server/admin-visualization-budget";
import { requireAdminRequest } from "../../../../lib/server/admin-auth";
import { adminErrorResponse, jsonBody, withAdmin } from "../../../../lib/server/admin-route";
import { database } from "../../../../lib/server/mongodb";
import { storefrontOrganization } from "../../../../lib/server/storefront";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request): Promise<Response> {
  try {
    await requireAdminRequest(request);
    const db = await database();
    // The general admin wrapper initializes missing organizations; a budget
    // read must not create business data, even on an empty installation.
    const organization = await storefrontOrganization(db);
    return Response.json(await getVisualizationBudget(db, organization?.id), { headers });
  } catch (reason) {
    return adminErrorResponse(reason);
  }
}

export async function POST(request: Request): Promise<Response> {
  return withAdmin(request, async ({ db, organization, session }) => {
    const input = visualizationCapacityGrantSchema.parse(await jsonBody(request));
    const budget = await grantVisualizationCapacity(
      db, organization.id, input, session.username,
    );
    return Response.json(budget, { headers });
  });
}
