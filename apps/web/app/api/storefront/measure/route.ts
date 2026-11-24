import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { isSameOriginRequest } from "@/lib/server/request-origin";
import { storefrontAnalyticsDestination } from "@/lib/server/storefront-measurement-config";
import {
  readMeasurementBatch,
  readMeasurementChoice,
} from "@/lib/storefront-measurement";

function response(status: number) {
  return new Response(null, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

export async function POST(request: Request) {
  const destination = storefrontAnalyticsDestination();
  if (!destination) return response(404);
  if (
    !isSameOriginRequest(request) ||
    readMeasurementChoice(request.headers.get("cookie") ?? "")?.[0] !== "1"
  )
    return response(403);

  const result = await readMeasurementBatch(request);
  if ("status" in result) return response(result.status);

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${destination.token}`,
  };
  const ip =
    process.env.VERCEL === "1"
      ? request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim()
      : undefined;
  const rateKey =
    ip && isIP(ip)
      ? createHmac("sha256", destination.token).update(ip).digest("hex")
      : result.batch.visitId;

  try {
    const upstream = await fetch(destination.url, {
      method: "POST",
      headers: { ...headers, "X-Storefront-Rate-Key": rateKey },
      body: JSON.stringify(result.batch),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(2500),
    });
    return response(upstream.ok ? 204 : upstream.status === 429 ? 429 : 503);
  } catch {
    return response(503);
  }
}
