"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Archive,
  Boxes,
  CheckCircle2,
  FileEdit,
  ImageOff,
  Sparkles,
  Wallet,
} from "lucide-react";

import {
  adminApi,
  formatDate,
  formatPrice,
  statusLabels,
  type AdminOverview,
} from "@/lib/admin-client";

export function AdminDashboard() {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void adminApi<AdminOverview>("/overview")
      .then(setData)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : "Chargement impossible"),
      );
  }, []);

  const products = data?.products;
  const renders = data?.renders;

  return (
    <>
      <header className="bo-head">
        <div>
          <span className="bo-eyebrow">Tableau de bord</span>
          <h1>Votre banque de produits.</h1>
          <p>
            {data
              ? `Boutique « ${data.organization.name} » · slug public ${data.organization.slug}`
              : "Chargement de l’organisation…"}
          </p>
        </div>
        <Link className="bo-button bo-button-primary" href="/admin/produits/nouveau">
          Ajouter un produit
        </Link>
      </header>

      {error && <div className="bo-alert bo-alert-error">{error}</div>}

      <div className="bo-stat-grid">
        <Stat
          icon={<Boxes size={18} />}
          label="Produits"
          value={products?.all ?? 0}
          hint="Toutes fiches confondues"
        />
        <Stat
          icon={<CheckCircle2 size={18} />}
          label="Publiés"
          value={products?.ready ?? 0}
          hint="Visibles dans le visualiseur"
          tone="ok"
        />
        <Stat
          icon={<FileEdit size={18} />}
          label="Brouillons"
          value={(products?.draft ?? 0) + (products?.processing ?? 0)}
          hint="À compléter ou préparer"
          tone="warn"
        />
        <Stat
          icon={<Archive size={18} />}
          label="Archivés"
          value={products?.archived ?? 0}
          hint="Retirés du site"
        />
        <Stat
          icon={<ImageOff size={18} />}
          label="Sans détourage"
          value={Math.max(0, (products?.all ?? 0) - (products?.withPhoto ?? 0))}
          hint="Photo manquante ou non préparée"
        />
        <Stat
          icon={<Sparkles size={18} />}
          label="Rendus IA"
          value={renders?.total ?? 0}
          hint={`${Math.round((renders?.successRate ?? 0) * 100)}% de réussite`}
        />
        <Stat
          icon={<Wallet size={18} />}
          label="Coût récent"
          value={`$${(renders?.estimatedCostUsd ?? 0).toFixed(3)}`}
          hint="25 dernières tentatives"
        />
      </div>

      <section className="bo-panel">
        <div className="bo-panel-head">
          <div>
            <h2>Dernières fiches modifiées</h2>
            <p>Les six produits touchés le plus récemment.</p>
          </div>
          <Link className="bo-button bo-button-ghost" href="/admin/produits">
            Ouvrir la banque
          </Link>
        </div>
        {data && data.recentProducts.length === 0 && (
          <div className="bo-empty">
            Aucun produit pour l’instant.{" "}
            <Link href="/admin/produits/nouveau">Créez le premier</Link>.
          </div>
        )}
        <div className="bo-recent-grid">
          {data?.recentProducts.map((product) => (
            <Link
              className="bo-recent-card"
              key={product.id}
              href={`/admin/produits/${product.id}`}
            >
              <div className="bo-thumb">
                {product.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={product.thumbnailUrl} alt="" />
                ) : (
                  <ImageOff size={18} />
                )}
              </div>
              <div>
                <strong>{product.name}</strong>
                <small>
                  {product.widthCm} × {product.heightCm} × {product.depthCm} cm ·{" "}
                  {formatPrice(product.priceCents, product.currency)}
                </small>
                <small>Modifié le {formatDate(product.updatedAt)}</small>
              </div>
              <span className={`bo-status bo-status-${product.status}`}>
                {statusLabels[product.status] ?? product.status}
              </span>
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}

function Stat({
  icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  hint: string;
  tone?: "ok" | "warn";
}) {
  return (
    <article className={tone ? `bo-stat bo-stat-${tone}` : "bo-stat"}>
      <span className="bo-stat-icon">{icon}</span>
      <strong>{value}</strong>
      <span className="bo-stat-label">{label}</span>
      <small>{hint}</small>
    </article>
  );
}
