import "server-only";

/** Next can normalize request.url to its listener host; Host is the browser's destination. */
export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin || request.headers.get("sec-fetch-site") === "cross-site")
    return false;
  try {
    const parsed = new URL(origin);
    const destination = new URL(request.url);
    const host = request.headers.get("host") ?? destination.host;
    return (
      parsed.origin === origin &&
      ["https:", "http:"].includes(parsed.protocol) &&
      parsed.host === host &&
      (process.env.NODE_ENV !== "production" || parsed.protocol === "https:")
    );
  } catch {
    return false;
  }
}
