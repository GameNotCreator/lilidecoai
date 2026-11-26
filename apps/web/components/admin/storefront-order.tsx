"use client";

import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowDown,
  ArrowUp,
  GripVertical,
  Monitor,
  Smartphone,
} from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { ProductImage } from "@/components/storefront/storefront-catalog";
import { adminApi } from "@/lib/admin-client";
import type { readStorefrontProductOrder } from "@/lib/server/storefront";
import { productPrice } from "@/lib/storefront";
import styles from "./storefront-order.module.css";

type Order = Awaited<ReturnType<typeof readStorefrontProductOrder>>;
type Scope = "products" | "categories";
const endpoint = "/products/storefront-order";

export function StorefrontOrder({ initialOrder }: { initialOrder: Order }) {
  const [saved, setSaved] = useState(initialOrder);
  const [products, setProducts] = useState(initialOrder.products);
  const [categories, setCategories] = useState(initialOrder.categories);
  const [scope, setScope] = useState<Scope>("products");
  const [columns, setColumns] = useState<2 | 3>(3);
  const [busy, setBusy] = useState<"load" | "save" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const editingProducts = scope === "products";
  const items = editingProducts ? products : categories;
  const savedItems = editingProducts ? saved.products : saved.categories;
  const changed = items.some(({ id }, index) => id !== savedItems[index]?.id);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  async function reload() {
    setBusy("load");
    setNotice("");
    setError("");
    try {
      const result = await adminApi<Order>(endpoint);
      if (editingProducts) {
        setSaved((previous) => ({
          ...previous,
          revision: result.revision,
          products: result.products,
        }));
        setProducts(result.products);
      } else {
        setSaved((previous) => ({
          ...previous,
          categoryRevision: result.categoryRevision,
          categories: result.categories,
        }));
        setCategories(result.categories);
      }
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Chargement impossible.",
      );
    } finally {
      setBusy(null);
    }
  }

  function move(from: number, to: number) {
    const moved = items[from];
    if (busy || !moved || to < 0 || to >= items.length || from === to) return;
    if (editingProducts) setProducts(arrayMove(products, from, to));
    else setCategories(arrayMove(categories, from, to));
    setNotice(
      `${"name" in moved ? moved.name : moved.label}, position ${to + 1} sur ${items.length}.`,
    );
  }

  async function save() {
    if (!changed || busy) return;
    setBusy("save");
    setError("");
    try {
      const { revision } = await adminApi<{ revision: number }>(endpoint, {
        method: "PUT",
        body: JSON.stringify({
          scope,
          ids: items.map(({ id }) => id),
          revision: editingProducts ? saved.revision : saved.categoryRevision,
        }),
      });
      setSaved((previous) =>
        editingProducts
          ? { ...previous, revision, products }
          : { ...previous, categoryRevision: revision, categories },
      );
      setNotice(
        editingProducts
          ? "L’ordre a été enregistré dans la boutique."
          : "L’ordre des catégories a été enregistré.",
      );
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Enregistrement impossible.",
      );
    } finally {
      setBusy(null);
    }
  }

  function showScope(next: Scope) {
    if (next === scope) return;
    setScope(next);
    setError("");
    setNotice("");
  }

  const ids = items.map(({ id }) => id);
  return (
    <>
      <header className="bo-head">
        <div>
          <Link href="/admin/produits">Banque de produits</Link>
          <h1>Ordre du catalogue</h1>
          <p>
            Glissez les cartes avec leur poignée ou réordonnez-les avec les
            flèches.
          </p>
        </div>
        <div className="bo-head-actions">
          {error && (
            <button
              className="bo-button bo-button-ghost"
              type="button"
              disabled={!!busy}
              onClick={() => void reload()}
            >
              Recharger l’ordre
            </button>
          )}
          <button
            className="bo-button bo-button-primary"
            type="button"
            disabled={!changed || !!busy}
            onClick={() => void save()}
          >
            {busy === "save" ? "Enregistrement…" : "Enregistrer l’ordre"}
          </button>
        </div>
      </header>

      <div
        className={`bo-tabs ${styles.sections}`}
        role="group"
        aria-label="Éléments à réorganiser"
      >
        <button
          type="button"
          className={editingProducts ? "active" : ""}
          aria-pressed={editingProducts}
          disabled={!!busy}
          onClick={() => showScope("products")}
        >
          Produits
        </button>
        <button
          type="button"
          className={editingProducts ? "" : "active"}
          aria-pressed={!editingProducts}
          disabled={!!busy}
          onClick={() => showScope("categories")}
        >
          Catégories
        </button>
      </div>

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

      <section
        className={styles.preview}
        aria-labelledby="storefront-order-preview-title"
      >
        <div className={styles.previewHeader}>
          <div>
            <h2 id="storefront-order-preview-title">
              {editingProducts
                ? "Aperçu de la boutique"
                : "Ordre des catégories"}
            </h2>
            <p>
              {editingProducts
                ? "Catalogue sans filtre"
                : "Liens de catégories sur l’accueil"}
            </p>
          </div>
          {editingProducts && (
            <div
              className="bo-tabs"
              role="group"
              aria-label="Format de l’aperçu"
            >
              <button
                type="button"
                className={columns === 3 ? "active" : ""}
                aria-pressed={columns === 3}
                onClick={() => setColumns(3)}
              >
                <Monitor size={16} aria-hidden="true" /> PC · 3 colonnes
              </button>
              <button
                type="button"
                className={columns === 2 ? "active" : ""}
                aria-pressed={columns === 2}
                onClick={() => setColumns(2)}
              >
                <Smartphone size={16} aria-hidden="true" /> Mobile · 2 colonnes
              </button>
            </div>
          )}
        </div>

        {!editingProducts && (
          <div
            className={styles.categoryLinks}
            role="group"
            aria-label="Aperçu des catégories visibles"
          >
            {categories.some(({ productCount }) => productCount > 0) ? (
              <ul>
                {categories
                  .filter(({ productCount }) => productCount > 0)
                  .map(({ id, label }) => (
                    <li key={id}>{label}</li>
                  ))}
              </ul>
            ) : (
              <p>
                Les catégories apparaissent ici dès leur premier produit publié.
              </p>
            )}
          </div>
        )}

        {items.length ? (
          <DndContext
            id={`storefront-order-${scope}`}
            sensors={sensors}
            collisionDetection={closestCenter}
            accessibility={{
              screenReaderInstructions: {
                draggable:
                  "Utilisez les boutons Monter et Descendre pour changer la position au clavier.",
              },
              announcements: {
                onDragStart: () => "Carte saisie.",
                onDragOver: ({ over }) =>
                  over
                    ? `Position ${ids.indexOf(String(over.id)) + 1}.`
                    : "En dehors de la liste.",
                onDragEnd: ({ over }) =>
                  over ? "Carte déposée." : "Déplacement annulé.",
                onDragCancel: () => "Déplacement annulé.",
              },
            }}
            onDragEnd={({ active, over }) => {
              if (over)
                move(
                  ids.indexOf(String(active.id)),
                  ids.indexOf(String(over.id)),
                );
            }}
          >
            <SortableContext
              items={ids}
              strategy={
                editingProducts
                  ? rectSortingStrategy
                  : verticalListSortingStrategy
              }
            >
              <ol
                role="list"
                className={
                  editingProducts ? styles.productGrid : styles.categoryList
                }
                data-columns={editingProducts ? columns : undefined}
                aria-label={
                  editingProducts
                    ? "Produits dans l’ordre de la boutique"
                    : "Catégories dans l’ordre de la boutique"
                }
              >
                {items.map((item, index) => (
                  <SortableCard
                    key={item.id}
                    id={item.id}
                    label={"name" in item ? item.name : item.label}
                    index={index}
                    count={items.length}
                    category={!editingProducts}
                    disabled={!!busy}
                    onMove={move}
                  >
                    {"name" in item ? (
                      <>
                        <div className={styles.photo}>
                          <ProductImage product={item} />
                          {item.stock === 0 && (
                            <span className="store-stock-badge">Épuisé</span>
                          )}
                        </div>
                        <div className={styles.copy}>
                          {(item.collection || item.categoryLabel) && (
                            <small>
                              {item.collection || item.categoryLabel}
                            </small>
                          )}
                          <strong>{item.name}</strong>
                          <span className={styles.price}>
                            {productPrice(item)}
                          </span>
                        </div>
                      </>
                    ) : (
                      <div className={styles.copy}>
                        <strong>{item.label}</strong>
                        <small>
                          {item.productCount} produit
                          {item.productCount === 1 ? "" : "s"} publié
                          {item.productCount === 1 ? "" : "s"}
                        </small>
                      </div>
                    )}
                  </SortableCard>
                ))}
              </ol>
            </SortableContext>
          </DndContext>
        ) : (
          <p className={styles.empty}>Aucun produit publié dans la boutique.</p>
        )}
      </section>
    </>
  );
}

function SortableCard({
  id,
  label,
  index,
  count,
  category,
  disabled,
  onMove,
  children,
}: {
  id: string;
  label: string;
  index: number;
  count: number;
  category: boolean;
  disabled: boolean;
  onMove: (from: number, to: number) => void;
  children: ReactNode;
}) {
  const {
    attributes,
    listeners,
    isDragging,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
  } = useSortable({ id, disabled });

  return (
    <li
      ref={setNodeRef}
      className={category ? styles.categoryCard : styles.productCard}
      data-dragging={isDragging || undefined}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <span className={styles.position} aria-hidden="true">
        {index + 1}
      </span>
      {children}
      <button
        {...attributes}
        {...listeners}
        ref={setActivatorNodeRef}
        className={`bo-icon-button ${styles.handle}`}
        type="button"
        tabIndex={-1}
        aria-label={`Déplacer ${label}`}
        disabled={disabled}
      >
        <GripVertical size={19} aria-hidden="true" />
      </button>
      <div className={styles.controls}>
        <button
          className="bo-icon-button"
          type="button"
          aria-label={`Monter ${label}`}
          aria-disabled={index === 0 || disabled}
          onClick={() => onMove(index, index - 1)}
        >
          <ArrowUp size={17} aria-hidden="true" />
        </button>
        <button
          className="bo-icon-button"
          type="button"
          aria-label={`Descendre ${label}`}
          aria-disabled={index === count - 1 || disabled}
          onClick={() => onMove(index, index + 1)}
        >
          <ArrowDown size={17} aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}
