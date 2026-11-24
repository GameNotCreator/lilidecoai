import { timingSafeEqual } from "node:crypto";
import { readMeasurementBatch } from "../../apps/web/lib/storefront-measurement";

type Env = {
  STOREFRONT_ANALYTICS_WRITE_TOKEN?: string;
  LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> };
  EVENTS: {
    writeDataPoint(point: {
      indexes: string[];
      blobs: string[];
      doubles: number[];
    }): void;
  };
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/collect"
    )
      return new Response(null, { status: 404 });

    const token = env.STOREFRONT_ANALYTICS_WRITE_TOKEN;
    const actual = Buffer.from(request.headers.get("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${token ?? ""}`);
    if (
      !token ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      return new Response(null, { status: 403 });

    const result = await readMeasurementBatch(request);
    if ("status" in result)
      return new Response(null, { status: result.status });
    const { batch } = result;
    const rateKey = request.headers.get("x-storefront-rate-key");
    const { success } = await env.LIMITER.limit({
      key: rateKey && /^[a-f0-9]{64}$/.test(rateKey) ? rateKey : batch.visitId,
    });
    if (!success) return new Response(null, { status: 429 });

    for (const event of batch.events) {
      env.EVENTS.writeDataPoint({
        indexes: [batch.visitId],
        blobs: [
          event.name,
          batch.channel,
          "categoryId" in event ? event.categoryId : "",
          "productId" in event ? event.productId : "",
          batch.screen,
          "size" in event ? event.size : "",
        ],
        doubles: [batch.sequence],
      });
    }
    return new Response(null, { status: 204 });
  },
};
