import "server-only";
import { z } from "zod";
import { productPrice } from "../storefront";
import type { OrderRequestDocument } from "./order-requests";

export function orderEmailConfiguration() {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESEND_FROM_EMAIL?.trim();
  const to = process.env.ORDER_EMAIL_TO?.trim();
  const senderEmail = from?.match(/<([^<>]+)>$/)?.[1] ?? from;
  if (
    !apiKey ||
    !from ||
    /[\r\n]/.test(from) ||
    !z.email().safeParse(senderEmail).success ||
    !z.email().safeParse(to).success
  )
    return null;
  return { apiKey, from, to: to! };
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );

export function buildOrderNotification(order: OrderRequestDocument) {
  const lines = order.items.map(
    (item) =>
      `${item.quantity} × ${item.name} — ${productPrice({ priceCents: item.unitPriceCents, currency: "TND" }, item.quantity)}`,
  );
  const summary =
    order.subtotalCents === null
      ? "À confirmer"
      : productPrice({ priceCents: order.subtotalCents, currency: "TND" });
  const text = [
    `Nouvelle demande ByLiliDeco — ${order.reference}`,
    "À confirmer avec le client. Aucun paiement ni réservation de stock.",
    "",
    `Nom : ${order.customer.fullName}`,
    `Téléphone : ${order.customer.phone}`,
    `Ville : ${order.customer.city}`,
    `Email : ${order.customer.email || "Non renseigné"}`,
    `Adresse : ${order.customer.address || "À préciser"}`,
    "",
    ...lines,
    "",
    `Montant indicatif des articles : ${summary}`,
    "Disponibilité, livraison, frais éventuels et mode de paiement à confirmer.",
    ...(order.customer.note
      ? ["", `Commentaire : ${order.customer.note}`]
      : []),
  ].join("\n");
  return {
    subject: `ByLiliDeco — Demande ${order.reference}`,
    text,
    html: `<div style="font-family:Arial,sans-serif;color:#171717;line-height:1.6;max-width:680px"><h1 style="font-size:24px">Nouvelle demande ByLiliDeco</h1><p style="white-space:pre-wrap">${escapeHtml(text)}</p></div>`,
  };
}

export async function sendOrderNotification(
  order: OrderRequestDocument,
): Promise<string> {
  const config = orderEmailConfiguration();
  if (!config) throw new Error("order-email-not-configured");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `bylilideco-order/${order.id}`,
    },
    body: JSON.stringify({
      from: config.from,
      to: [config.to],
      ...buildOrderNotification(order),
      ...(order.customer.email ? { reply_to: order.customer.email } : {}),
    }),
    signal: AbortSignal.timeout(12_000),
    redirect: "error",
  });
  // Do not persist or log provider bodies: they can contain personal data.
  if (!response.ok) throw new Error("order-email-provider-error");
  const body = (await response.json()) as { id?: unknown };
  if (typeof body.id !== "string" || !body.id)
    throw new Error("order-email-invalid-response");
  return body.id;
}
