import { readAsset } from "@/lib/server/assets";
import { tenantForRequest } from "@/lib/server/auth";
import { serverConfig } from "@/lib/server/config";
import { database } from "@/lib/server/mongodb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const db = await database();
  const result = await readAsset(db, id);
  if (!result) return new Response("Not found", { status: 404 });

  const publiclyReadable = ["product", "cutout"].includes(result.asset.kind);
  if (!publiclyReadable && !serverConfig.demoMode) {
    try {
      const tenant = await tenantForRequest(request);
      if (tenant.organizationId !== result.asset.organizationId) {
        return new Response("Forbidden", { status: 403 });
      }
      if (tenant.publicSessionId) {
        const permitted =
          result.asset.kind === "scene"
            ? await db.collection("scenes").findOne({
                assetId: result.asset.id,
                organizationId: tenant.organizationId,
                publicSessionId: tenant.publicSessionId,
              })
            : await db.collection("renders").findOne({
                resultAssetId: result.asset.id,
                organizationId: tenant.organizationId,
                publicSessionId: tenant.publicSessionId,
              });
        if (!permitted) return new Response("Forbidden", { status: 403 });
      }
    } catch {
      return new Response("Unauthorized", { status: 401 });
    }
  }
  const body = new Uint8Array(result.buffer.length);
  body.set(result.buffer);
  return new Response(body.buffer, {
    headers: {
      "Content-Type": result.asset.contentType,
      "Content-Length": String(result.buffer.length),
      "Cache-Control": publiclyReadable
        ? "public, max-age=31536000, immutable"
        : "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
