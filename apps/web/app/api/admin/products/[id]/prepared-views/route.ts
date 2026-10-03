import { withAdmin, jsonBody } from "@/lib/server/admin-route";
import { listPreparedViews, preparedCollections } from "@/lib/server/prepared-views";
import { queuePreparedView, preparedMatteRetryAvailability } from "@/lib/server/prepared-view-tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return withAdmin(request, async ({ db, organization }) => {
    const views = await listPreparedViews(db, organization.id, id);
    const tasks = await preparedCollections(db).tasks.find({ organizationId: organization.id, productId: id })
      .sort({ createdAt: -1 }).limit(100).toArray();
    const summaries = [];
    // Each eligible failed task verifies source/raw bytes; bound peak memory while listing.
    for (const task of tasks) summaries.push({ id: task.id, viewId: task.viewId,
      state: task.state, providerOutcome: task.provider.state, failure: task.failure, costUsd: task.provider.costUsd,
      matteRetry: await preparedMatteRetryAvailability(db, task),
    });
    return Response.json({ views, tasks: summaries }, { headers: { "Cache-Control": "private, no-store" } });
  });
}
export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return withAdmin(request, async ({ db, organization }) => Response.json(
    await queuePreparedView(db, organization.id, id, await jsonBody(request)), { status: 202 }));
}
