"use client";
import Link from "next/link";
import Image from "next/image";
import { productPath, storeIdentity } from "@/lib/site";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  Check,
  ImageIcon,
  Plus,
  ScanLine,
  X,
} from "lucide-react";
import { useStorefrontCart } from "@/lib/storefront-cart";
import {
  productDimensions,
  productPrice,
  safeStorefrontUrl,
  type StorefrontProduct,
  type StorefrontCatalog as Catalog,
} from "@/lib/storefront";
import { useStorefrontCatalog } from "./catalog-state";
import { VisualizationLink } from "./visualization-link";

const CATEGORY_LABELS: Record<string, string> = {
  vase: "Vases",
  basket: "Paniers",
  lamp: "Luminaires",
  rug: "Tapis",
  mirror: "Miroirs",
  frame: "Décoration murale",
  chair: "Assises",
  armchair: "Fauteuils",
  sofa: "Canapés",
  table: "Tables",
  furniture: "Mobilier",
  plant: "Plantes",
  clock: "Horloges",
  cushion: "Coussins",
  other: "Objets & décoration",
};
export function categoryLabel(type: string) {
  return CATEGORY_LABELS[type] ?? "Objets & décoration";
}
export function ProductImage({
  product,
  className = "",
  eager = false,
  staged = false,
}: {
  product: StorefrontProduct;
  className?: string;
  eager?: boolean;
  staged?: boolean;
}) {
  const mainSrc =
    safeStorefrontUrl(product.assetUrl) ?? safeStorefrontUrl(product.cutoutUrl);
  const stagedSrc = staged ? safeStorefrontUrl(product.stagedPhotoUrl) : null;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const src = stagedSrc && stagedSrc !== failedSrc ? stagedSrc : mainSrc;
  return (
    <div className={`store-product-image ${className}`}>
      {(!src || failedSrc === src) && (
        <span className="store-image-placeholder">
          <ImageIcon size={30} aria-hidden="true" />
          <span>Photo à venir</span>
        </span>
      )}
      {src && failedSrc !== src && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={src === stagedSrc ? `${product.name} en mise en scène` : product.name}
          loading={eager ? "eager" : "lazy"}
          width={800}
          height={800}
          fetchPriority={eager ? "high" : undefined}
          onError={() => setFailedSrc(src)}
        />
      )}
    </div>
  );
}

export function ProductGallery({
  product,
  eager = false,
  showStagedFirst = false,
}: {
  product: StorefrontProduct;
  eager?: boolean;
  showStagedFirst?: boolean;
}) {
  const [staged, setStaged] = useState(showStagedFirst);
  if (!safeStorefrontUrl(product.stagedPhotoUrl))
    return <ProductImage product={product} eager={eager} />;

  return (
    <div className="store-product-gallery">
      <ProductImage product={product} eager={eager} staged={staged} />
      <div className="store-gallery-controls" role="group" aria-label="Photos de l’article">
        <button type="button" aria-pressed={!staged} onClick={() => setStaged(false)}>
          Photo de l’article
        </button>
        <button type="button" aria-pressed={staged} onClick={() => setStaged(true)}>
          Mise en scène
        </button>
      </div>
    </div>
  );
}
export function CatalogLoading() {
  return (
    <div
      className="store-skeleton-grid"
      role="status"
      aria-label="Chargement du catalogue"
    >
      {[1, 2, 3, 4].map((n) => (
        <div className="store-skeleton" key={n} />
      ))}
      <span className="store-sr-only">Chargement du catalogue…</span>
    </div>
  );
}
export function CatalogError({
  error,
  retry,
}: {
  error: string;
  retry: () => void;
}) {
  return (
    <div className="store-empty" role="alert">
      <h2>La boutique se fait attendre</h2>
      <p>{error}</p>
      <button className="store-button" onClick={retry}>
        Réessayer
      </button>
    </div>
  );
}

export function StorefrontCatalog({
  initialCatalog = null,
  initialSearch = "",
}: {
  initialCatalog?: Catalog | null;
  initialSearch?: string;
}) {
  const { catalog, error, retry } = useStorefrontCatalog(initialCatalog);
  const cart = useStorefrontCart();
  const [search, setSearch] = useState(initialSearch);
  const [category, setCategory] = useState("all");
  const [collection, setCollection] = useState("");
  const [sort, setSort] = useState("selection");
  const [selected, setSelected] = useState<StorefrontProduct | null>(null);
  const [notice, setNotice] = useState("");
  const products = useMemo(() => catalog?.products ?? [], [catalog]);
  const categories = [...new Set(products.map((p) => p.objectType))];
  const collections = [...new Set(products.map((p) => p.collection?.trim()).filter(Boolean))]
    .sort((a, b) => (a ?? "").localeCompare(b ?? "", "fr"));
  const visible = useMemo(() => {
    const normalized = (s: string) =>
      s
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
    const query = normalized(search.trim());
    const matches = products.filter(
      (p) =>
        (category === "all" || p.objectType === category) &&
        (!collection || p.collection?.trim() === collection) &&
        (!query ||
          normalized(
            [
              p.name,
              p.description,
              p.material,
              p.brand,
              p.collection,
              ...p.tags,
            ].join(" "),
          ).includes(query)),
    );
    if (sort === "price-up")
      matches.sort(
        (a, b) => (a.priceCents ?? Infinity) - (b.priceCents ?? Infinity),
      );
    if (sort === "price-down")
      matches.sort(
        (a, b) => (b.priceCents ?? -Infinity) - (a.priceCents ?? -Infinity),
      );
    if (sort === "name")
      matches.sort((a, b) => a.name.localeCompare(b.name, "fr"));
    return matches;
  }, [products, search, category, collection, sort]);
  function add(product: StorefrontProduct) {
    const current =
      cart.lines.find((row) => row.productId === product.id)?.quantity ?? 0;
    if (current >= Math.min(99, product.stock ?? 99)) {
      setNotice("Vous avez déjà sélectionné toute la quantité disponible.");
      return;
    }
    cart.add(product.id, Math.min(99, product.stock ?? 99));
    setNotice(`${product.name} a été ajouté à votre panier.`);
  }
  return (
    <main className="storefront">
      <section className="store-shell store-hero">
        <div className="store-hero-copy">
          <p className="store-kicker">BY LILIDECO — CONCEPT STORE</p>
          <h1>
            L’art de choisir.
            <br />
            Le plaisir d’offrir.
          </h1>
          <p className="store-hero-aside">ou de se l’offrir</p>
          <p className="store-hero-description">
            Objets d’art, artisanat et design. La sélection ByLiliDeco, à
            découvrir ici et à imaginer chez vous.
          </p>
          <a className="store-button" href="#collection">
            Explorer la collection <ArrowDown size={17} />
          </a>
          <div className="store-hero-note">
            <ScanLine size={21} />
            <span>
              Un coup de cœur ?<br />
              <strong>Visualisez chez vous les articles compatibles.</strong>
            </span>
          </div>
        </div>
        <figure className="store-hero-visual m-0">
          <Image
            src="/brand/visualiser-chez-vous.png"
            alt="Illustration de la visualisation chez soi : un téléphone montre un vase ajouté dans un salon lumineux."
            width={1254}
            height={1254}
            sizes="(max-width: 760px) 100vw, 50vw"
            loading="eager"
            fetchPriority="high"
            className="block h-auto w-full rounded-[inherit]"
          />
        </figure>
      </section>
      <div className="store-values">
        <div className="store-shell">
          <span>Art & artisanat</span>
          <span>Objets & décoration</span>
          <span>Votre sélection, chez vous</span>
        </div>
      </div>
      <section
        className="store-shell store-collection"
        id="collection"
        aria-labelledby="collection-title"
      >
        <div className="store-section-heading">
          <div>
            <p className="store-kicker">LA SÉLECTION LILIDECO</p>
            <h2 id="collection-title">La collection.</h2>
          </div>
          <p>
            {catalog
              ? `${products.length} pièce${products.length > 1 ? "s" : ""} à découvrir`
              : "Objets, matières et inspirations"}
          </p>
        </div>
        <div className="store-filters">
          <form
            className="store-search-form"
            action="/"
            method="get"
            role="search"
          >
            <label htmlFor="store-search">Rechercher un article</label>
            <div className="join w-full">
              <input
                id="store-search"
                name="q"
                className="input join-item min-w-0 flex-1"
                autoComplete="off"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Vase, céramique, panier…"
                type="search"
              />
              <button
                type="submit"
                className="btn btn-primary join-item shrink-0"
              >
                Rechercher
              </button>
            </div>
          </form>
          <label className="store-sort">
            <span>Trier les articles</span>
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value)}
            >
              <option value="selection">Notre sélection</option>
              <option value="price-up">Prix croissant</option>
              <option value="price-down">Prix décroissant</option>
              <option value="name">Nom de l’article</option>
            </select>
          </label>
          {collections.length > 0 && (
            <label className="store-sort">
              <span>Collection</span>
              <select value={collection} onChange={(event) => setCollection(event.target.value)}>
                <option value="">Toutes les collections</option>
                {collections.map((name) => <option key={name}>{name}</option>)}
              </select>
            </label>
          )}
        </div>
        {!!categories.length && (
          <div className="store-categories" aria-label="Catégories">
            <button
              aria-pressed={category === "all" && !collection}
              onClick={() => {
                setCategory("all");
                setCollection("");
              }}
            >
              Tout voir
            </button>
            {categories.map((type) => (
              <button
                key={type}
                aria-pressed={category === type}
                onClick={() => setCategory(type)}
              >
                {categoryLabel(type)}
              </button>
            ))}
          </div>
        )}
        {error ? (
          <CatalogError error={error} retry={retry} />
        ) : !catalog ? (
          <CatalogLoading />
        ) : !visible.length ? (
          <div className="store-empty">
            <h3>
              {products.length
                ? "Pas encore de coup de cœur ici."
                : "La sélection prend forme."}
            </h3>
            <p>
              {products.length
                ? "Essayez une autre recherche ou découvrez toute la collection."
                : "Nos articles apparaîtront ici dès qu’ils seront disponibles."}
            </p>
            {!!products.length && (
              <button
                className="store-button secondary"
                onClick={() => {
                  setSearch("");
                  setCategory("all");
                  setCollection("");
                }}
              >
                Voir toute la collection
              </button>
            )}
          </div>
        ) : (
          <div className="store-product-grid">
            {visible.map((product) => (
              <article className="store-product-card" key={product.id}>
                <button
                  className="store-product-photo-button"
                  onClick={() => setSelected(product)}
                  aria-label={`Découvrir ${product.name}`}
                >
                  <ProductImage product={product} />
                  {safeStorefrontUrl(product.stagedPhotoUrl) && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="store-staged-preview" src={product.stagedPhotoUrl!}
                      alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} />
                  )}
                  {product.stock === 0 && (
                    <span className="store-stock-badge">Épuisé</span>
                  )}
                </button>
                <div className="store-product-info">
                  <p className="store-product-category">
                    {product.collection || categoryLabel(product.objectType)}
                  </p>
                  <h3 className="store-product-title">
                    <Link href={productPath(product.id)}>{product.name}</Link>
                  </h3>
                  <p className="store-product-price">{productPrice(product)}</p>
                  <p className="store-product-material">
                    {product.material || productDimensions(product)}
                  </p>
                  <div className="store-product-actions">
                    <button
                      className="store-add"
                      disabled={product.stock !== null && product.stock <= 0}
                      onClick={() => add(product)}
                      aria-label={`Ajouter ${product.name} au panier`}
                    >
                      <Plus size={17} />
                      Panier
                    </button>
                    {catalog.visualization.available &&
                    product.visualizationAvailable &&
                    product.stock !== 0 ? (
                      <VisualizationLink
                        className="store-visual-link"
                        productIds={[product.id]}
                      >
                        <ScanLine size={16} />
                        Visualiser
                      </VisualizationLink>
                    ) : (
                      <span className="store-unavailable-action">
                        <button
                          className="store-visual-link"
                          disabled
                          aria-describedby={`unavailable-${product.id}`}
                        >
                          <ScanLine size={16} />
                          Visualiser
                        </button>
                        <small id={`unavailable-${product.id}`}>
                          Indisponible actuellement
                        </small>
                      </span>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      <section
        className="store-shell store-brand-story"
        id="maison"
        aria-labelledby="maison-title"
      >
        <div className="store-signature">
          <Image
            src="/brand/lilideco-signature.png"
            width={1280}
            height={1280}
            sizes="(max-width: 760px) 260px, 33vw"
            alt="Passions et envies… by Lili"
          />
        </div>
        <div>
          <p className="store-kicker">L’ESPRIT BY LILI</p>
          <h2 id="maison-title">
            Des passions.
            <br />
            Des envies.
            <br />
            Une sélection.
          </h2>
          <p>
            Art, artisanat, design, mode & co : ByLiliDeco réunit des pièces à
            découvrir au fil des envies. Retrouvez l’univers de la boutique et
            ses dernières nouveautés sur Instagram.
          </p>
          <a
            className="store-text-link"
            href={storeIdentity.instagram}
            target="_blank"
            rel="noopener noreferrer"
          >
            Découvrir @bylilideco <ArrowRight size={18} aria-hidden="true" />
          </a>
        </div>
      </section>
      <section className="store-shell store-inspiration">
        <div>
          <p className="store-kicker">FAITES-LEUR UNE PLACE</p>
          <h2>Une place chez vous.</h2>
        </div>
        <div>
          <p>
            Retrouvez vos coups de cœur dans le panier. Pour visualiser les
            articles compatibles ensemble, sélectionnez jusqu’à trois articles,
            puis prenez une photo de votre intérieur et indiquez où les placer.
            Découvrez une proposition visuelle à échelle approximative.
          </p>
          <Link href="/panier" className="store-text-link">
            Composer mon intérieur <ArrowRight size={19} />
          </Link>
        </div>
      </section>
      <div
        className={`store-toast ${notice ? "visible" : ""}`}
        role="status"
        aria-live="polite"
      >
        {notice && (
          <>
            <Check size={17} />
            <span>{notice}</span>
            <Link href="/panier">Voir le panier</Link>
            <button
              aria-label="Fermer la notification"
              onClick={() => setNotice("")}
            >
              <X size={16} />
            </button>
          </>
        )}
      </div>
      {selected && (
        <ProductDialog
          key={selected.id}
          product={selected}
          available={catalog?.visualization.available ?? false}
          onClose={() => setSelected(null)}
          onAdd={() => add(selected)}
        />
      )}
    </main>
  );
}

function ProductDialog({
  product,
  available,
  onClose,
  onAdd,
}: {
  product: StorefrontProduct;
  available: boolean;
  onClose: () => void;
  onAdd: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const buyUrl = safeStorefrontUrl(product.buyUrl);
  return (
    <dialog
      ref={dialog}
      className="store-dialog"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      aria-labelledby="store-detail-title"
    >
      <div className="store-dialog-content">
        <button
          className="store-dialog-close"
          onClick={onClose}
          aria-label="Fermer les détails"
        >
          <X size={23} />
        </button>
        <ProductGallery product={product} showStagedFirst />
        <div className="store-detail-copy">
          <h2 id="store-detail-title">{product.name}</h2>
          <Link className="store-text-link" href={productPath(product.id)}>
            Ouvrir la fiche produit <ArrowRight size={16} aria-hidden="true" />
          </Link>
          <p className="store-detail-price">{productPrice(product)}</p>
          <dl className="store-specs">
            <div>
              <dt>Dimensions</dt>
              <dd>{productDimensions(product)}</dd>
            </div>
            {product.material && (
              <div>
                <dt>Matière</dt>
                <dd>{product.material}</dd>
              </div>
            )}
            <div>
              <dt>Disponibilité</dt>
              <dd>
                {product.stock === null
                  ? "À confirmer auprès de la boutique"
                  : product.stock <= 0
                    ? "Épuisé"
                    : `${product.stock} disponible${product.stock > 1 ? "s" : ""}`}
              </dd>
            </div>
          </dl>
          <button
            className="store-button"
            onClick={onAdd}
            disabled={product.stock !== null && product.stock <= 0}
          >
            <Plus size={18} />
            Ajouter au panier
          </button>
          {available &&
          product.visualizationAvailable &&
          product.stock !== 0 ? (
            <VisualizationLink
              className="store-button secondary"
              productIds={[product.id]}
            >
              <ScanLine size={18} />
              Visualiser chez moi
            </VisualizationLink>
          ) : (
            <p className="store-muted">
              La visualisation n’est pas disponible pour cet article
              actuellement.
            </p>
          )}
          {buyUrl && (
            <a
              className="store-text-link"
              href={buyUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Consulter la fiche de la boutique <ArrowRight size={16} />
            </a>
          )}
        </div>
      </div>
    </dialog>
  );
}
