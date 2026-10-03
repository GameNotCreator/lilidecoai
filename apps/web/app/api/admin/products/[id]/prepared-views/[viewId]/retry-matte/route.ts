import { withAdmin, jsonBody } from "@/lib/server/admin-route";
import { retryPreparedViewMatte } from "@/lib/server/prepared-view-tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; viewId: string }> };

export async function POST(request: Request, context: Context) {
  const { id, viewId } = await context.params;
  return withAdmin(request, async ({ db, organization, session }) => Response.json(
    await retryPreparedViewMatte(db, organization.id, id, viewId, `admin:${session.username}`, await jsonBody(request)),
    { status: 202, headers: { "Cache-Control": "private, no-store" } },
  ));
}
