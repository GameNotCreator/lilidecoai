import { z } from "zod";
import { adminProductResponse, AdminProductError } from "@/lib/server/admin-products";
import { withAdmin } from "@/lib/server/admin-route";
import { prepareAdminProduct } from "@/lib/server/admin-product-preparation";
import { MAX_ADMIN_MASK_BYTES } from "@/lib/server/admin-product-mask";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Bounded raw PNG avoids multipart buffering before the size check. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return withAdmin(request, async ({ db, organization }) => {
    if (request.headers.get("content-type")?.split(";")[0] !== "image/png" || !request.body)
      throw new AdminProductError("Un masque PNG est requis.", 422);
    const sourceAssetId = z.string().uuid().parse(request.headers.get("x-source-asset-id"));
    const sourceSha256 = z.string().regex(/^[a-f0-9]{64}$/).parse(request.headers.get("x-source-sha256"));
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_ADMIN_MASK_BYTES) throw new AdminProductError("Le masque dépasse 4 Mo.", 413);
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const product = await prepareAdminProduct(db, organization.id, id, {
      buffer: Buffer.concat(chunks), sourceAssetId, sourceSha256,
    });
    return Response.json(adminProductResponse(product));
  });
}
