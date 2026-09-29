import { withAdmin, jsonBody } from "@/lib/server/admin-route";
import { findProduct, adminProductResponse } from "@/lib/server/admin-products";
import { savePlanarTexture } from "@/lib/server/planar-texture";
import { collections } from "@/lib/server/mongodb";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function PUT(request: Request, context: Context) {
  const { id } = await context.params;
  return withAdmin(request, async ({ db, organization }) =>
    Response.json(
      adminProductResponse(
        await savePlanarTexture(
          db,
          await findProduct(db, organization.id, id),
          await jsonBody(request),
        ),
      ),
    ),
  );
}
export async function DELETE(request: Request, context: Context) {
  const { id } = await context.params;
  return withAdmin(request, async ({ db, organization }) => {
    await findProduct(db, organization.id, id);
    await collections(db).products.updateOne(
      { id, organizationId: organization.id },
      {
        $unset: { planarTexture: "", spatialPreparation: "" },
        $set: { updatedAt: new Date() },
      },
    );
    return Response.json(
      adminProductResponse(await findProduct(db, organization.id, id)),
    );
  });
}
