"use client";
import Link from "next/link";
import { useState } from "react";
import { Plus, ScanLine } from "lucide-react";
import { useStorefrontCart } from "@/lib/storefront-cart";
import { type StorefrontProduct } from "@/lib/storefront";
import { VisualizationLink } from "./visualization-link";
export function ProductActions({
  product,
  available,
}: {
  product: StorefrontProduct;
  available: boolean;
}) {
  const cart = useStorefrontCart();
  const [notice, setNotice] = useState("");
  return (
    <div className="store-product-page-actions">
      <button
        className="store-button"
        disabled={product.stock === 0}
        onClick={() => {
          const current =
            cart.lines.find((line) => line.productId === product.id)
              ?.quantity ?? 0;
          const maximum = Math.min(99, product.stock ?? 99);
          if (current >= maximum) {
            setNotice(
              "Toute la quantité disponible est déjà dans votre panier.",
            );
            return;
          }
          cart.add(product.id, maximum);
          setNotice(`${product.name} a été ajouté à votre panier.`);
        }}
      >
        <Plus size={18} aria-hidden="true" />
        Ajouter au panier
      </button>
      {available && product.visualizationAvailable && product.stock !== 0 ? (
        <VisualizationLink
          productIds={[product.id]}
          className="store-button secondary"
        >
          <ScanLine size={18} aria-hidden="true" />
          Visualiser chez moi
        </VisualizationLink>
      ) : (
        <p className="store-muted">
          La visualisation de cet article n’est pas encore disponible.
        </p>
      )}
      <p role="status" aria-live="polite">
        {notice}
        {notice && (
          <>
            {" "}
            <Link href="/panier" className="link">
              Voir le panier
            </Link>
          </>
        )}
      </p>
    </div>
  );
}
