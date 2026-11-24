"use client";
import Link from "next/link";
import Image from "next/image";
import { categoryPath, productPath, storeIdentity } from "@/lib/site";
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
import {
  defaultStorefrontCategories,
  populatedStorefrontCategories,
  resolveStorefrontCategory,
  storefrontCategoryLabel,
  type StorefrontCategoryOption,
} from "@/lib/storefront-categories";
import { useStorefrontCatalog } from "./catalog-state";
import { StorefrontCatalogueView, useStorefrontMeasurement } from "./storefront-measurement";
import { VisualizationLink } from "./visualization-link";
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
  const stagedSrc = staged ? safeStorefrontUrl(product.stagedPhotoUrl) : undefined;
  const [loadedSrc, setLoadedSrc] = useState<string>();
  const [failedSources, setFailedSources] = useState<string[]>([]);
  const src = [
    stagedSrc,
    safeStorefrontUrl(product.assetUrl),
    safeStorefrontUrl(product.cutoutUrl),
  ].find((url) => url && !failedSources.includes(url));
  function fail() {
    if (src) {
      setFailedSources((urls) => (urls.includes(src) ? urls : [...urls, src]));
    }
  }
  function readImageState(image: HTMLImageElement | null) {
    // A cached image may have finished before React attaches the load handler.
    if (!image?.complete || loadedSrc === src) return;
    if (image.naturalWidth > 0) setLoadedSrc(src);
    else fail();
  }

  return (
    <span className={`store-product-image ${className}`}>
      {src && loadedSrc !== src && (
        <span className="store-image-skeleton" aria-hidden="true" />
      )}
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={src}
          ref={readImageState}
          src={src}
          alt={src === stagedSrc ? `${product.name} en mise en scène` : product.name}
          loading={eager ? "eager" : "lazy"}
          width={800}
          height={800}
          fetchPriority={eager ? "high" : undefined}
          onLoad={() => setLoadedSrc(src)}
          onError={fail}
        />
      ) : (
        <span className="store-image-placeholder">
          <ImageIcon size={30} aria-hidden="true" />
          <span>Photo à venir</span>
        </span>
      )}
    </span>
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
  initialCategory = "",
}: {
  initialCatalog?: Catalog | null;
  initialSearch?: string;
  initialCategory?: string;
}) {
  const { catalog, error, retry } = useStorefrontCatalog(initialCatalog);
  const [search, setSearch] = useState(initialSearch);
  const [category, setCategory] = useState<string>(initialCategory);
  const [collection, setCollection] = useState("");
  const [sort, setSort] = useState("selection");
  const [heroImageSettled, setHeroImageSettled] = useState(false);
  const products = useMemo(() => catalog?.products ?? [], [catalog]);
  const categories = catalog?.categories ?? defaultStorefrontCategories;
  const categoryLinks = useMemo(() => catalog ? populatedStorefrontCategories(catalog) : [], [catalog]);
  const activeCategory = categories.some(({ id }) => id === category)
    ? category
    : "";
  const collections = [...new Set(products.map((p) => p.collection?.trim()).filter(Boolean))]
    .sort((a, b) => (a ?? "").localeCompare(b ?? "", "fr"));
  const visible = useMemo(() => {
    const normalized = (s: string) =>
      s
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
    const query = normalized(search.trim());
    const matches = products.filter((p) => {
      const productCategory = resolveStorefrontCategory(p);
      return (
        (!activeCategory || productCategory === activeCategory) &&
        (!collection || p.collection?.trim() === collection) &&
        (!query ||
          normalized(
            [
              p.name,
              p.description,
              p.material,
              p.brand,
              p.collection,
              storefrontCategoryLabel(productCategory, categories),
              ...p.tags,
            ].join(" "),
          ).includes(query))
      );
    });
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
  }, [products, search, activeCategory, categories, collection, sort]);
  return (
    <main className="storefront">
      <StorefrontCatalogueView categoryId={activeCategory || undefined} />
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
            Céramiques, objets de décoration et coffrets cadeaux. Découvrez la
            sélection ByLiliDeco en Tunisie.
          </p>
          <a className="store-button" href="#collection">
            Explorer la collection <ArrowDown size={17} />
          </a>
        </div>
        <figure className="store-hero-visual m-0">
          {!heroImageSettled && (
            <span className="store-image-skeleton" aria-hidden="true" />
          )}
          <Image
            src={storeIdentity.heroImage.url}
            alt={storeIdentity.heroImage.alt}
            width={storeIdentity.heroImage.width}
            height={storeIdentity.heroImage.height}
            sizes="(max-width: 760px) calc(100vw - 36px), (max-width: 1320px) 46vw, 600px"
            loading="eager"
            fetchPriority="high"
            className="relative block h-auto w-full"
            onLoad={() => setHeroImageSettled(true)}
            onError={() => setHeroImageSettled(true)}
          />
        </figure>
      </section>
      <div className="store-values">
        <div className="store-shell">
          <span>Art & artisanat</span>
          <span>Objets & décoration</span>
          <span>Coffrets & cadeaux</span>
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
              ? `${visible.length} pièce${visible.length > 1 ? "s" : ""} à découvrir`
              : "Objets, matières et inspirations"}
          </p>
        </div>
        {!!categoryLinks.length && (
          <nav className="store-category-links" aria-label="Parcourir les catégories">
            {categoryLinks.map(({ id, label }) => (
              <Link key={id} href={categoryPath(id)} prefetch={false}>
                {label} <ArrowRight size={15} aria-hidden="true" />
              </Link>
            ))}
          </nav>
        )}
        <div className="store-filters">
          <form
            id="store-catalog-search"
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
            <span>Catégorie</span>
            <select
              form="store-catalog-search"
              name="categorie"
              value={activeCategory}
              onChange={(event) => setCategory(event.target.value)}
            >
              <option value="">Toutes les catégories</option>
              {categories.map(({ id, label }) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
          </label>
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
                  setCategory("");
                  setCollection("");
                }}
              >
                Voir toute la collection
              </button>
            )}
          </div>
        ) : (
          <StorefrontProductGrid
            products={visible}
            categories={categories}
            visualizationAvailable={catalog.visualization.available}
          />
        )}
      </section>
      <section
        className="store-shell store-brand-story"
        id="maison"
        aria-labelledby="maison-title"
      >
        <div className="store-signature">
          <Image
            src="/brand/lilideco-signature-transparent.png"
            width={1000}
            height={1000}
            sizes="(max-width: 760px) 260px, 400px"
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
      {catalog?.visualization.available && (
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
      )}
    </main>
  );
}

export function StorefrontProductGrid({
  products,
  categories,
  visualizationAvailable,
}: {
  products: StorefrontProduct[];
  categories: StorefrontCategoryOption[];
  visualizationAvailable: boolean;
}) {
  const cart = useStorefrontCart();
  const track = useStorefrontMeasurement();
  const [selected, setSelected] = useState<StorefrontProduct | null>(null);
  const [notice, setNotice] = useState("");
  function add(product: StorefrontProduct) {
    const current =
      cart.lines.find((row) => row.productId === product.id)?.quantity ?? 0;
    if (current >= Math.min(99, product.stock ?? 99)) {
      setNotice("Vous avez déjà sélectionné toute la quantité disponible.");
      return;
    }
    cart.add(product.id, Math.min(99, product.stock ?? 99));
    track({ name: "cart_item_added", productId: product.id, categoryId: resolveStorefrontCategory(product) });
    setNotice(`${product.name} a été ajouté à votre panier.`);
  }
  return (
    <>
      <div className="store-product-grid">
        {products.map((product) => (
          <article className="store-product-card" key={product.id}>
            <button
              type="button"
              className="store-product-photo-button"
              onClick={(event) => {
                event.currentTarget.focus({ preventScroll: true });
                setSelected(product);
                track({ name: "product_viewed", productId: product.id, categoryId: resolveStorefrontCategory(product) });
              }}
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
                {product.collection ||
                  storefrontCategoryLabel(resolveStorefrontCategory(product), categories)}
              </p>
              <h3 className="store-product-title">
                <Link href={productPath(product.id)} prefetch={false}>{product.name}</Link>
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
                {visualizationAvailable && (
                  product.visualizationAvailable && product.stock !== 0 ? (
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
                  )
                )}
              </div>
            </div>
          </article>
        ))}
      </div>
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
          available={visualizationAvailable}
          onClose={() => setSelected(null)}
          onAdd={() => add(selected)}
        />
      )}
    </>
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
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);
  const buyUrl = safeStorefrontUrl(product.buyUrl);
  return (
    <dialog
      ref={dialog}
      className="store-dialog"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
      aria-labelledby="store-detail-title"
    >
      <div className="store-dialog-toolbar">
        <button
          type="button"
          className="store-dialog-close"
          onClick={() => dialog.current?.close()}
          aria-label="Fermer les détails"
        >
          <X size={22} aria-hidden="true" />
        </button>
      </div>
      <div className="store-dialog-content">
        <div className="store-dialog-media">
          <ProductGallery product={product} eager showStagedFirst />
        </div>
        <div className="store-detail-copy">
          <h2 id="store-detail-title">{product.name}</h2>
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
            type="button"
            className="store-button"
            onClick={() => {
              onAdd();
              dialog.current?.close();
            }}
            disabled={product.stock !== null && product.stock <= 0}
          >
            <Plus size={18} aria-hidden="true" />
            Ajouter au panier
          </button>
          {available && (
            product.visualizationAvailable && product.stock !== 0 ? (
              <VisualizationLink
                className="store-button secondary"
                productIds={[product.id]}
              >
                <ScanLine size={18} aria-hidden="true" />
                Visualiser chez moi
              </VisualizationLink>
            ) : (
              <p className="store-muted">
                La visualisation n’est pas disponible pour cet article actuellement.
              </p>
            )
          )}
          <Link className="store-text-link" href={productPath(product.id)} prefetch={false}>
            Ouvrir la fiche produit <ArrowRight size={16} aria-hidden="true" />
          </Link>
          {buyUrl && (
            <a
              className="store-text-link"
              href={buyUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Voir chez la boutique partenaire <ArrowRight size={16} aria-hidden="true" />
            </a>
          )}
        </div>
      </div>
    </dialog>
  );
}
