import "server-only";
import { createHash, createHmac, randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { z } from "zod";
import {
  orderRequestSchema,
  type CheckoutAvailability,
  type OrderReceipt,
  type OrderRequestInput,
  type OrderRequestStatus,
} from "../checkout";
import type { StorefrontProduct } from "../storefront";
import { serverConfig } from "./config";
import { getStorefrontCatalog, storefrontOrganization } from "./storefront";
import { enforceRateLimit } from "./rate-limit";
import { orderEmailConfiguration, sendOrderNotification } from "./order-email";

export class OrderRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export interface OrderRequestDocument {
  _id: string;
  id: string;
  organizationId: string;
  reference: string;
  fingerprint: string;
  customer: Pick<
    OrderRequestInput,
    "fullName" | "phone" | "email" | "city" | "address" | "note"
  >;
  items: {
    productId: string;
    name: string;
    quantity: number;
    unitPriceCents: number | null;
    stockToConfirm: boolean;
  }[];
  subtotalCents: number | null;
  currency: "TND";
  status: OrderRequestStatus;
  consentVersion: "2026-09-29";
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  notification: {
    status: "pending" | "sending" | "sent" | "failed";
    firstAttemptAt?: Date;
    leaseUntil?: Date;
    providerId?: string;
  };
}

export function orderRequests(db: Db) {
  return db.collection<OrderRequestDocument>("storefront_order_requests");
}

export function orderRequestRetentionDays(): number {
  const value = Number(process.env.ORDER_REQUEST_RETENTION_DAYS ?? 90);
  return Number.isInteger(value) && value >= 1 && value <= 365 ? value : 90;
}

export function checkoutAvailability(): CheckoutAvailability {
  return process.env.STOREFRONT_ORDERS_ENABLED === "true" &&
    orderEmailConfiguration() &&
    (serverConfig.sessionSecret?.length ?? 0) >= 32
    ? { available: true }
    : {
        available: false,
        reason:
          "La demande en ligne sera bientôt disponible. Contactez directement ByLiliDeco pour votre sélection.",
      };
}

export async function ensureOrderIndexes(db: Db) {
  await Promise.all([
    orderRequests(db).createIndex({ organizationId: 1, createdAt: -1 }),
    orderRequests(db).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);
}

// Ce devis relit prix et stock ; il ne réserve ni ne décrémente les quantités.
export function quoteOrderItems(
  input: OrderRequestInput["items"],
  products: StorefrontProduct[],
) {
  const items = input.map((line) => {
    const product = products.find((item) => item.id === line.productId);
    if (!product)
      throw new OrderRequestError(
        "Un article n’est plus disponible. Revenez au panier pour actualiser votre sélection.",
        409,
      );
    if (product.currency !== "TND")
      throw new OrderRequestError(
        "Le prix de cet article doit être confirmé par la boutique.",
        409,
      );
    if (product.stock !== null && line.quantity > product.stock)
      throw new OrderRequestError(
        `La quantité demandée pour ${product.name} n’est plus disponible.`,
        409,
      );
    if (
      product.priceCents !== null &&
      (!Number.isSafeInteger(product.priceCents) || product.priceCents < 0)
    )
      throw new OrderRequestError(
        "Le prix d’un article doit être confirmé par la boutique.",
        409,
      );
    return {
      productId: product.id,
      name: product.name,
      quantity: line.quantity,
      unitPriceCents: product.priceCents,
      stockToConfirm: product.stock === null,
    };
  });
  const subtotalCents = items.some((item) => item.unitPriceCents === null)
    ? null
    : items.reduce(
        (sum, item) => sum + item.unitPriceCents! * item.quantity,
        0,
      );
  if (subtotalCents !== null && !Number.isSafeInteger(subtotalCents))
    throw new OrderRequestError(
      "Cette sélection doit être confirmée par la boutique.",
      409,
    );
  return { items, subtotalCents };
}

function receipt(order: OrderRequestDocument): OrderReceipt {
  return {
    reference: order.reference,
    recorded: true,
    notification: order.notification.status === "sent" ? "sent" : "pending",
  };
}

/** Claim before sending; the fixed provider key covers crashes between send and persistence. */
export async function notifyOrderRequest(
  db: Db,
  order: OrderRequestDocument,
): Promise<void> {
  const now = new Date();
  // Resend only retains keys for 24h. Beyond 23h an uncertain send needs manual investigation, not an automatic replay.
  if (
    order.notification.firstAttemptAt &&
    now.getTime() - order.notification.firstAttemptAt.getTime() >= 23 * 3600_000
  )
    return;
  const claimed = await orderRequests(db).findOneAndUpdate(
    {
      _id: order._id,
      organizationId: order.organizationId,
      expiresAt: { $gt: now },
      $and: [
        {
          $or: [
            { "notification.status": { $in: ["pending", "failed"] } },
            {
              "notification.status": "sending",
              "notification.leaseUntil": { $lt: now },
            },
          ],
        },
        {
          $or: [
            { "notification.firstAttemptAt": { $exists: false } },
            {
              "notification.firstAttemptAt": {
                $gt: new Date(now.getTime() - 23 * 3600_000),
              },
            },
          ],
        },
      ],
    },
    {
      $set: {
        "notification.status": "sending",
        "notification.leaseUntil": new Date(now.getTime() + 60_000),
        "notification.firstAttemptAt": order.notification.firstAttemptAt ?? now,
      },
    },
    { returnDocument: "after" },
  );
  if (!claimed) return;
  try {
    const providerId = await sendOrderNotification(claimed);
    await orderRequests(db).updateOne(
      { _id: order._id },
      {
        $set: {
          "notification.status": "sent",
          "notification.providerId": providerId,
        },
        $unset: { "notification.leaseUntil": "" },
      },
    );
  } catch {
    await orderRequests(db).updateOne(
      { _id: order._id },
      {
        $set: { "notification.status": "failed" },
        $unset: { "notification.leaseUntil": "" },
      },
    );
  }
}

export async function createOrderRequest(
  db: Db,
  input: unknown,
  clientAddress: string,
): Promise<OrderReceipt> {
  if (!checkoutAvailability().available)
    throw new OrderRequestError(checkoutAvailability().reason!, 503);
  const parsed = orderRequestSchema.parse(input);
  const organization = await storefrontOrganization(db);
  if (!organization)
    throw new OrderRequestError(
      "La boutique est momentanément indisponible.",
      503,
    );
  await ensureOrderIndexes(db);
  const normalized = {
    ...parsed,
    items: [...parsed.items].sort((a, b) =>
      a.productId.localeCompare(b.productId),
    ),
  };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");
  const id = createHash("sha256")
    .update(`${organization.id}:${parsed.idempotencyKey}`)
    .digest("hex");
  const collection = orderRequests(db);
  const previous = await collection.findOne({ _id: id });
  if (previous) {
    if (previous.fingerprint !== fingerprint)
      throw new OrderRequestError(
        "Cette demande a déjà été envoyée avec un contenu différent. Rechargez la page pour créer une nouvelle demande.",
        409,
      );
    if (previous.expiresAt <= new Date())
      throw new OrderRequestError(
        "Cette demande a expiré. Rechargez la page pour recommencer.",
        409,
      );
    return receipt(previous);
  }
  const privateSecret = serverConfig.sessionSecret;
  if (!privateSecret)
    throw new OrderRequestError(
      "La boutique est momentanément indisponible.",
      503,
    );
  const scope = (value: string) =>
    createHmac("sha256", privateSecret).update(value).digest("hex");
  await enforceRateLimit(
    db,
    organization.id,
    "order-request-ip",
    5,
    3600_000,
    scope(clientAddress),
  );
  await enforceRateLimit(
    db,
    organization.id,
    "order-request-phone",
    3,
    3600_000,
    scope(parsed.phone.replace(/\D/g, "")),
  );
  await enforceRateLimit(
    db,
    organization.id,
    "order-request-global",
    60,
    3600_000,
  );
  const catalogue = await getStorefrontCatalog(db);
  const quote = quoteOrderItems(normalized.items, catalogue.products);
  const now = new Date();
  const order: OrderRequestDocument = {
    _id: id,
    id: randomUUID(),
    organizationId: organization.id,
    reference: `BLD-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`,
    fingerprint,
    customer: {
      fullName: parsed.fullName,
      phone: parsed.phone,
      email: parsed.email,
      city: parsed.city,
      address: parsed.address,
      note: parsed.note,
    },
    ...quote,
    currency: "TND",
    status: "new",
    consentVersion: "2026-09-29",
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(
      now.getTime() + orderRequestRetentionDays() * 86400_000,
    ),
    notification: { status: "pending" },
  };
  try {
    await collection.insertOne(order);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === 11000
    ) {
      const winner = await collection.findOne({ _id: id });
      if (winner?.fingerprint === fingerprint) return receipt(winner);
      throw new OrderRequestError(
        "Une autre demande utilise déjà cette référence. Rechargez la page.",
        409,
      );
    }
    throw error;
  }
  await notifyOrderRequest(db, order);
  return receipt((await collection.findOne({ _id: id })) ?? order);
}

export async function listOrderRequests(db: Db, organizationId: string) {
  const orders = await orderRequests(db)
    .find({ organizationId, expiresAt: { $gt: new Date() } })
    .sort({ createdAt: -1 })
    .limit(100)
    .toArray();
  return orders.map(
    ({
      id,
      reference,
      customer,
      items,
      subtotalCents,
      currency,
      status,
      createdAt,
      expiresAt,
      notification,
    }) => ({
      id,
      reference,
      customer,
      items,
      subtotalCents,
      currency,
      status,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      notification: notification.status,
      canRetryNotification:
        notification.status !== "sent" &&
        (!notification.firstAttemptAt ||
          Date.now() - notification.firstAttemptAt.getTime() < 23 * 3600_000) &&
        (!notification.leaseUntil ||
          notification.leaseUntil.getTime() < Date.now()),
    }),
  );
}

export const updateOrderRequestSchema = z
  .object({ status: z.enum(["new", "contacted", "closed"]) })
  .strict();

export async function updateOrderRequest(
  db: Db,
  organizationId: string,
  id: string,
  status: OrderRequestStatus,
) {
  const result = await orderRequests(db).updateOne(
    { organizationId, id, expiresAt: { $gt: new Date() } },
    { $set: { status, updatedAt: new Date() } },
  );
  if (!result.matchedCount)
    throw new OrderRequestError("Cette demande n’est plus disponible.", 404);
}

export async function retryOrderNotification(
  db: Db,
  organizationId: string,
  id: string,
) {
  if (!orderEmailConfiguration())
    throw new OrderRequestError(
      "L’envoi des notifications n’est pas configuré.",
      503,
    );
  const order = await orderRequests(db).findOne({
    organizationId,
    id,
    expiresAt: { $gt: new Date() },
  });
  if (!order)
    throw new OrderRequestError("Cette demande n’est plus disponible.", 404);
  if (order.notification.status === "sent")
    return { notification: "sent" as const };
  if (
    order.notification.firstAttemptAt &&
    Date.now() - order.notification.firstAttemptAt.getTime() >= 23 * 3600_000
  )
    throw new OrderRequestError(
      "Vérifiez cette notification auprès de Resend avant tout renvoi manuel. Le délai de reprise automatique est dépassé.",
      409,
    );
  await enforceRateLimit(
    db,
    organizationId,
    "order-email-retry",
    5,
    3600_000,
    id,
  );
  await notifyOrderRequest(db, order);
  const current = await orderRequests(db).findOne({ _id: order._id });
  return { notification: current?.notification.status ?? "pending" };
}
