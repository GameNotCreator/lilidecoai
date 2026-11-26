import { z } from "zod";
import { addStorefrontCategory } from "@/lib/server/admin-products";
import { jsonBody, withAdmin } from "@/lib/server/admin-route";
import {
  storefrontCategories,
  storefrontCategoryLabelSchema,
} from "@/lib/storefront-categories";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const categoryInput = z
  .object({ label: storefrontCategoryLabelSchema })
  .strict();

export function GET(request: Request) {
  return withAdmin(request, async ({ organization }) =>
    Response.json(
      {
        categories: storefrontCategories(
          organization.storefrontCategories,
          organization.storefrontCategoryOrder?.ids,
        ),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    ),
  );
}

export function POST(request: Request) {
  return withAdmin(request, async ({ db, organization }) => {
    const { label } = categoryInput.parse(await jsonBody(request));
    return Response.json(await addStorefrontCategory(db, organization, label), {
      status: 201,
    });
  });
}
