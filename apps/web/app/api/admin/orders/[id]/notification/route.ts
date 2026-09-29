import { z } from "zod";
import { withAdmin } from "../../../../../../lib/server/admin-route";
import { retryOrderNotification } from "../../../../../../lib/server/order-requests";
import {
  orderErrorResponse,
  orderResponse,
} from "../../../../../../lib/server/order-http";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return withAdmin(request, async ({ db, organization }) => {
    try {
      const id = z
        .string()
        .uuid()
        .parse((await context.params).id);
      return orderResponse(
        await retryOrderNotification(db, organization.id, id),
      );
    } catch (error) {
      return orderErrorResponse(error);
    }
  });
}
