import { overview } from "@/lib/server/admin-products";
import { withAdmin } from "@/lib/server/admin-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return withAdmin(request, async ({ db, organization, session }) => {
    return Response.json({
      ...(await overview(db, organization.id)),
      organization: { name: organization.name, slug: organization.slug },
      session: { username: session.username },
    });
  });
}
