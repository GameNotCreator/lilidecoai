import { z } from "zod";
import { withAdmin } from "../../../../../lib/server/admin-route";
import {
  updateOrderRequest,
  updateOrderRequestSchema,
} from "../../../../../lib/server/order-requests";
import {
  orderErrorResponse,
  orderResponse,
  readOrderBody,
} from "../../../../../lib/server/order-http";

export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return withAdmin(request, async ({ db, organization }) => {
    try {
      const id = z
        .string()
        .uuid()
        .parse((await context.params).id);
      const input = updateOrderRequestSchema.parse(
        await readOrderBody(request),
      );
      await updateOrderRequest(db, organization.id, id, input.status);
      return orderResponse({ updated: true });
    } catch (error) {
      return orderErrorResponse(error);
    }
  });
}
