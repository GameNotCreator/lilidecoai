import { z } from "zod";

import {
  AdminProductError,
  adminProductResponse,
  duplicateProduct,
  findProduct,
  persistProduct,
  setProductStatus,
  syncProductAssetVisibility,
} from "@/lib/server/admin-products";
import { jsonBody, withAdmin } from "@/lib/server/admin-route";
import type { CutoutMetadata } from "@lili/types";

import {
  CUTOUT_VERSION,
  deleteAsset,
  prepareCutout,
  readAsset,
  storeAsset,
} from "@/lib/server/assets";
import { cutoutVerdict } from "@/lib/server/cutout-identity";
import { collections } from "@/lib/server/mongodb";
import { productAssetVisibility } from "@/lib/server/product-visibility";

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

    // prepare: rebuild the transparent cutout the renderer consumes.
    if (!product.assetId) {
      throw new AdminProductError("Ajoutez d’abord une photo de face.");
    }
    const source = await readAsset(db, product.assetId);
    if (!source) {
      throw new AdminProductError("Photo produit introuvable", 404);
    }
    // PRO-008. This path used `createCutout`, which discards the matte's
    // metadata, then marked the product ready with no `cutout` at all — a
    // product the render's trust gate refuses as "provenance unknown". It
    // now mattes, judges and records provenance exactly as /prepare does.
    const matte = await prepareCutout(source.buffer);
    const verdict = cutoutVerdict(matte.quality);
    if (!verdict.usable) throw new AdminProductError(verdict.detail, 422);
    const cutoutMetadata: CutoutMetadata = {
      widthPx: matte.widthPx,
      heightPx: matte.heightPx,
      baseRowFraction: matte.baseRowFraction,
      source: "heuristic",
      synthetic: false,
      shadowRemoved: matte.shadowRemoved,
      warnings: matte.warnings,
      cutoutVersion: CUTOUT_VERSION,
      verdict,
    };
    const asset = await storeAsset(db, {
      organizationId: organization.id,
      kind: "cutout",
      visibility: productAssetVisibility({ ...product, status: "draft" }),
      // A temporary product's images must not outlive it: the public routes
      // already inherit this, and the purge only ever reads `expiresAt`.
      ...(product.expiresAt ? { expiresAt: product.expiresAt } : {}),
      buffer: matte.buffer,
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
          cutout: cutoutMetadata,
          // Preparation and publication are separate decisions. The cutout is
          // ready, but the product stays a private draft until Publish.
          status: "draft",
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
    const updated = await findProduct(db, organization.id, id);
    await syncProductAssetVisibility(db, updated);
    return Response.json(adminProductResponse(updated));
  });
}
