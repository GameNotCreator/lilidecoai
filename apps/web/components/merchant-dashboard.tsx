"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  Box,
  CircleDollarSign,
  Eye,
  Image as ImageIcon,
  Plus,
  Sparkles,
} from "lucide-react";
import type { Product } from "@lili/types";
import { api, getProducts } from "@/lib/api";

interface Overview {
  renders: number;
  succeeded: number;
  successRate: number;
  recentEstimatedCostUsd: number;
}

const emptyOverview: Overview = {
  renders: 0,
  succeeded: 0,
  successRate: 0,
  recentEstimatedCostUsd: 0,
};

export function MerchantDashboard() {
  const [products, setProducts] = useState<Product[]>([]);
  const [credits, setCredits] = useState(0);
  const [overview, setOverview] = useState<Overview>(emptyOverview);

  useEffect(() => {
    void Promise.all([
      getProducts(),
      api<{ balance: number }>("/v1/credits"),
      api<Overview>("/v1/admin/overview").catch(() => emptyOverview),
    ]).then(([items, wallet, metrics]) => {
      setProducts(items);
      setCredits(wallet.balance);
      setOverview(metrics);
    });
  }, []);

  return (
    <>
      <header className="app-page-head">
        <div>
          <span className="eyebrow">Vue d’ensemble</span>
          <h1>Bonjour, Lili.</h1>
          <p>
            Votre catalogue est prêt à prendre place dans de nouveaux
            intérieurs.
          </p>
        </div>
        <Link className="button" href="/app/products/new">
          <Plus size={17} /> Nouveau produit
        </Link>
      </header>
      <div className="metric-grid">
        <Metric
          icon={<Box />}
          label="Produits prêts"
          value={String(products.length)}
          trend="+1 ce mois"
        />
        <Metric
          icon={<Eye />}
          label="Visualisations"
          value={String(overview.renders)}
          trend="Parcours mock inclus"
        />
        <Metric
          icon={<Sparkles />}
          label="Taux de réussite"
          value={`${Math.round(overview.successRate * 100)}%`}
          trend="Contrôle qualité actif"
        />
        <Metric
          icon={<CircleDollarSign />}
          label="Crédits"
          value={String(credits)}
          trend="Débit après succès"
        />
      </div>
      <section className="app-grid">
        <div className="app-card app-card-wide">
          <div className="app-card-title">
            <div>
              <span>Catalogue</span>
              <h2>Objets les plus récents</h2>
            </div>
            <Link href="/app/catalog">
              Voir tout <ArrowUpRight size={15} />
            </Link>
          </div>
          <div className="product-table">
            {products.map((product) => (
              <div className="product-row" key={product.id}>
                <div className="product-thumb">
                  {product.cutoutUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={product.cutoutUrl} alt="" />
                  ) : (
                    <ImageIcon size={20} />
                  )}
                </div>
                <div>
                  <strong>{product.name}</strong>
                  <small>
                    {product.material} · {product.widthCm} × {product.heightCm}{" "}
                    cm
                  </small>
                </div>
                <span className={`status status-${product.status}`}>
                  {product.status}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="app-card">
          <div className="app-card-title">
            <div>
              <span>Coûts contrôlés</span>
              <h2>IA ce mois</h2>
            </div>
          </div>
          <div className="cost-figure">
            ${overview.recentEstimatedCostUsd.toFixed(3)}
          </div>
          <p className="muted">
            En mode démonstration, aucun appel externe n’est effectué et le coût
            reste nul.
          </p>
          <div className="provider-line">
            <span className="provider-dot" /> MockImageProvider actif
          </div>
        </div>
      </section>
    </>
  );
}

function Metric({
  icon,
  label,
  value,
  trend,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  trend: string;
}) {
  return (
    <article className="metric-card">
      <div className="metric-icon">{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{trend}</small>
    </article>
  );
}
