import { z } from "zod";

import {
  AdminProductError,
  deleteProduct,
  findProduct,
  persistProduct,
  setProductStatus,
} from "@/lib/server/admin-products";
import { jsonBody, withAdmin } from "@/lib/server/admin-route";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

const bulkSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
  action: z.enum(["publish", "unpublish", "archive", "restore", "persist", "delete"]),
});

export async function POST(request: Request): Promise<Response> {
  return withAdmin(request, async ({ db, organization }) => {
    const { ids, action } = bulkSchema.parse(await jsonBody(request));
    const succeeded: string[] = [];
    const failed: Array<{ id: string; detail: string }> = [];

    for (const id of ids) {
      try {
        const product = await findProduct(db, organization.id, id);
        if (action === "delete") {
          await deleteProduct(db, product);
        } else if (action === "persist") {
          await persistProduct(db, product);
        } else if (action === "publish") {
          await setProductStatus(db, product, "ready");
        } else if (action === "unpublish") {
          await setProductStatus(db, product, "draft");
        } else if (action === "archive") {
          await setProductStatus(db, product, "archived");
        } else {
          await setProductStatus(
            db,
            product,
            product.cutoutAssetId ? "ready" : "draft",
          );
        }
        succeeded.push(id);
      } catch (reason) {
        failed.push({
          id,
          detail:
            reason instanceof AdminProductError
              ? reason.message
              : "Opération impossible",
        });
      }
    }
    return Response.json({ action, succeeded, failed });
  });
}
