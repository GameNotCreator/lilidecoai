import {
  adminProductPatchSchema,
  adminProductResponse,
  deleteProduct,
  findProduct,
  setProductStatus,
  updateProduct,
} from "@/lib/server/admin-products";
import { jsonBody, withAdmin } from "@/lib/server/admin-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(
  request: Request,
  context: Context,
): Promise<Response> {
  const { id } = await context.params;
  return withAdmin(request, async ({ db, organization }) => {
    const product = await findProduct(db, organization.id, id);
    return Response.json(adminProductResponse(product));
  });
}

export async function PATCH(
  request: Request,
  context: Context,
): Promise<Response> {
  const { id } = await context.params;
  return withAdmin(request, async ({ db, organization }) => {
    const patch = adminProductPatchSchema.parse(await jsonBody(request));
    const product = await findProduct(db, organization.id, id);
    return Response.json(
      adminProductResponse(await updateProduct(db, product, patch)),
    );
  });
}

/**
 * Archiving is the default: it keeps the history of renders readable. Passing
 * ?permanent=true erases the product and every image it owns.
 */
export async function DELETE(
  request: Request,
  context: Context,
): Promise<Response> {
  const { id } = await context.params;
  return withAdmin(request, async ({ db, organization }) => {
    const permanent =
      new URL(request.url).searchParams.get("permanent") === "true";
    const product = await findProduct(db, organization.id, id);
    if (permanent) {
      await deleteProduct(db, product);
      return Response.json({ deleted: true, permanent: true });
    }
    return Response.json(
      adminProductResponse(await setProductStatus(db, product, "archived")),
    );
  });
}
