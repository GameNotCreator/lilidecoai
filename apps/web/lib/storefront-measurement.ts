import { z } from "zod";
import { storefrontCategorySchema } from "./storefront-categories";

export const measurementChoiceCookie = "lilideco_measurement_v1";
export type MeasurementChoice = "00" | "01" | "10" | "11";
export const measurementBatchLimit = 20;
export const measurementByteLimit = 12 * 1024;

export function readMeasurementChoice(
  cookies: string,
): MeasurementChoice | null {
  for (const cookie of cookies.split(";")) {
    const [name, value] = cookie.trim().split("=", 2);
    if (name !== measurementChoiceCookie) continue;
    return value === "00" || value === "01" || value === "10" || value === "11"
      ? value
      : null;
  }
  return null;
}

export const measurementChannelSchema = z.enum([
  "organic",
  "social",
  "paid-social",
  "direct",
  "other",
]);
export type MeasurementChannel = z.infer<typeof measurementChannelSchema>;

const productFields = {
  productId: z.uuid(),
  categoryId: storefrontCategorySchema,
};
export const measurementEventSchema = z.discriminatedUnion("name", [
  z.strictObject({ name: z.literal("catalogue_viewed") }),
  z.strictObject({
    name: z.literal("category_selected"),
    categoryId: storefrontCategorySchema,
  }),
  z.strictObject({ name: z.literal("product_viewed"), ...productFields }),
  z.strictObject({ name: z.literal("cart_item_added"), ...productFields }),
  z.strictObject({
    name: z.literal("checkout_started"),
    size: z.enum(["1", "2-3", "4+"]),
  }),
  z.strictObject({ name: z.literal("order_request_recorded") }),
]);
export type MeasurementEvent = z.infer<typeof measurementEventSchema>;

export function measurementEventKey(event: MeasurementEvent) {
  if ("productId" in event) return `${event.name}:${event.productId}`;
  if ("categoryId" in event) return `${event.name}:${event.categoryId}`;
  return event.name;
}

export const measurementBatchSchema = z
  .strictObject({
    visitId: z.uuidv4(),
    sequence: z.union([z.literal(1), z.literal(2)]),
    channel: measurementChannelSchema,
    screen: z.enum(["small", "wide"]),
    events: z.array(measurementEventSchema).min(1).max(measurementBatchLimit),
  })
  .refine(
    ({ events }) =>
      new Set(events.map(measurementEventKey)).size === events.length,
  );

export type MeasurementBatch = z.infer<typeof measurementBatchSchema>;

export async function readMeasurementBatch(
  request: Request,
): Promise<{ batch: MeasurementBatch } | { status: 400 | 413 | 415 }> {
  const contentType = request.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") return { status: 415 };
  if (Number(request.headers.get("content-length")) > measurementByteLimit)
    return { status: 413 };
  const reader = request.body?.getReader();
  if (!reader) return { status: 400 };

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let body = "";
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > measurementByteLimit) {
        void reader.cancel().catch(() => {});
        return { status: 413 };
      }
      body += decoder.decode(part.value, { stream: true });
    }
    const result = measurementBatchSchema.safeParse(
      JSON.parse(body + decoder.decode()),
    );
    return result.success ? { batch: result.data } : { status: 400 };
  } catch {
    return { status: 400 };
  } finally {
    reader.releaseLock();
  }
}
