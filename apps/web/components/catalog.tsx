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
    `${product.name} ${product.material}`.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <>
      <header className="app-page-head">
        <div>
          <span className="eyebrow">Catalogue</span>
          <h1>Vos objets.</h1>
          <p>Préparez les images, dimensions et points d’ancrage publiés dans le widget.</p>
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
              <span className={`status status-${product.status}`}>{product.status}</span>
              <button aria-label={`Actions pour ${product.name}`}><MoreHorizontal /></button>
            </div>
            <div className="catalog-content">
              <span>{product.material}</span>
              <h2>{product.name}</h2>
              <p>{product.widthCm} × {product.heightCm} × {product.depthCm} cm</p>
              <Link href={`/demo?product=${product.id}`}>Tester le rendu →</Link>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}

