import {
  listQuerySchema,
  productQueryFilter,
  productSortSpec,
  productsToCsv,
} from "@/lib/server/admin-products";
import { withAdmin } from "@/lib/server/admin-route";
import { collections } from "@/lib/server/mongodb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return withAdmin(request, async ({ db, organization }) => {
    const params = new URL(request.url).searchParams;
    const query = listQuerySchema.parse(Object.fromEntries(params.entries()));
    const products = await collections(db)
      .products.find(productQueryFilter(organization.id, query))
      .sort(productSortSpec(query.sort))
      .limit(5_000)
      .toArray();
    // The BOM keeps accents readable when the file is opened in Excel.
    return new Response(`﻿${productsToCsv(products)}`, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="banque-produits.csv"`,
        "Cache-Control": "no-store",
        "X-Export-Limit": "5000",
      },
    });
  });
}
