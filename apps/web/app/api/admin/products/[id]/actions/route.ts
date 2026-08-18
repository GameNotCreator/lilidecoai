import { z } from "zod";

import {
  AdminProductError,
  adminProductResponse,
  duplicateProduct,
  findProduct,
  persistProduct,
  setProductStatus,
} from "@/lib/server/admin-products";
import { jsonBody, withAdmin } from "@/lib/server/admin-route";
import { createCutout, deleteAsset, readAsset, storeAsset } from "@/lib/server/assets";
import { collections } from "@/lib/server/mongodb";

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
        adminProductResponse(
          await setProductStatus(
            db,
            product,
            product.cutoutAssetId ? "ready" : "draft",
          ),
        ),
      );
    }

    // prepare: rebuild the transparent cutout the renderer consumes.
    if (!product.assetId) {
      throw new AdminProductError("Ajoutez d’abord une photo de face.");
    }
    const source = await readAsset(db, product.assetId);
    if (!source) {
      throw new AdminProductError("Photo produit introuvable", 404);
    }
    const cutout = await createCutout(source.buffer);
    const asset = await storeAsset(db, {
      organizationId: organization.id,
      kind: "cutout",
      buffer: cutout,
      contentType: "image/webp",
    });
    if (product.cutoutAssetId) {
      await deleteAsset(db, product.cutoutAssetId).catch(() => undefined);
    }
    const updatedAt = new Date();
    await collections(db).products.updateOne(
      { id: product.id, organizationId: organization.id },
      {
        $set: {
          cutoutAssetId: asset.id,
          status: "ready",
          anchor: product.anchor ?? {
            anchorType: "bottom_center",
            xNormalized: 0.5,
            yNormalized: 1,
          },
          archivedAt: null,
          updatedAt,
        },
      },
    );
    return Response.json(
      adminProductResponse(await findProduct(db, organization.id, id)),
    );
  });
}
