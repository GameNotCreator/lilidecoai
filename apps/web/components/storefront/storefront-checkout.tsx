"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, Check, Send } from "lucide-react";
import {
  orderRequestSchema,
  type CheckoutAvailability,
  type OrderReceipt,
} from "@/lib/checkout";
import { useStorefrontCart } from "@/lib/storefront-cart";
import { productPrice } from "@/lib/storefront";
import { storeIdentity } from "@/lib/site";
import { useStorefrontCatalog } from "./catalog-state";
import { CatalogError, CatalogLoading } from "./storefront-catalog";

const fields = [
  {
    name: "fullName",
    label: "Nom complet",
    autocomplete: "name",
    type: "text",
    max: 100,
    required: true,
  },
  {
    name: "phone",
    label: "Téléphone",
    autocomplete: "tel",
    type: "tel",
    max: 30,
    required: true,
  },
  {
    name: "city",
    label: "Ville",
    autocomplete: "address-level2",
    type: "text",
    max: 100,
    required: true,
  },
  {
    name: "email",
    label: "Email (facultatif)",
    autocomplete: "email",
    type: "email",
    max: 254,
    required: false,
  },
  {
    name: "address",
    label: "Adresse (facultatif)",
    autocomplete: "street-address",
    type: "text",
    max: 400,
    required: false,
  },
] as const;

export function StorefrontCheckout({
  availability,
}: {
  availability: CheckoutAvailability;
}) {
  const cart = useStorefrontCart();
  const { catalog, error: catalogueError, retry } = useStorefrontCatalog();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [receipt, setReceipt] = useState<OrderReceipt | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const successRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (receipt) successRef.current?.focus();
  }, [receipt]);
  const submission = useRef<{ fingerprint: string; key: string } | null>(null);
  const items = cart.lines.map((line) => ({
    ...line,
    product: catalog?.products.find((product) => product.id === line.productId),
  }));
  const pricesKnown = items.every(
    (item) =>
      item.product?.priceCents !== null && item.product?.currency === "TND",
  );
  const total = items.reduce(
    (sum, item) => sum + (item.product?.priceCents ?? 0) * item.quantity,
    0,
  );
  const invalidSelection = items.some(
    (item) =>
      !item.product ||
      (item.product.stock !== null && item.quantity > item.product.stock),
  );

  function report(message: string, errors: Record<string, string> = {}) {
    setError(message);
    setFieldErrors(errors);
    requestAnimationFrame(() => errorRef.current?.focus());
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending || !availability.available) return;
    const data = new FormData(event.currentTarget);
    const payload = {
      ...Object.fromEntries(
        fields.map((field) => [
          field.name,
          String(data.get(field.name) ?? "").trim(),
        ]),
      ),
      note: String(data.get("note") ?? "").trim(),
      consent: data.get("consent") === "on",
      website: String(data.get("website") ?? ""),
      items: cart.lines,
    };
    const fingerprint = JSON.stringify(payload);
    if (submission.current?.fingerprint !== fingerprint) {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6]! & 15) | 64;
      bytes[8] = (bytes[8]! & 63) | 128;
      const hex = Array.from(bytes, (value) =>
        value.toString(16).padStart(2, "0"),
      ).join("");
      submission.current = {
        fingerprint,
        key: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
      };
    }
    const parsed = orderRequestSchema.safeParse({
      ...payload,
      idempotencyKey: submission.current.key,
    });
    if (!parsed.success) {
      report(
        "Vérifiez les champs indiqués avant de continuer.",
        Object.fromEntries(
          parsed.error.issues.map((issue) => [
            String(issue.path[0]),
            issue.message,
          ]),
        ),
      );
      return;
    }
    setSending(true);
    setError("");
    setFieldErrors({});
    try {
      const response = await fetch("/api/storefront/orders", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const result = (await response.json()) as OrderReceipt & {
        detail?: string;
        fields?: Record<string, string>;
      };
      if (!response.ok || !result.recorded || !result.reference) {
        report(
          result.detail ?? "La demande n’a pas abouti. Réessayez.",
          result.fields,
        );
        return;
      }
      setReceipt(result);
    } catch {
      report(
        "La connexion a été interrompue. Réessayez sans fermer cette page : votre demande ne sera pas créée en double.",
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <main className="storefront store-page">
      <div className="store-shell">
        <Link href="/panier" className="store-back">
          <ArrowLeft size={16} /> Revenir à mon panier
        </Link>
        <div className="store-page-heading">
          <p className="store-kicker">VOTRE SÉLECTION, LA SUITE</p>
          <h1>Parlons de vos envies.</h1>
          <p>
            Transmettez votre sélection à ByLiliDeco. Nous vous recontacterons
            pour préparer la suite.
          </p>
        </div>
        {receipt ? (
          <section
            className="mx-auto max-w-2xl border border-base-300 bg-base-200 p-6 sm:p-10"
            role="status"
          >
            <Check size={32} aria-hidden="true" />
            <h2
              ref={successRef}
              tabIndex={-1}
              className="mt-4 text-2xl font-semibold"
            >
              Votre demande est enregistrée.
            </h2>
            <p className="mt-3">
              Référence : <strong>{receipt.reference}</strong>
            </p>
            <p className="mt-3">
              ByLiliDeco vous recontactera pour confirmer les articles, le
              montant final et les modalités. Aucun paiement n’a été effectué et
              les articles ne sont pas encore réservés.
            </p>
            <p className="mt-3">Votre sélection reste dans votre panier.</p>
            <Link className="btn mt-6" href="/#collection">
              Continuer ma découverte
            </Link>
          </section>
        ) : catalogueError ? (
          <CatalogError error={catalogueError} retry={retry} />
        ) : !catalog || !cart.ready ? (
          <CatalogLoading />
        ) : !cart.lines.length ? (
          <div className="store-empty">
            <h2>Votre panier est encore vide.</h2>
            <Link href="/#collection" className="btn mt-4">
              Découvrir la collection
            </Link>
          </div>
        ) : (
          <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
            <form
              onSubmit={submit}
              noValidate
              className="min-w-0 border border-base-300 p-5 sm:p-8"
            >
              <h2 className="text-2xl font-semibold">Vos coordonnées</h2>
              <p className="mt-2 text-base-content/70">
                Les champs nom, téléphone et ville sont nécessaires pour vous
                recontacter.
              </p>
              {error && (
                <div
                  ref={errorRef}
                  tabIndex={-1}
                  role="alert"
                  className="mt-6 border border-error p-4 text-error"
                >
                  <p>{error}</p>
                  {Object.keys(fieldErrors).length > 0 && (
                    <ul className="mt-2 list-disc pl-5">
                      {Object.entries(fieldErrors).map(([field, message]) => (
                        <li key={field}>
                          {[
                            ...fields.map((item) => item.name),
                            "note",
                            "consent",
                            "items",
                          ].includes(field) ? (
                            <a className="link" href={`#checkout-${field}`}>
                              {message}
                            </a>
                          ) : (
                            message
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {!availability.available && (
                <div
                  className="mt-6 border border-base-300 bg-base-200 p-4"
                  role="status"
                >
                  <p>{availability.reason}</p>
                  <a
                    className="link mt-2 inline-block py-2"
                    href={`tel:${storeIdentity.telephone}`}
                  >
                    Appeler ByLiliDeco au +216 22 300 600
                  </a>
                </div>
              )}
              <fieldset
                disabled={sending || !availability.available}
                className="mt-6 grid min-w-0 gap-5 sm:grid-cols-2"
              >
                <legend className="sr-only">Coordonnées pour la demande</legend>
                {fields.map((field) => (
                  <div
                    key={field.name}
                    className={`min-w-0 [overflow-wrap:anywhere] ${field.name === "address" ? "sm:col-span-2" : ""}`}
                  >
                    <label
                      htmlFor={`checkout-${field.name}`}
                      className="mb-2 block font-medium"
                    >
                      {field.label}
                    </label>
                    <input
                      id={`checkout-${field.name}`}
                      name={field.name}
                      type={field.type}
                      autoComplete={field.autocomplete}
                      maxLength={field.max}
                      required={field.required}
                      className="input min-h-11 w-full min-w-0 text-base"
                      aria-invalid={Boolean(fieldErrors[field.name])}
                      aria-describedby={
                        fieldErrors[field.name]
                          ? `checkout-error-${field.name}`
                          : undefined
                      }
                    />
                    {fieldErrors[field.name] && (
                      <p
                        id={`checkout-error-${field.name}`}
                        className="mt-2 text-sm text-error"
                      >
                        {fieldErrors[field.name]}
                      </p>
                    )}
                  </div>
                ))}
                <div className="min-w-0 [overflow-wrap:anywhere] sm:col-span-2">
                  <label
                    className="mb-2 block font-medium"
                    htmlFor="checkout-note"
                  >
                    Une précision ? (facultatif)
                  </label>
                  <input
                    className="input min-h-11 w-full min-w-0 text-base"
                    id="checkout-note"
                    name="note"
                    maxLength={1000}
                    aria-invalid={Boolean(fieldErrors.note)}
                    aria-describedby={
                      fieldErrors.note ? "checkout-error-note" : undefined
                    }
                  />
                  {fieldErrors.note && (
                    <p
                      id="checkout-error-note"
                      className="mt-2 text-sm text-error"
                    >
                      {fieldErrors.note}
                    </p>
                  )}
                </div>
                <div hidden aria-hidden="true">
                  <label htmlFor="checkout-website">Site web</label>
                  <input
                    id="checkout-website"
                    name="website"
                    tabIndex={-1}
                    autoComplete="off"
                  />
                </div>
                <div className="min-w-0 [overflow-wrap:anywhere] sm:col-span-2">
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      id="checkout-consent"
                      name="consent"
                      required
                      className="mt-1 h-5 w-5 shrink-0 accent-primary"
                      aria-invalid={Boolean(fieldErrors.consent)}
                      aria-describedby={
                        fieldErrors.consent
                          ? "checkout-error-consent"
                          : undefined
                      }
                    />
                    <label htmlFor="checkout-consent" className="leading-6">
                      J’ai lu les{" "}
                      <Link
                        className="link"
                        href="/terms"
                        target="_blank"
                        rel="noreferrer"
                      >
                        conditions d’utilisation
                      </Link>{" "}
                      et la{" "}
                      <Link
                        className="link"
                        href="/privacy"
                        target="_blank"
                        rel="noreferrer"
                      >
                        politique de confidentialité
                      </Link>
                      .
                    </label>
                  </div>
                  {fieldErrors.consent && (
                    <p
                      id="checkout-error-consent"
                      className="mt-2 text-sm text-error"
                    >
                      {fieldErrors.consent}
                    </p>
                  )}
                </div>
                <button
                  className="btn btn-primary min-h-12 w-full sm:col-span-2"
                  type="submit"
                  disabled={
                    sending || invalidSelection || !availability.available
                  }
                >
                  <Send size={17} aria-hidden="true" />
                  {sending
                    ? "Enregistrement en cours…"
                    : "Transmettre ma demande"}
                </button>
              </fieldset>
              <p className="mt-4 text-sm leading-6 text-base-content/70">
                Vos coordonnées servent uniquement au traitement de cette
                demande. Ce site ne les enregistre pas dans votre navigateur.
              </p>
            </form>
            <aside
              className="min-w-0 border border-base-300 bg-base-200 p-5 sm:p-8"
              aria-label="Récapitulatif de votre demande"
              id="checkout-items"
              tabIndex={-1}
            >
              <h2 className="text-2xl font-semibold">Votre sélection</h2>
              <ul className="mt-5 divide-y divide-base-300">
                {items.map(({ productId, product, quantity }) => (
                  <li
                    key={productId}
                    className="flex min-w-0 flex-col items-start justify-between gap-2 py-4 sm:flex-row sm:gap-4"
                  >
                    <div className="min-w-0 [overflow-wrap:anywhere]">
                      <p className="font-medium">
                        {product?.name ?? "Article indisponible"}
                      </p>
                      <p className="mt-1 text-sm text-base-content/70">
                        Quantité : {quantity}
                        {product?.stock === null
                          ? " · Disponibilité à confirmer"
                          : ""}
                      </p>
                    </div>
                    <strong className="max-w-full text-sm [overflow-wrap:anywhere] sm:shrink-0">
                      {product ? productPrice(product, quantity) : "—"}
                    </strong>
                  </li>
                ))}
              </ul>
              <div className="mt-4 flex min-w-0 flex-col justify-between gap-2 border-t border-base-300 pt-5 [overflow-wrap:anywhere] sm:flex-row sm:gap-3">
                <span>Montant indicatif des articles</span>
                <strong>
                  {pricesKnown
                    ? productPrice({ priceCents: total, currency: "TND" })
                    : "À confirmer"}
                </strong>
              </div>
              <p className="mt-5 leading-7">
                La boutique vous recontactera pour confirmer la disponibilité,
                le montant final, la livraison et le mode de paiement.
              </p>
              <p className="mt-3 text-sm leading-6 text-base-content/70">
                Aucun paiement ni réservation de stock n’est effectué ici. Les
                frais éventuels de livraison seront précisés avant votre
                confirmation.
              </p>
              {invalidSelection && (
                <p className="mt-5 text-error" role="alert">
                  Votre sélection a changé.{" "}
                  <Link href="/panier" className="link">
                    Actualisez votre panier
                  </Link>{" "}
                  avant de continuer.
                </p>
              )}
            </aside>
          </div>
        )}
      </div>
    </main>
  );
}
