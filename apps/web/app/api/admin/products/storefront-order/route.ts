import { z } from "zod";
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
});

export function GET(request: Request): Promise<Response> {
  return withAdmin(request, async ({ db, organization }) =>
    Response.json(await readStorefrontProductOrder(db, organization)),
  );
}

export function PUT(request: Request): Promise<Response> {
  return withAdmin(request, async ({ db, organization }) => {
    const { ids, revision } = orderSchema.parse(await jsonBody(request));
    const products = await listStorefrontProducts(db, organization);
    const requestedIds = new Set(ids);
    if (
      requestedIds.size !== ids.length ||
      products.length !== ids.length ||
      products.some((product) => !requestedIds.has(product.id))
    ) {
      return detail(
        "La liste des produits publiés a changé. Rechargez l’ordre de la boutique.",
        409,
      );
    }

    const nextRevision = revision + 1;
    const result = await collections(db).organizations.updateOne(
      {
        id: organization.id,
        "storefrontProductOrder.revision":
          revision === 0 ? { $exists: false } : revision,
      },
      { $set: { storefrontProductOrder: { ids, revision: nextRevision } } },
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
