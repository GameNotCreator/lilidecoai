import { z } from "zod";
import { storefrontCategories } from "@/lib/storefront-categories";
import { detail, jsonBody, withAdmin } from "@/lib/server/admin-route";
import { collections } from "@/lib/server/mongodb";
import {
  listStorefrontProducts,
  readStorefrontProductOrder,
} from "@/lib/server/storefront";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const orderSchema = z.object({
  ids: z.array(z.string().min(1).max(128)).max(20_000),
  revision: z.number().int().nonnegative(),
  scope: z.enum(["products", "categories"]).default("products"),
});

export function GET(request: Request): Promise<Response> {
  return withAdmin(request, async ({ db, organization }) =>
    Response.json(await readStorefrontProductOrder(db, organization)),
  );
}

export function PUT(request: Request): Promise<Response> {
  return withAdmin(request, async ({ db, organization }) => {
    const { ids, revision, scope } = orderSchema.parse(await jsonBody(request));
    const categories = scope === "categories";
    const items = categories
      ? storefrontCategories(organization.storefrontCategories)
      : await listStorefrontProducts(db, organization);
    const requestedIds = new Set(ids);
    if (
      requestedIds.size !== ids.length ||
      items.length !== ids.length ||
      items.some(({ id }) => !requestedIds.has(id))
    ) {
      return detail(
        categories
          ? "La liste des catégories a changé. Rechargez l’ordre du catalogue."
          : "La liste des produits publiés a changé. Rechargez l’ordre du catalogue.",
        409,
      );
    }

    const field = categories
      ? "storefrontCategoryOrder"
      : "storefrontProductOrder";
    const nextRevision = revision + 1;
    const result = await collections(db).organizations.updateOne(
      {
        id: organization.id,
        [`${field}.revision`]: revision === 0 ? { $in: [null, 0] } : revision,
      },
      { $set: { [field]: { ids, revision: nextRevision } } },
    );
    if (result.matchedCount === 0) {
      return detail(
        "L’ordre de la boutique a changé. Rechargez-le avant de réessayer.",
        409,
      );
    }
    return Response.json({ revision: nextRevision });
  });
}
