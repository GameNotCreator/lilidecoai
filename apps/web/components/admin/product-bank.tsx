"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Archive,
  ArchiveRestore,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  EyeOff,
  ImageOff,
  LoaderCircle,
  Pencil,
  Pin,
  Search,
  Trash2,
} from "lucide-react";

import {
  adminApi,
  formatDate,
  formatPrice,
  objectTypeLabels,
  placementLabels,
  statusLabels,
  type AdminProduct,
  type AdminProductList,
} from "@/lib/admin-client";

type BulkAction =
  | "publish"
  | "unpublish"
  | "archive"
  | "restore"
  | "persist"
  | "delete";

const statusTabs = [
  { value: "all", label: "Tous" },
  { value: "ready", label: "Publiés" },
  { value: "draft", label: "Brouillons" },
  { value: "processing", label: "À préparer" },
  { value: "archived", label: "Archivés" },
] as const;

export function ProductBank() {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [objectType, setObjectType] = useState("all");
  const [placementType, setPlacementType] = useState("all");
  const [sort, setSort] = useState("updated");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AdminProductList | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [loadedQuery, setLoadedQuery] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQ(search.trim());
      setPage(1);
    }, 280);
    return () => window.clearTimeout(timer);
  }, [search]);

  const query = useMemo(() => {
    const params = new URLSearchParams({
      status,
      objectType,
      placementType,
      sort,
      page: String(page),
      pageSize: "24",
    });
    if (q) params.set("q", q);
    return params.toString();
  }, [objectType, page, placementType, q, sort, status]);

  useEffect(() => {
    let cancelled = false;
    adminApi<AdminProductList>(`/products?${query}`)
      .then((payload) => {
        if (cancelled) return;
        setData(payload);
        setSelected((current) =>
          current.filter((id) => payload.items.some((item) => item.id === id)),
        );
        setError("");
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(
          reason instanceof Error ? reason.message : "Chargement impossible",
        );
      })
      .finally(() => {
        if (!cancelled) setLoadedQuery(query);
      });
    return () => {
      cancelled = true;
    };
  }, [query, reloadToken]);

  const loading = loadedQuery !== query;

  async function run(label: string, task: () => Promise<unknown>) {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await task();
      setReloadToken((token) => token + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Action impossible");
    } finally {
      setBusy("");
    }
  }

  function act(product: AdminProduct, action: string) {
    return run(`${product.id}:${action}`, () =>
      adminApi(`/products/${product.id}/actions`, {
        method: "POST",
        body: JSON.stringify({ action }),
      }),
    );
  }

  function remove(product: AdminProduct) {
    const confirmed = window.confirm(
      `Supprimer définitivement « ${product.name} » ainsi que ses images ? Cette action est irréversible.`,
    );
    if (!confirmed) return;
    return run(`${product.id}:delete`, () =>
      adminApi(`/products/${product.id}?permanent=true`, { method: "DELETE" }),
    );
  }

  function bulk(action: BulkAction) {
    if (selected.length === 0) return;
    if (action === "delete") {
      const confirmed = window.confirm(
        `Supprimer définitivement ${selected.length} produit(s) et leurs images ?`,
      );
      if (!confirmed) return;
    }
    return run(`bulk:${action}`, async () => {
      const result = await adminApi<{
        succeeded: string[];
        failed: Array<{ id: string; detail: string }>;
      }>("/products/bulk", {
        method: "POST",
        body: JSON.stringify({ ids: selected, action }),
      });
      setSelected([]);
      setNotice(
        `${result.succeeded.length} produit(s) traité(s)` +
          (result.failed.length ? ` · ${result.failed.length} en échec` : ""),
      );
      if (result.failed[0]) setError(result.failed[0].detail);
    });
  }

  const items = data?.items ?? [];
  const allSelected = items.length > 0 && selected.length === items.length;

  return (
    <>
      <header className="bo-head">
        <div>
          <span className="bo-eyebrow">Catalogue</span>
          <h1>Banque de produits.</h1>
          <p>
            Créez, complétez et publiez les fiches utilisées par le visualiseur
            et le widget marchand.
          </p>
        </div>
        <div className="bo-head-actions">
          <a
            className="bo-button bo-button-ghost"
            href={`/api/admin/products/export?${query}`}
          >
            <Download size={16} /> Export CSV
          </a>
          <Link className="bo-button bo-button-primary" href="/admin/produits/nouveau">
            Ajouter un produit
          </Link>
        </div>
      </header>

      {error && <div className="bo-alert bo-alert-error">{error}</div>}
      {notice && <div className="bo-alert bo-alert-ok">{notice}</div>}

      <div className="bo-toolbar">
        <div className="bo-search">
          <Search size={17} />
          <input
            aria-label="Rechercher un produit"
            placeholder="Nom, SKU, matière, marque, tag…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div className="bo-tabs" role="tablist">
          {statusTabs.map((tab) => (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={status === tab.value}
              className={status === tab.value ? "active" : undefined}
              onClick={() => {
                setStatus(tab.value);
                setPage(1);
              }}
            >
              {tab.label}
              <span>{data?.counts[tab.value] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="bo-filters">
          <select
            aria-label="Filtrer par type"
            value={objectType}
            onChange={(event) => {
              setObjectType(event.target.value);
              setPage(1);
            }}
          >
            <option value="all">Tous les types</option>
            {Object.entries(objectTypeLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <select
            aria-label="Filtrer par support"
            value={placementType}
            onChange={(event) => {
              setPlacementType(event.target.value);
              setPage(1);
            }}
          >
            <option value="all">Tous les supports</option>
            {Object.entries(placementLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <select
            aria-label="Trier"
            value={sort}
            onChange={(event) => setSort(event.target.value)}
          >
            <option value="updated">Modifiés récemment</option>
            <option value="recent">Créés récemment</option>
            <option value="name">Nom A→Z</option>
            <option value="price_desc">Prix décroissant</option>
            <option value="price_asc">Prix croissant</option>
          </select>
        </div>
      </div>

      {selected.length > 0 && (
        <div className="bo-bulk">
          <strong>{selected.length} sélectionné(s)</strong>
          <button type="button" onClick={() => void bulk("publish")}>
            <CheckCircle2 size={15} /> Publier
          </button>
          <button type="button" onClick={() => void bulk("unpublish")}>
            <EyeOff size={15} /> Dépublier
          </button>
          <button type="button" onClick={() => void bulk("archive")}>
            <Archive size={15} /> Archiver
          </button>
          <button type="button" onClick={() => void bulk("restore")}>
            <ArchiveRestore size={15} /> Restaurer
          </button>
          <button type="button" onClick={() => void bulk("persist")}>
            <Pin size={15} /> Rendre permanent
          </button>
          <button
            className="danger"
            type="button"
            onClick={() => void bulk("delete")}
          >
            <Trash2 size={15} /> Supprimer
          </button>
          <button type="button" onClick={() => setSelected([])}>
            Annuler
          </button>
        </div>
      )}

      <div className="bo-table-wrapper">
        <table className="bo-table">
          <thead>
            <tr>
              <th className="bo-checkbox-cell">
                <input
                  type="checkbox"
                  aria-label="Tout sélectionner"
                  checked={allSelected}
                  onChange={(event) =>
                    setSelected(
                      event.target.checked ? items.map((item) => item.id) : [],
                    )
                  }
                />
              </th>
              <th>Produit</th>
              <th>Type</th>
              <th>Dimensions</th>
              <th>Prix</th>
              <th>Stock</th>
              <th>Statut</th>
              <th>Modifié</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {items.map((product) => (
              <tr key={product.id}>
                <td className="bo-checkbox-cell">
                  <input
                    type="checkbox"
                    aria-label={`Sélectionner ${product.name}`}
                    checked={selected.includes(product.id)}
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked
                          ? [...current, product.id]
                          : current.filter((id) => id !== product.id),
                      )
                    }
                  />
                </td>
                <td>
                  <div className="bo-product-cell">
                    <div className="bo-thumb">
                      {product.thumbnailUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={product.thumbnailUrl} alt="" />
                      ) : (
                        <ImageOff size={17} />
                      )}
                    </div>
                    <div>
                      <Link href={`/admin/produits/${product.id}`}>
                        {product.name}
                      </Link>
                      <small>
                        {product.sku ?? "sans SKU"}
                        {product.brand ? ` · ${product.brand}` : ""}
                        {product.variants.length
                          ? ` · ${product.variants.length} taille(s)`
                          : ""}
                        {product.temporary ? " · temporaire" : ""}
                      </small>
                    </div>
                  </div>
                </td>
                <td>
                  {objectTypeLabels[product.objectType] ?? product.objectType}
                  <small>
                    {placementLabels[product.placementType] ??
                      product.placementType}
                  </small>
                </td>
                <td className="bo-numeric">
                  {product.widthCm} × {product.heightCm} × {product.depthCm} cm
                </td>
                <td className="bo-numeric">
                  {formatPrice(product.priceCents, product.currency)}
                </td>
                <td className="bo-numeric">{product.stock ?? "—"}</td>
                <td>
                  <span className={`bo-status bo-status-${product.status}`}>
                    {statusLabels[product.status] ?? product.status}
                  </span>
                  {!product.hasCutout && (
                    <small className="bo-warn">détourage manquant</small>
                  )}
                </td>
                <td>
                  <small>{formatDate(product.updatedAt)}</small>
                </td>
                <td>
                  <div className="bo-row-actions">
                    <Link
                      className="bo-icon-button"
                      href={`/admin/produits/${product.id}`}
                      title="Modifier"
                    >
                      <Pencil size={15} />
                    </Link>
                    {product.status === "ready" ? (
                      <button
                        className="bo-icon-button"
                        type="button"
                        title="Dépublier"
                        onClick={() => void act(product, "unpublish")}
                      >
                        <EyeOff size={15} />
                      </button>
                    ) : (
                      <button
                        className="bo-icon-button"
                        type="button"
                        title="Publier"
                        onClick={() => void act(product, "publish")}
                      >
                        <CheckCircle2 size={15} />
                      </button>
                    )}
                    <button
                      className="bo-icon-button"
                      type="button"
                      title="Dupliquer"
                      onClick={() => void act(product, "duplicate")}
                    >
                      <Copy size={15} />
                    </button>
                    {product.status === "archived" ? (
                      <button
                        className="bo-icon-button"
                        type="button"
                        title="Restaurer"
                        onClick={() => void act(product, "restore")}
                      >
                        <ArchiveRestore size={15} />
                      </button>
                    ) : (
                      <button
                        className="bo-icon-button"
                        type="button"
                        title="Archiver"
                        onClick={() => void act(product, "archive")}
                      >
                        <Archive size={15} />
                      </button>
                    )}
                    <button
                      className="bo-icon-button danger"
                      type="button"
                      title="Supprimer définitivement"
                      onClick={() => void remove(product)}
                    >
                      {busy === `${product.id}:delete` ? (
                        <LoaderCircle className="spin" size={15} />
                      ) : (
                        <Trash2 size={15} />
                      )}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && <div className="bo-empty">Chargement…</div>}
        {!loading && items.length === 0 && (
          <div className="bo-empty">
            Aucun produit ne correspond.{" "}
            <Link href="/admin/produits/nouveau">Ajouter un produit</Link>.
          </div>
        )}
      </div>

      {data && data.pageCount > 1 && (
        <div className="bo-pagination">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            <ChevronLeft size={16} /> Précédent
          </button>
          <span>
            Page {data.page} sur {data.pageCount} · {data.total} produit(s)
          </span>
          <button
            type="button"
            disabled={page >= data.pageCount}
            onClick={() =>
              setPage((current) => Math.min(data.pageCount, current + 1))
            }
          >
            Suivant <ChevronRight size={16} />
          </button>
        </div>
      )}
    </>
  );
}
