"use client";

import { useEffect, useState } from "react";
import { orderStatusLabels, type OrderRequestStatus } from "@/lib/checkout";
import { productPrice } from "@/lib/storefront";
import type { listOrderRequests } from "@/lib/server/order-requests";

type Order = Awaited<ReturnType<typeof listOrderRequests>>[number];

export function AdminOrderRequests() {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    fetch("/api/admin/orders", {
      cache: "no-store",
      credentials: "same-origin",
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok)
          throw new Error(
            body.detail || "Les demandes ne peuvent pas être chargées.",
          );
        if (active) {
          setOrders(body.orders);
          setError("");
        }
      })
      .catch((reason: unknown) => {
        if (active)
          setError(
            reason instanceof Error ? reason.message : "Chargement impossible.",
          );
      });
    return () => {
      active = false;
    };
  }, [revision]);

  async function update(order: Order, status: OrderRequestStatus) {
    setSaving(order.id);
    setError("");
    try {
      const response = await fetch(`/api/admin/orders/${order.id}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.detail || "Mise à jour impossible.");
      setOrders(
        (current) =>
          current?.map((row) =>
            row.id === order.id ? { ...row, status } : row,
          ) ?? null,
      );
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Mise à jour impossible.",
      );
    } finally {
      setSaving(null);
    }
  }

  async function retryNotification(order: Order) {
    setSaving(order.id);
    setError("");
    try {
      const response = await fetch(
        `/api/admin/orders/${order.id}/notification`,
        { method: "POST", credentials: "same-origin" },
      );
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          result.detail || "La notification n’a pas pu être relancée.",
        );
      if (result.notification !== "sent")
        setError(
          "L’envoi de l’email n’est pas confirmé. La demande reste enregistrée.",
        );
      setRevision((value) => value + 1);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Reprise impossible.",
      );
    } finally {
      setSaving(null);
    }
  }

  return (
    <section className="min-w-0 space-y-6 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold">Demandes de commande</h1>
          <p className="mt-2 text-base-content/70">
            Les 100 demandes les plus récentes. À confirmer avec le client ;
            aucun paiement ni stock réservé.
          </p>
        </div>
        <button
          type="button"
          className="btn min-h-11"
          onClick={() => setRevision((value) => value + 1)}
        >
          Actualiser
        </button>
      </div>
      {error && (
        <p role="alert" className="text-error">
          {error}
        </p>
      )}
      {!orders && !error && <p role="status">Chargement des demandes…</p>}
      {orders?.length === 0 && <p>Aucune demande pour le moment.</p>}
      {orders?.map((order) => (
        <article
          className="min-w-0 border border-base-300 bg-base-100 p-5 sm:p-7"
          key={order.id}
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-xl font-semibold">{order.reference}</h2>
              <p className="mt-1 text-sm">
                {new Intl.DateTimeFormat("fr-FR", {
                  dateStyle: "medium",
                  timeStyle: "short",
                }).format(new Date(order.createdAt))}
              </p>
            </div>
            <div className="flex min-w-0 flex-wrap gap-2">
              {Object.entries(orderStatusLabels).map(([status, label]) => (
                <button
                  key={status}
                  type="button"
                  className="btn btn-sm min-h-11"
                  disabled={saving === order.id}
                  aria-pressed={order.status === status}
                  onClick={() => update(order, status as OrderRequestStatus)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-6 grid min-w-0 gap-6 md:grid-cols-2">
            <div className="min-w-0 [overflow-wrap:anywhere]">
              <h3 className="font-semibold">Client</h3>
              <p>{order.customer.fullName}</p>
              <p>
                <a
                  className="link"
                  href={`tel:${order.customer.phone.replace(/[^+\d]/g, "")}`}
                >
                  {order.customer.phone}
                </a>
              </p>
              {order.customer.email && (
                <p>
                  <a
                    className="link break-all"
                    href={`mailto:${order.customer.email}`}
                  >
                    {order.customer.email}
                  </a>
                </p>
              )}
              <p>{order.customer.city}</p>
              {order.customer.address && (
                <p className="whitespace-pre-wrap">{order.customer.address}</p>
              )}
              {order.customer.note && (
                <p className="mt-3 whitespace-pre-wrap">
                  {order.customer.note}
                </p>
              )}
            </div>
            <div className="min-w-0 [overflow-wrap:anywhere]">
              <h3 className="font-semibold">Sélection</h3>
              <ul>
                {order.items.map((item) => (
                  <li className="mt-2" key={item.productId}>
                    {item.quantity} × {item.name} —{" "}
                    {productPrice(
                      { priceCents: item.unitPriceCents, currency: "TND" },
                      item.quantity,
                    )}
                    {item.stockToConfirm ? " (disponibilité à confirmer)" : ""}
                  </li>
                ))}
              </ul>
              <p className="mt-4 font-semibold">
                Articles :{" "}
                {productPrice({
                  priceCents: order.subtotalCents,
                  currency: "TND",
                })}
              </p>
              <p className="mt-2 text-sm">
                Livraison et modalités à confirmer.
              </p>
            </div>
          </div>
          <p className="mt-5 border-t border-base-300 pt-4 text-sm">
            Notification email :{" "}
            {order.notification === "sent"
              ? "acceptée par Resend"
              : order.notification === "failed"
                ? "échec — la demande reste consultable ici"
                : "en attente"}
            . Expiration prévue :{" "}
            {new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium" }).format(
              new Date(order.expiresAt),
            )}
            .
          </p>
          {order.canRetryNotification && (
            <button
              className="btn mt-3 min-h-11 max-w-full whitespace-normal"
              type="button"
              disabled={saving === order.id}
              onClick={() => retryNotification(order)}
            >
              Réessayer la notification
            </button>
          )}
          {!order.canRetryNotification && order.notification === "failed" && (
            <p className="mt-2 text-sm">
              Vérifiez l’état de cet email dans Resend avant tout renvoi manuel.
            </p>
          )}
        </article>
      ))}
    </section>
  );
}
