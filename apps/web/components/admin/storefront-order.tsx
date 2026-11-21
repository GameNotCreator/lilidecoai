"use client";

import Link from "next/link";
import { ArrowDown, ArrowUp, ImageOff } from "lucide-react";
import { useState } from "react";
import { adminApi } from "@/lib/admin-client";
import styles from "./storefront-order.module.css";

type Product = {
  id: string;
  name: string;
  collection?: string;
  photoUrl: string | null;
};

type Order = { revision: number; products: Product[] };
const endpoint = "/products/storefront-order";

export function StorefrontOrder({ initialOrder }: { initialOrder: Order }) {
  const [order, setOrder] = useState(initialOrder);
  const [products, setProducts] = useState(initialOrder.products);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const changed = order.products.some(
    (product, index) => product.id !== products[index]?.id,
  );

  async function reload() {
    setLoading(true);
    setNotice("");
    setError("");
    try {
      const result = await adminApi<Order>(endpoint);
      setOrder(result);
      setProducts(result.products);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Chargement impossible.",
      );
    } finally {
      setLoading(false);
    }
  }

  function move(from: number, to: number) {
    if (from === to || to < 0 || to >= products.length || loading || saving)
      return;
    const moved = products[from];
    if (!moved) return;
    const next = [...products];
    next.splice(from, 1);
    next.splice(to, 0, moved);
    setProducts(next);
    setNotice(`${moved.name}, position ${to + 1} sur ${next.length}.`);
  }

  async function save() {
    if (!changed || loading || saving) return;
    setSaving(true);
    setError("");
    try {
      const { revision } = await adminApi<{ revision: number }>(endpoint, {
        method: "PUT",
        body: JSON.stringify({
          ids: products.map(({ id }) => id),
          revision: order.revision,
        }),
      });
      setOrder({ revision, products });
      setNotice("L’ordre a été enregistré dans la boutique.");
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Enregistrement impossible.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <header className="bo-head">
        <div>
          <Link href="/admin/produits">Banque de produits</Link>
          <h1>Ordre de la boutique</h1>
          <p>
            Glissez les photos ou utilisez les flèches pour choisir l’ordre des
            articles dans la boutique.
          </p>
        </div>
        <div className="bo-head-actions">
          {error && (
            <button
              className="bo-button bo-button-ghost"
              type="button"
              disabled={loading || saving}
              onClick={() => void reload()}
            >
              Recharger l’ordre
            </button>
          )}
          <button
            className="bo-button bo-button-primary"
            type="button"
            disabled={!changed || loading || saving}
            onClick={() => void save()}
          >
            {saving ? "Enregistrement…" : "Enregistrer l’ordre"}
          </button>
        </div>
      </header>
      {error && (
        <p className="bo-alert bo-alert-error" role="alert">
          {error}
        </p>
      )}
      <p
        role="status"
        className={notice ? "bo-alert bo-alert-ok" : "store-sr-only"}
      >
        {notice}
      </p>
      {products.length ? (
        <ol className={styles.list}>
          {products.map((product, index) => (
            <li
              key={product.id}
              className={styles.product}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const id = event.dataTransfer.getData(
                  "application/x-lilideco-product",
                );
                const source = products.findIndex((item) => item.id === id);
                if (source !== -1) move(source, index);
              }}
            >
              <span className={styles.position} aria-hidden="true">
                {index + 1}
              </span>
              <div
                className={styles.photo}
                draggable={!saving}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData(
                    "application/x-lilideco-product",
                    product.id,
                  );
                }}
              >
                {product.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={product.photoUrl}
                    alt=""
                    width={56}
                    height={56}
                    loading="lazy"
                    draggable={false}
                  />
                ) : (
                  <ImageOff aria-hidden="true" size={20} />
                )}
              </div>
              <div className={styles.name}>
                <strong>{product.name}</strong>
                {product.collection && <small>{product.collection}</small>}
              </div>
              <div className={styles.controls}>
                <button
                  className="bo-icon-button"
                  type="button"
                  aria-label={`Monter ${product.name}`}
                  aria-disabled={index === 0 || saving}
                  onClick={() => move(index, index - 1)}
                >
                  <ArrowUp size={18} aria-hidden="true" />
                </button>
                <button
                  className="bo-icon-button"
                  type="button"
                  aria-label={`Descendre ${product.name}`}
                  aria-disabled={index === products.length - 1 || saving}
                  onClick={() => move(index, index + 1)}
                >
                  <ArrowDown size={18} aria-hidden="true" />
                </button>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p>Aucun produit publié dans la boutique.</p>
      )}
    </>
  );
}
