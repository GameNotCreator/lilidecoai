"use client";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  Minus,
  Plus,
  ScanLine,
  ShoppingBag,
  Trash2,
} from "lucide-react";
import { useStorefrontCart } from "@/lib/storefront-cart";
import {
  cartProductIds,
  cartQuantity,
  productDimensions,
  productPrice,
  visualizationProblem,
} from "@/lib/storefront";
import { useStorefrontCatalog } from "./catalog-state";
import { VisualizationLink } from "./visualization-link";
import styles from "./storefront-basket.module.css";
import {
  CatalogError,
  CatalogLoading,
  ProductImage,
} from "./storefront-catalog";

export function StorefrontBasket() {
  const { catalog, error, retry } = useStorefrontCatalog();
  const cart = useStorefrontCart();
  const count = cartQuantity(cart.lines);
  const products = catalog?.products ?? [];
  const problem = visualizationProblem(
    cart.lines,
    products,
    catalog?.visualization.available ?? false,
  );
  const currencies = new Set(
    cart.lines
      .map((row) => products.find((p) => p.id === row.productId)?.currency)
      .filter(Boolean),
  );
  const completePrices = cart.lines.every((row) => {
    const product = products.find((p) => p.id === row.productId);
    return product && product.priceCents !== null && product.priceCents >= 0;
  });
  const total = cart.lines.reduce(
    (sum, row) =>
      sum +
      (products.find((p) => p.id === row.productId)?.priceCents ?? 0) *
        row.quantity,
    0,
  );
  return (
    <main className={`storefront store-page ${styles.page}`}>
      <div className="store-shell">
        <Link href="/#collection" className="store-back">
          <ArrowLeft size={16} />
          Continuer ma découverte
        </Link>
        <div className="store-page-heading">
          <p className="store-kicker">VOTRE SÉLECTION</p>
          <h1>Les pièces qui vous plaisent.</h1>
          <p>
            {count
              ? `${count} article${count > 1 ? "s" : ""} dans votre panier. Imaginez-les ensemble, chez vous.`
              : "Gardez vos coups de cœur à portée de main."}
          </p>
        </div>
        {error ? (
          <CatalogError error={error} retry={retry} />
        ) : !catalog || !cart.ready ? (
          <CatalogLoading />
        ) : !count ? (
          <div className="store-empty store-empty-basket">
            <ShoppingBag size={42} strokeWidth={1} />
            <h2>Une place pour vos envies.</h2>
            <p>
              Votre panier est encore vide. Découvrez la collection et composez
              une sélection qui vous ressemble.
            </p>
            <Link href="/#collection" className="store-button">
              Explorer la boutique <ArrowRight size={17} />
            </Link>
          </div>
        ) : (
          <div className="store-basket-layout">
            <div className="store-basket-items">
              {cart.lines.map((row) => {
                const product = products.find((p) => p.id === row.productId);
                const limit =
                  product?.stock === null
                    ? 99
                    : Math.max(0, product?.stock ?? 0);
                return (
                  <article className="store-basket-item" key={row.productId}>
                    {product ? (
                      <ProductImage product={product} />
                    ) : (
                      <div className="store-product-image" />
                    )}
                    <div className="store-basket-item-copy">
                      <h2>{product?.name ?? "Article indisponible"}</h2>
                      <p>
                        {product
                          ? productDimensions(product)
                          : "Cet article n’est plus au catalogue."}
                      </p>
                      {product && <strong>{productPrice(product)}</strong>}
                      {product?.stock !== null &&
                        product &&
                        product.stock < row.quantity && (
                          <p className="store-inline-error">
                            {product.stock <= 0
                              ? "Cet article est épuisé."
                              : `Seulement ${product.stock} disponible${product.stock > 1 ? "s" : ""}.`}
                          </p>
                        )}
                      <div className="store-quantity-row">
                        <div
                          className="store-quantity"
                          aria-label={`Quantité de ${product?.name ?? "cet article"}`}
                        >
                          <button
                            aria-label={`Diminuer ${product?.name ?? "la quantité"}`}
                            onClick={() =>
                              cart.setQuantity(row.productId, row.quantity - 1)
                            }
                          >
                            <Minus size={16} />
                          </button>
                          <output aria-label="Quantité">{row.quantity}</output>
                          <button
                            aria-label={`Augmenter ${product?.name ?? "la quantité"}`}
                            disabled={row.quantity >= Math.min(99, limit)}
                            onClick={() =>
                              cart.setQuantity(row.productId, row.quantity + 1)
                            }
                          >
                            <Plus size={16} />
                          </button>
                        </div>
                        <button
                          className="store-remove"
                          aria-label={`Retirer ${product?.name ?? "cet article"} du panier`}
                          onClick={() => cart.remove(row.productId)}
                        >
                          <Trash2 size={16} />
                          <span>Retirer</span>
                        </button>
                      </div>
                    </div>
                    <strong className="store-line-total">
                      {product && productPrice(product, row.quantity)}
                    </strong>
                  </article>
                );
              })}
            </div>
            <aside className="store-basket-summary">
              <p className="store-kicker">BIEN ENSEMBLE, MIEUX CHEZ VOUS</p>
              <h2>Imaginez le résultat.</h2>
              <p>
                Une photo de votre pièce, jusqu’à trois articles, et de
                nouvelles idées pour votre intérieur.
              </p>
              <div className="store-total">
                <span>Total des articles</span>
                <strong>
                  {completePrices && currencies.size === 1
                    ? productPrice({
                        priceCents: total,
                        currency: [...currencies][0]!,
                      })
                    : "À confirmer"}
                </strong>
              </div>
              {!completePrices && (
                <p className="store-muted">
                  Le prix de certains articles est sur demande.
                </p>
              )}
              {currencies.size > 1 && (
                <p className="store-muted">
                  Les prix sont affichés dans des devises différentes et ne sont
                  pas additionnés.
                </p>
              )}
              {problem ? (
                <>
                  <button className="store-button" disabled>
                    <ScanLine size={18} />
                    Visualiser chez moi
                  </button>
                  <p className="store-help" role="status">
                    {problem}
                  </p>
                </>
              ) : (
                <VisualizationLink
                  productIds={cartProductIds(cart.lines)}
                  className="store-button"
                >
                  <ScanLine size={18} />
                  Visualiser chez moi
                </VisualizationLink>
              )}
              <Link href="/checkout" className="store-button secondary">
                Demander une commande <ArrowRight size={18} aria-hidden="true" />
              </Link>
              <p className="store-small-note">
                {cart.storageAvailable
                  ? "Votre panier est une sélection enregistrée sur cet appareil."
                  : "L’enregistrement est bloqué par votre navigateur. Votre sélection est conservée uniquement pendant cette visite."}
                Aucun paiement n’est effectué sur cette page.
              </p>
            </aside>
          </div>
        )}
      </div>
    </main>
  );
}
