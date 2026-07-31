"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { MoreHorizontal, Plus, Search } from "lucide-react";
import type { Product } from "@lili/types";
import { getProducts } from "@/lib/api";

export function Catalog() {
  const [products, setProducts] = useState<Product[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    void getProducts().then(setProducts);
  }, []);

  const filtered = products.filter((product) =>
    `${product.name} ${product.material}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );

  return (
    <>
      <header className="app-page-head">
        <div>
          <span className="eyebrow">Catalogue</span>
          <h1>Panel produits.</h1>
          <p>
            Créez et modifiez les photos, descriptions, dimensions, supports et
            instructions de génération publiés dans le visualiseur.
          </p>
        </div>
        <Link className="button" href="/app/products/new">
          <Plus size={17} /> Ajouter un objet
        </Link>
      </header>
      <div className="catalog-tools">
        <Search size={18} />
        <input
          aria-label="Rechercher dans le catalogue"
          placeholder="Rechercher un objet, matériau…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="catalog-grid">
        {filtered.map((product) => (
          <article className="catalog-card" key={product.id}>
            <div className="catalog-image">
              {product.cutoutUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={product.cutoutUrl} alt={product.name} />
              ) : null}
              <span className={`status status-${product.status}`}>
                {product.status}
              </span>
              <Link
                className="catalog-action"
                href={`/app/products/${product.id}`}
                aria-label={`Modifier ${product.name}`}
              >
                <MoreHorizontal />
              </Link>
            </div>
            <div className="catalog-content">
              <span>{product.material}</span>
              <h2>{product.name}</h2>
              <p>
                {product.widthCm} × {product.heightCm} × {product.depthCm} cm
              </p>
              {product.description && (
                <p className="catalog-description">{product.description}</p>
              )}
              <div className="catalog-links">
                <Link href={`/app/products/${product.id}`}>Modifier →</Link>
                <Link href={`/demo?product=${product.id}`}>Tester →</Link>
              </div>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
