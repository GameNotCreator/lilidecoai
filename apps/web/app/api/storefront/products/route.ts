import { database } from "@/lib/server/mongodb";
import { getStorefrontCatalog } from "@/lib/server/storefront";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(await getStorefrontCatalog(await database()), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      {
        detail:
          "Le catalogue est momentanément indisponible. Réessayez dans un instant.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
