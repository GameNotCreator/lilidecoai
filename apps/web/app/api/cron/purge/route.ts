import { deleteAsset } from "@/lib/server/assets";
import { serverConfig } from "@/lib/server/config";
import { collections, database } from "@/lib/server/mongodb";

export const runtime = "nodejs";
export const maxDuration = 300;

function isAuthorized(request: Request): boolean {
  if (!serverConfig.cronSecret) {
    return process.env.NODE_ENV !== "production";
  }
  return (
    request.headers.get("authorization") === `Bearer ${serverConfig.cronSecret}`
  );
}

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorized(request)) {
    return Response.json({ error: "Non autorisé" }, { status: 401 });
  }

  const db = await database();
  const expired = await collections(db)
    .assets.find({ expiresAt: { $lte: new Date() } }, { projection: { id: 1 } })
    .limit(500)
    .toArray();

  const results = await Promise.allSettled(
    expired.map((asset) => deleteAsset(db, asset.id)),
  );
  const deleted = results.filter(
    (result) => result.status === "fulfilled",
  ).length;

  return Response.json({
    ok: true,
    deleted,
    failed: results.length - deleted,
  });
}
