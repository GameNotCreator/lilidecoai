import { z } from "zod";

import {
  adminProductResponse,
  duplicateProduct,
  findProduct,
  persistProduct,
  setProductStatus,
} from "@/lib/server/admin-products";
import { prepareAdminProduct } from "@/lib/server/admin-product-preparation";
import { jsonBody, withAdmin } from "@/lib/server/admin-route";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const actionSchema = z.object({
  action: z.enum([
    "prepare",
    "publish",
    "unpublish",
    "archive",
    "restore",
    "duplicate",
    "persist",
  ]),
});

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  const { id } = await context.params;
  return withAdmin(request, async ({ db, organization }) => {
    const { action } = actionSchema.parse(await jsonBody(request));
    const product = await findProduct(db, organization.id, id);

    if (action === "duplicate") {
      const copy = await duplicateProduct(db, product);
      return Response.json(adminProductResponse(copy), { status: 201 });
    }
    if (action === "persist") {
      await persistProduct(db, product);
      return Response.json(
        adminProductResponse(await findProduct(db, organization.id, id)),
      );
    }
    if (action === "publish") {
      return Response.json(
        adminProductResponse(await setProductStatus(db, product, "ready")),
      );
    }
    if (action === "unpublish") {
      return Response.json(
        adminProductResponse(await setProductStatus(db, product, "draft")),
      );
    }
    if (action === "archive") {
      return Response.json(
        adminProductResponse(await setProductStatus(db, product, "archived")),
      );
    }
    if (action === "restore") {
      return Response.json(
        adminProductResponse(await setProductStatus(db, product, "draft")),
      );
    }

    return Response.json(adminProductResponse(await prepareAdminProduct(db, organization.id, id)));
  });
}
