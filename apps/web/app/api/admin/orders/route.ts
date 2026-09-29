import { withAdmin } from "../../../../lib/server/admin-route";
import { listOrderRequests } from "../../../../lib/server/order-requests";
import { orderResponse } from "../../../../lib/server/order-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withAdmin(request, async ({ db, organization }) =>
    orderResponse({ orders: await listOrderRequests(db, organization.id) }),
  );
}
