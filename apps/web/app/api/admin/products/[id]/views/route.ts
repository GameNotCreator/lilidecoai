import sharp from "sharp";
import type { Db, Filter } from "mongodb";
import { z } from "zod";

import {
  AdminProductError,
  adminProductResponse,
  findProduct,
  syncProductAssetVisibility,
} from "@/lib/server/admin-products";
import { withAdmin } from "@/lib/server/admin-route";
import {
  ApiInputError,
  deleteAsset,
  normalizeImage,
  storeAsset,
  validateImage,
} from "@/lib/server/assets";
import { collections } from "@/lib/server/mongodb";
import { productAssetVisibility } from "@/lib/server/product-visibility";
import type { ProductDocument } from "@/lib/server/types";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const viewTypeSchema = z.enum([
  "top",
  "front",
  "three_quarter",
  "side",
  "back",
  "detail",
]);

/** Include the full view inventory: two uploads may finish in the same millisecond. */
function mutationFilter(product: ProductDocument): Filter<ProductDocument> {
  return {
    id: product.id,
    organizationId: product.organizationId,
    updatedAt: product.updatedAt,
    status: product.status,
    assetId: product.assetId ?? { $exists: false },
    cutoutAssetId: product.cutoutAssetId ?? { $exists: false },
    views: product.views ? { $eq: product.views } : { $exists: false },
    productPreparation: product.productPreparation
      ? { $eq: product.productPreparation }
      : { $exists: false },
  };
}

function nextUpdatedAt(product: ProductDocument): Date {
  return new Date(Math.max(Date.now(), product.updatedAt.getTime() + 1));
}

/** Retired source bytes remain available to immutable, already admitted renders. */
async function retireAssets(
  db: Db,
  organizationId: string,
  ids: Array<string | undefined>,
) {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length)
    await collections(db).assets.updateMany(
      { organizationId, id: { $in: unique } },
      { $set: { visibility: "private" } },
    );
}

function changedProduct(): AdminProductError {
  return new AdminProductError(
    "La fiche a changé pendant la modification des photos. Rechargez-la puis réessayez.",
    409,
  );
}

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  const { id } = await context.params;
  return withAdmin(request, async ({ db, organization }) => {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new ApiInputError("Fichier requis");
    const viewType = viewTypeSchema.parse(form.get("viewType") ?? "front");
    const product = await findProduct(db, organization.id, id);
    if (product.status === "archived")
      throw new AdminProductError(
        "Restaurez le produit avant de modifier ses photos.",
        409,
      );

    const input = Buffer.from(await file.arrayBuffer());
    await validateImage(input, file.type);
    const normalized = await normalizeImage(input);
    const metadata = await sharp(normalized).metadata();
    const asset = await storeAsset(db, {
      organizationId: organization.id,
      kind: viewType === "front" ? "product" : "product_view",
      visibility: productAssetVisibility({ ...product, status: "processing" }),
      // A temporary product's images must not outlive it: the public routes
      // already inherit this, and the purge only ever reads `expiresAt`.
      ...(product.expiresAt ? { expiresAt: product.expiresAt } : {}),
      buffer: normalized,
      contentType: "image/webp",
    });

    const currentViews = product.views ?? [];
    const previous = currentViews.find((view) => view.type === viewType);
    const views = [
      ...currentViews.filter((view) => view.type !== viewType),
      {
        id: previous?.id ?? crypto.randomUUID(),
        assetId: asset.id,
        type: viewType,
        widthPx: metadata.width ?? 0,
        heightPx: metadata.height ?? 0,
        validationStatus: "valid" as const,
        createdAt: previous?.createdAt ?? new Date(),
      },
    ];
    let discardUpload = false;
    try {
      const updatedAt = nextUpdatedAt(product);
      const result = await collections(db).products.updateOne(
        mutationFilter(product),
        {
          $set: {
            views,
            updatedAt,
            ...(viewType === "front"
              ? { assetId: asset.id, status: "processing" as const }
              : {}),
          },
          // A new front photo invalidates the cutout made from the old one.
          // Keeping it left the product describing one photo and rendering
          // another — the identity hole PRO-008 closes, reached from the back
          // office rather than from /prepare.
          ...(viewType === "front"
            ? {
                $unset: {
                  cutoutAssetId: "",
                  cutout: "",
                  productPreparation: "",
                  spatialPreparation: "",
                },
              }
            : {}),
        },
      );
      if (!result.matchedCount) {
        discardUpload = true;
        throw changedProduct();
      }
      await retireAssets(db, organization.id, [
        previous?.assetId,
        ...(viewType === "front"
          ? [product.assetId, product.cutoutAssetId]
          : []),
      ]);
      const updated = await findProduct(db, organization.id, id);
      await syncProductAssetVisibility(db, updated);
      return Response.json(adminProductResponse(updated), { status: 201 });
    } catch (reason) {
      // Delete only after a definite CAS conflict. A database error may hide a
      // successful commit, so deleting its upload would break the attached view.
      if (discardUpload) await deleteAsset(db, asset.id).catch(() => undefined);
      throw reason;
    }
  });
}

export async function DELETE(
  request: Request,
  context: Context,
): Promise<Response> {
  const { id } = await context.params;
  return withAdmin(request, async ({ db, organization }) => {
    const viewType = viewTypeSchema.parse(
      new URL(request.url).searchParams.get("type") ?? "",
    );
    const product = await findProduct(db, organization.id, id);
    if (product.status === "archived")
      throw new AdminProductError(
        "Restaurez le produit avant de modifier ses photos.",
        409,
      );
    const view = (product.views ?? []).find((item) => item.type === viewType);
    if (!view) throw new AdminProductError("Cette vue n’existe pas", 404);

    const views = (product.views ?? []).filter(
      (item) => item.type !== viewType,
    );
    const result = await collections(db).products.updateOne(
      mutationFilter(product),
      {
        $set: {
          views,
          updatedAt: nextUpdatedAt(product),
          ...(viewType === "front" ? { status: "draft" as const } : {}),
        },
        // The measurements describe an image that no longer exists.
        ...(viewType === "front"
          ? {
              $unset: {
                assetId: "",
                cutoutAssetId: "",
                cutout: "",
                productPreparation: "",
                spatialPreparation: "",
              },
            }
          : {}),
      },
    );
    if (!result.matchedCount) throw changedProduct();
    await retireAssets(db, organization.id, [
      view.assetId,
      ...(viewType === "front" ? [product.assetId, product.cutoutAssetId] : []),
    ]);
    const updated = await findProduct(db, organization.id, id);
    await syncProductAssetVisibility(db, updated);
    return Response.json(adminProductResponse(updated));
  });
}
