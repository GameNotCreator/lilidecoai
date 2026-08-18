import {
  adminProductResponse,
  adminProductSchema,
  createProduct,
  listProducts,
  listQuerySchema,
} from "@/lib/server/admin-products";
import { jsonBody, withAdmin } from "@/lib/server/admin-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return withAdmin(request, async ({ db, organization }) => {
    const params = new URL(request.url).searchParams;
    const query = listQuerySchema.parse(Object.fromEntries(params.entries()));
    return Response.json(await listProducts(db, organization.id, query));
  });
}

export async function POST(request: Request): Promise<Response> {
  return withAdmin(request, async ({ db, organization }) => {
    const input = adminProductSchema.parse(await jsonBody(request));
    const product = await createProduct(db, organization.id, input);
    return Response.json(adminProductResponse(product), { status: 201 });
  });
}
