import type { AnalyticsEventName } from "@lili/types";

export interface AnalyticsPayload {
  event: AnalyticsEventName;
  properties?: Record<string, boolean | number | string | null>;
}

export async function track(
  payload: AnalyticsPayload,
  endpoint = "/api/analytics",
): Promise<void> {
  // Photos and base64 values are intentionally rejected at this boundary.
  const serialized = JSON.stringify(payload);
  if (serialized.includes("data:image") || serialized.length > 8_192) {
    throw new Error("Analytics payload contains prohibited or oversized data");
  }
  await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: serialized,
    keepalive: true,
  });
}

