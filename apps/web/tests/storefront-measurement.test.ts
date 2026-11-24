import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock(
  "@/lib/server/request-origin",
  () => import("../lib/server/request-origin"),
);
vi.mock(
  "@/lib/server/storefront-measurement-config",
  () => import("../lib/server/storefront-measurement-config"),
);
vi.mock(
  "@/lib/storefront-measurement",
  () => import("../lib/storefront-measurement"),
);

import worker from "../../../infra/storefront-analytics/worker";
import { POST } from "../app/api/storefront/measure/route";
import { measurementChannel } from "../lib/storefront-measurement-client";
import {
  measurementByteLimit,
  measurementChoiceCookie,
  type MeasurementBatch,
} from "../lib/storefront-measurement";

const site = "https://boutique.example.test";
const endpoint = "https://analytics.example.test";
const token = "test-token-only-for-storefront-measurement";
const sample = {
  visitId: "12345678-1234-4123-8123-123456789012",
  sequence: 1,
  channel: "paid-social",
  screen: "small",
  events: [
    {
      name: "product_viewed",
      productId: "11111111-1111-4111-8111-111111111111",
      categoryId: "cadeaux",
    },
    { name: "checkout_started", size: "2-3" },
    { name: "order_request_recorded" },
  ],
} satisfies MeasurementBatch;

function publicPost(choice = "10", origin = site, body: unknown = sample) {
  return new Request(`${site}/api/storefront/measure`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      Cookie: `${measurementChoiceCookie}=${choice}`,
      "X-Vercel-Forwarded-For": "203.0.113.4",
    },
    body: JSON.stringify(body),
  });
}

function workerPost(body: unknown = sample, secret = token) {
  return new Request(`${endpoint}/collect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(body),
  });
}

function configured() {
  vi.stubEnv("STOREFRONT_ANALYTICS_WORKER_URL", endpoint);
  vi.stubEnv("STOREFRONT_ANALYTICS_WRITE_TOKEN", token);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("storefront audience measurement", () => {
  it("does not forward data without configuration, a same-origin browser and audience consent", async () => {
    vi.stubEnv("STOREFRONT_ANALYTICS_WORKER_URL", "");
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    expect((await POST(publicPost())).status).toBe(404);
    configured();
    expect((await POST(publicPost("01"))).status).toBe(403);
    expect(
      (await POST(publicPost("11", "https://elsewhere.example.test"))).status,
    ).toBe(403);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("rejects extra fields, duplicate events and a body above the byte cap", async () => {
    configured();
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const events = [
      { ...sample.events[0], email: "never-in-the-dataset@example.test" },
    ];
    expect(
      (await POST(publicPost("10", site, { ...sample, events }))).status,
    ).toBe(400);
    expect(
      (
        await POST(
          publicPost("10", site, {
            ...sample,
            events: [sample.events[0], sample.events[0]],
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await POST(publicPost("10", site, "é".repeat(measurementByteLimit))))
        .status,
    ).toBe(413);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("sends a single authenticated batch to the Worker, with only a keyed abuse identifier", async () => {
    configured();
    vi.stubEnv("VERCEL", "1");
    const events = vi.fn();
    const limit = vi.fn().mockResolvedValue({ success: true });
    const outbound = vi.fn((url: string, init: RequestInit) =>
      worker.fetch(new Request(url, init), {
        STOREFRONT_ANALYTICS_WRITE_TOKEN: token,
        LIMITER: { limit },
        EVENTS: { writeDataPoint: events },
      }),
    );
    vi.stubGlobal("fetch", outbound);
    expect((await POST(publicPost())).status).toBe(204);
    expect(outbound).toHaveBeenCalledTimes(1);
    const [url, { headers, body }] = outbound.mock.calls[0]!;
    expect(url).toBe(`${endpoint}/collect`);
    expect(JSON.parse(String(body))).toEqual(sample);
    expect(new Headers(headers).get("x-storefront-rate-key")).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(JSON.stringify({ headers, body })).not.toContain("203.0.113.4");
    expect(events).toHaveBeenCalledTimes(3);
    expect(events).toHaveBeenLastCalledWith({
      indexes: [sample.visitId],
      blobs: ["order_request_recorded", "paid-social", "", "", "small", ""],
      doubles: [1],
    });
  });

  it("accepts writes only from the shop and respects the Worker limit", async () => {
    const writeDataPoint = vi.fn();
    const limit = vi.fn().mockResolvedValue({ success: false });
    const env = {
      STOREFRONT_ANALYTICS_WRITE_TOKEN: token,
      EVENTS: { writeDataPoint },
      LIMITER: { limit },
    };
    expect((await worker.fetch(workerPost(sample, "wrong"), env)).status).toBe(
      403,
    );
    expect(limit).not.toHaveBeenCalled();
    expect((await worker.fetch(workerPost(), env)).status).toBe(429);
    expect(writeDataPoint).not.toHaveBeenCalled();
  });

  it("reports Worker unavailability without retrying", async () => {
    configured();
    const outbound = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", outbound);
    expect((await POST(publicPost())).status).toBe(503);
    expect(outbound).toHaveBeenCalledTimes(1);
  });

  it("keeps only approved acquisition buckets", () => {
    expect(
      measurementChannel(
        "?utm_source=meta&utm_medium=paid_social",
        "",
        "shop.test",
      ),
    ).toBe("paid-social");
    expect(
      measurementChannel(
        "",
        "https://www.google.tn/search?q=private",
        "shop.test",
      ),
    ).toBe("organic");
    expect(
      measurementChannel(
        "",
        "https://instagram.com.evil.test/somewhere",
        "shop.test",
      ),
    ).toBe("other");
    expect(measurementChannel("", "https://m.facebook.com/", "shop.test")).toBe(
      "social",
    );
  });
});
