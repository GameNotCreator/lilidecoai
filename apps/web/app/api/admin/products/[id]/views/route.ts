import sharp from "sharp";
import { z } from "zod";

import {
  AdminProductError,
  adminProductResponse,
  findProduct,
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

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const viewTypeSchema = z.enum([
  "front",
  "three_quarter",
  "side",
  "back",
  "detail",
]);

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

    const input = Buffer.from(await file.arrayBuffer());
    await validateImage(input, file.type);
    const normalized = await normalizeImage(input);
    const metadata = await sharp(normalized).metadata();
    const asset = await storeAsset(db, {
      organizationId: organization.id,
      kind: viewType === "front" ? "product" : "product_view",
      buffer: normalized,
      contentType: "image/webp",
    });

    const currentViews = product.views ?? [];
    const previous = currentViews.find((view) => view.type === viewType);
    if (previous?.assetId) {
      await deleteAsset(db, previous.assetId).catch(() => undefined);
    }
    if (
      viewType === "front" &&
      product.assetId &&
      product.assetId !== previous?.assetId
    ) {
      await deleteAsset(db, product.assetId).catch(() => undefined);
    }
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
    await collections(db).products.updateOne(
      { id: product.id, organizationId: organization.id },
      {
        $set: {
          views,
          updatedAt: new Date(),
          ...(viewType === "front"
            ? { assetId: asset.id, status: "processing" as const }
            : {}),
        },
      },
    );
    return Response.json(
      adminProductResponse(await findProduct(db, organization.id, id)),
      { status: 201 },
    );
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
    const view = (product.views ?? []).find((item) => item.type === viewType);
    if (!view) throw new AdminProductError("Cette vue n’existe pas", 404);

    await deleteAsset(db, view.assetId).catch(() => undefined);
    const views = (product.views ?? []).filter((item) => item.type !== viewType);
    if (viewType === "front") {
      // Without a front photo the product can no longer be rendered.
      if (product.cutoutAssetId) {
        await deleteAsset(db, product.cutoutAssetId).catch(() => undefined);
      }
      await collections(db).products.updateOne(
        { id: product.id, organizationId: organization.id },
        {
          $set: { views, status: "draft", updatedAt: new Date() },
          $unset: { assetId: "", cutoutAssetId: "" },
        },
      );
    } else {
      await collections(db).products.updateOne(
        { id: product.id, organizationId: organization.id },
        { $set: { views, updatedAt: new Date() } },
      );
    }
    return Response.json(
      adminProductResponse(await findProduct(db, organization.id, id)),
    );
  });
}
