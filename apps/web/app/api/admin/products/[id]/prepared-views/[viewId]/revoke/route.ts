import { withAdmin, jsonBody } from "@/lib/server/admin-route";
import { revokePreparedView } from "@/lib/server/prepared-views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; viewId: string }> };

export async function POST(request: Request, context: Context) {
  const { id, viewId } = await context.params;
  return withAdmin(request, async ({ db, organization, session }) => Response.json({ view:
    await revokePreparedView(db, organization.id, id, viewId, `admin:${session.username}`, await jsonBody(request)),
  }));
}
