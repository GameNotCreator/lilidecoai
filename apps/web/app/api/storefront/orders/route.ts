import { database } from "../../../../lib/server/mongodb";
import { isSameOriginRequest } from "../../../../lib/server/request-origin";
import {
  checkoutAvailability,
  createOrderRequest,
  OrderRequestError,
} from "../../../../lib/server/order-requests";
import {
  orderErrorResponse,
  orderResponse,
  readOrderBody,
} from "../../../../lib/server/order-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return orderResponse(checkoutAvailability());
}

export async function POST(request: Request) {
  try {
    if (!isSameOriginRequest(request))
      throw new OrderRequestError("Origine de la demande refusée.", 403);
    if (!checkoutAvailability().available)
      return orderResponse({ detail: checkoutAvailability().reason }, 503);
    const input = await readOrderBody(request);
    const client =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip") ||
      "unknown";
    return orderResponse(
      await createOrderRequest(await database(), input, client),
      201,
    );
  } catch (error) {
    return orderErrorResponse(error);
  }
}
