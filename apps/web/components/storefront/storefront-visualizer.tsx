"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  ArrowLeft,
  Camera,
  Check,
  ImagePlus,
  LoaderCircle,
  MapPin,
  Plus,
  RotateCcw,
  ScanLine,
  X,
} from "lucide-react";
import { renderSchema, type Render } from "@lili/types";
import { normalizeTap } from "@lili/geometry";
import { z } from "zod";
import { ApiError } from "@/lib/api-errors";
import { getRender } from "@/lib/api";
import { prepareImageForUpload } from "@/lib/client-image";
import {
  establishStorefrontSession,
  storefrontApi,
} from "@/lib/storefront-api";
import {
  normalizeCart,
  parseVisualizationIds,
  productDimensionPair,
  productDimensions,
  productPlacementKind,
  safeStorefrontUrl,
  visualizationProblem,
  computeStorefrontReferenceScale,
  type StorefrontProduct,
} from "@/lib/storefront";
import {
  startRenderTracking,
  type RenderTrackingIssue,
} from "@/lib/render-tracking";
import { renderTerminalAnnouncement } from "@/lib/render-progress";
import { RenderProgressPanel } from "@/components/render-progress-panel";
import { useStorefrontCatalog } from "./catalog-state";
import {
  CatalogError,
  CatalogLoading,
  ProductImage,
} from "./storefront-catalog";

const sceneSchema = z.object({
  id: z.string().uuid(),
  imageUrl: z.string(),
  widthPx: z.number().positive(),
  heightPx: z.number().positive(),
});
type Scene = z.infer<typeof sceneSchema>;
type Point = { x: number; y: number };
const pending = (render: Render | null) =>
  render?.status === "queued" || render?.status === "processing";

export function StorefrontVisualizer({
  productQuery,
}: {
  productQuery: string;
}) {
  const { catalog, error, retry } = useStorefrontCatalog();
  const ids = parseVisualizationIds(productQuery);
  const cart = ids
    ? normalizeCart(ids.map((productId) => ({ productId, quantity: 1 })))
    : [];
  const problem =
    ids && catalog
      ? visualizationProblem(
          cart,
          catalog.products,
          catalog.visualization.available,
        )
      : "Choisissez de un à trois articles dans la boutique ou votre panier.";
  const selected =
    ids
      ?.map((id) => catalog?.products.find((p) => p.id === id))
      .filter((p): p is StorefrontProduct => Boolean(p)) ?? [];
  return (
    <main className="storefront store-page">
      <div className="store-shell">
        <Link className="store-back" href="/panier">
          <ArrowLeft size={16} />
          Retour à mon panier
        </Link>
        <div className="store-page-heading">
          <p className="store-kicker">VOTRE INTÉRIEUR, VOS ENVIES</p>
          <h1>Faites-leur une place.</h1>
          <p>Une photo, quelques points, et votre sélection prend vie.</p>
        </div>
        {error ? (
          <CatalogError error={error} retry={retry} />
        ) : !catalog ? (
          <CatalogLoading />
        ) : problem ? (
          <div className="store-empty">
            <ScanLine size={36} />
            <h2>Préparons votre sélection.</h2>
            <p>{problem}</p>
            <Link className="store-button" href="/">
              Découvrir la boutique
            </Link>
            <Link className="store-text-link" href="/panier">
              Revoir mon panier
            </Link>
          </div>
        ) : (
          <VisualizationSession key={productQuery} products={selected} />
        )}
      </div>
    </main>
  );
}

function VisualizationSession({ products }: { products: StorefrontProduct[] }) {
  const [consent, setConsent] = useState(false);
  const [scene, setScene] = useState<Scene | null>(null);
  const [sceneImageReady, setSceneImageReady] = useState(false);
  const [referenceBase, setReferenceBase] = useState<Point | null>(null);
  const [referenceTop, setReferenceTop] = useState<Point | null>(null);
  const [referenceHeight, setReferenceHeight] = useState("");
  const [sameDepth, setSameDepth] = useState(false);
  const [referenceReady, setReferenceReady] = useState(false);
  const [useMeasurement, setUseMeasurement] = useState(false);
  const [referenceTarget, setReferenceTarget] = useState<"base" | "top">(
    "base",
  );
  const [points, setPoints] = useState<Array<Point | null>>(() =>
    products.map(() => null),
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const [keyboardPoint, setKeyboardPoint] = useState<Point>({ x: 0.5, y: 0.7 });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [render, setRender] = useState<Render | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [trackingIssue, setTrackingIssue] =
    useState<RenderTrackingIssue | null>(null);
  const requestLock = useRef(false);
  const pendingBody = useRef<string | null>(null);
  const refresh = useRef<(() => void) | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const frame = useRef<HTMLButtonElement>(null);
  const renderedId = pending(render) ? render!.id : null;
  const frozen = Boolean(busy || render || uncertain);
  const allPlaced = points.length === products.length && points.every(Boolean);
  const step = render ? 4 : !scene ? 1 : referenceReady ? 3 : 2;
  const scaleReference =
    referenceBase && referenceTop
      ? {
          realHeightCm: Number(referenceHeight.replace(",", ".")),
          basePoint: referenceBase,
          topPoint: referenceTop,
          sameDepthConfirmed: sameDepth,
        }
      : null;
  const activeProduct = products[activeIndex] ?? products[0]!;
  const units = useMemo(
    () =>
      products.map((product, index) => ({
        product,
        index,
        key: `${product.id}-${index}`,
      })),
    [products],
  );

  useEffect(() => {
    if (!renderedId) return;
    const tracking = startRenderTracking({
      renderId: renderedId,
      fetchRender: (id, signal) => getRender(id, signal, storefrontApi),
      onRender: (next) =>
        setRender((current) =>
          current?.id === next.id && !pending(current) ? current : next,
        ),
      onInterrupted: setTrackingIssue,
    });
    refresh.current = tracking.refresh;
    const resume = () => {
      if (document.visibilityState === "visible") tracking.resume();
    };
    window.addEventListener("online", resume);
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      tracking.stop();
      refresh.current = null;
      window.removeEventListener("online", resume);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [renderedId]);
  const terminalStatus = render && !pending(render) ? render.status : null;
  useEffect(() => {
    if (terminalStatus) resultHeading.current?.focus();
  }, [terminalStatus]);

  async function uploadPhoto(file: File) {
    if (!consent || requestLock.current || frozen) return;
    requestLock.current = true;
    setBusy("Préparation de votre photo…");
    setError("");
    try {
      const prepared = await prepareImageForUpload(file);
      await establishStorefrontSession();
      const form = new FormData();
      form.set("file", prepared);
      form.set("consent", "true");
      const uploaded = sceneSchema.parse(
        await storefrontApi("/v1/scenes", { method: "POST", body: form }),
      );
      setScene(uploaded);
      setSceneImageReady(false);
      setReferenceBase(null);
      setReferenceTop(null);
      setReferenceHeight("");
      setSameDepth(false);
      setReferenceReady(false);
      setUseMeasurement(false);
      setReferenceTarget("base");
      setPoints(products.map(() => null));
      setActiveIndex(0);
      pendingBody.current = null;
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "La photo n’a pas pu être envoyée. Réessayez avec une image JPEG, PNG ou WebP.",
      );
    } finally {
      requestLock.current = false;
      setBusy("");
    }
  }
  function choosePoint(point: Point) {
    if (frozen) return;
    if (!referenceReady) {
      if (referenceTarget === "base") {
        setReferenceBase(point);
        setReferenceTarget("top");
      } else setReferenceTop(point);
      setError("");
      return;
    }
    if (scene && useMeasurement) {
      try {
        computeStorefrontReferenceScale(
          scaleReference,
          scene.widthPx,
          scene.heightPx,
          [point],
        );
      } catch (reason) {
        setError(
          reason instanceof Error
            ? reason.message
            : "Gardez l’article près de votre référence.",
        );
        return;
      }
    }
    const next = [...points];
    next[activeIndex] = point;
    setPoints(next);
    setError("");
    pendingBody.current = null;
    const following = next.findIndex((p, index) => index > activeIndex && !p);
    const remaining = next.findIndex((p) => !p);
    if (following >= 0 || remaining >= 0)
      setActiveIndex(following >= 0 ? following : remaining);
  }
  function tap(event: MouseEvent<HTMLButtonElement>) {
    if (event.detail === 0) {
      choosePoint(keyboardPoint);
      return;
    }
    const point = normalizeTap(
      event.clientX,
      event.clientY,
      event.currentTarget.getBoundingClientRect(),
    );
    if (point) choosePoint(point);
  }
  async function generate() {
    if (
      !scene ||
      !referenceReady ||
      !allPlaced ||
      requestLock.current ||
      render
    )
      return;
    try {
      if (useMeasurement)
        computeStorefrontReferenceScale(
          scaleReference,
          scene.widthPx,
          scene.heightPx,
          points.filter((point): point is Point => !!point),
        );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Vérifiez la référence de hauteur.",
      );
      return;
    }
    requestLock.current = true;
    setBusy(
      uncertain
        ? "Vérification de votre demande…"
        : "Enregistrement de votre visualisation…",
    );
    setError("");
    if (!pendingBody.current) {
      const first = products[0]!,
        point = points[0]!;
      const kind = productPlacementKind(first);
      const surfaceType =
        kind === "wall"
          ? "wall"
          : kind === "flat" || first.placementType === "floor"
            ? "floor"
            : "tabletop";
      pendingBody.current = JSON.stringify({
        engine: "legacy",
        workflow: "simple_point",
        mode: "insert",
        ...(useMeasurement ? { scaleReference } : {}),
        simplePlacements: products.map((product, index) => ({
          productId: product.id,
          placementPoint: points[index],
          dimensionPair: productDimensionPair(product),
          placementKind: productPlacementKind(product),
        })),
        placement: {
          sceneId: scene.id,
          productId: first.id,
          mode: "insert",
          surfaceType,
          xNormalized: point.x,
          yNormalized: point.y,
        },
        placementPoint: point,
        surfaceType,
        outputQuality: "final",
        preserveBackground: true,
        idempotencyKey: crypto.randomUUID(),
      });
    }
    try {
      await establishStorefrontSession();
      const created = renderSchema.parse(
        await storefrontApi("/v1/renders/final", {
          method: "POST",
          body: pendingBody.current,
        }),
      );
      setRender(created);
      setTrackingIssue(null);
      setUncertain(false);
    } catch (reason) {
      const definitelyRefused =
        reason instanceof ApiError &&
        reason.status >= 400 &&
        reason.status < 500 &&
        ![408, 425, 429].includes(reason.status);
      if (definitelyRefused) pendingBody.current = null;
      setUncertain(!definitelyRefused);
      setError(
        definitelyRefused && reason instanceof Error
          ? reason.message
          : "La réponse n’est pas arrivée. Votre demande a peut-être été enregistrée. Vérifiez-la avec le bouton ci-dessous ; la même demande sera utilisée.",
      );
    } finally {
      requestLock.current = false;
      setBusy("");
    }
  }
  async function cancel() {
    if (!render || !pending(render) || requestLock.current) return;
    requestLock.current = true;
    setBusy("Annulation en cours…");
    setError("");
    try {
      const stopped = renderSchema.parse(
        await storefrontApi(`/v1/renders/${render.id}/cancel`, {
          method: "POST",
        }),
      );
      setRender((current) =>
        current?.id === stopped.id && !pending(current) ? current : stopped,
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "L’annulation n’a pas pu être confirmée. Vérifiez l’état de la demande.",
      );
      refresh.current?.();
    } finally {
      requestLock.current = false;
      setBusy("");
    }
  }
  function editAgain() {
    if (pending(render) || busy) return;
    setRender(null);
    setError("");
    setTrackingIssue(null);
    setShowOriginal(false);
    pendingBody.current = null;
  }
  const resultUrl = safeStorefrontUrl(render?.resultUrl);
  return (
    <>
      <ol className="store-steps" aria-label="Étapes de visualisation">
        {["Photo", "Échelle", "Placement", "Résultat"].map((label, i) => (
          <li
            key={label}
            aria-current={step === i + 1 ? "step" : undefined}
            data-complete={step > i + 1}
          >
            <span>{step > i + 1 ? <Check size={16} /> : `0${i + 1}`}</span>
            {label}
          </li>
        ))}
      </ol>
      <div className="store-visual-layout">
        <aside className="store-selection">
          <p className="store-kicker">
            VOTRE SÉLECTION · {products.length} ARTICLE
            {products.length > 1 ? "S" : ""}
          </p>
          {units.map(({ product, index, key }) => (
            <button
              className="store-selected-unit"
              key={key}
              disabled={frozen || !scene || !referenceReady}
              aria-pressed={activeIndex === index && !render}
              onClick={() => {
                setActiveIndex(index);
                frame.current?.focus();
              }}
            >
              <ProductImage product={product} />
              <span>
                <strong>{product.name}</strong>
                <small>{productDimensions(product)}</small>
                <small>
                  {scene
                    ? points[index]
                      ? "Emplacement choisi · modifier"
                      : "Choisir un emplacement"
                    : "Dimensions du catalogue"}
                </small>
              </span>
              <span className="store-unit-number">
                {points[index] ? <Check size={15} /> : index + 1}
              </span>
            </button>
          ))}
          <p className="store-small-note">
            Les dimensions du catalogue sont conservées. La taille dans votre
            photo est estimée. Vous pouvez ajouter un repère de hauteur pour
            l’affiner.
          </p>
        </aside>
        <section className="store-workspace" aria-label="Votre intérieur">
          {error && (!scene || referenceReady || render) && (
            <p role="alert" className="store-error">
              {error}
            </p>
          )}
          {!scene ? (
            <div className="store-upload">
              <div className="store-upload-icon">
                <Camera size={38} strokeWidth={1.4} />
              </div>
              <p className="store-kicker">COMMENÇONS CHEZ VOUS</p>
              <h2>Montrez-nous votre intérieur.</h2>
              <p>
                Prenez une photo bien éclairée, avec le sol ou le support
                visible. Gardez de l’espace autour du futur emplacement.
              </p>
              <label className="store-consent">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => setConsent(event.target.checked)}
                  disabled={!!busy}
                />
                <span>
                  J’autorise l’utilisation de cette photo pour préparer ma
                  visualisation.
                </span>
              </label>
              <p className="store-photo-privacy">
                <Link href="/privacy">
                  Comment votre photo est utilisée et conservée
                </Link>
              </p>
              <div className="store-upload-actions">
                <label
                  className={`store-button ${!consent || busy ? "is-disabled" : ""}`}
                >
                  <ImagePlus size={18} />
                  Choisir une photo
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="store-sr-only"
                    disabled={!consent || !!busy}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (file) void uploadPhoto(file);
                    }}
                  />
                </label>
                <label
                  className={`store-button secondary ${!consent || busy ? "is-disabled" : ""}`}
                >
                  <Camera size={18} />
                  Prendre une photo
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    capture="environment"
                    className="store-sr-only"
                    disabled={!consent || !!busy}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (file) void uploadPhoto(file);
                    }}
                  />
                </label>
              </div>
              <small>JPEG, PNG ou WebP · 20 Mo maximum</small>
            </div>
          ) : render ? (
            <div className="store-render-result">
              <span className="store-sr-only" role="status" aria-live="polite">
                {renderTerminalAnnouncement(render.status)}
              </span>
              {pending(render) ? (
                <>
                  <RenderProgressPanel
                    render={render}
                    sceneUrl={scene.imageUrl}
                    trackingIssue={trackingIssue}
                    onRefresh={() => refresh.current?.()}
                    panelRef={panel}
                  />
                  <button
                    className="store-text-link"
                    onClick={() => void cancel()}
                    disabled={!!busy}
                  >
                    <X size={16} />
                    Annuler la visualisation
                  </button>
                </>
              ) : (
                <>
                  <h2 ref={resultHeading} tabIndex={-1}>
                    {render.status === "succeeded" && resultUrl
                      ? "Bienvenue chez vous."
                      : render.status === "cancelled"
                        ? "La visualisation a été annulée."
                        : "Nous n’avons pas pu terminer cette visualisation."}
                  </h2>
                  {render.status === "succeeded" && resultUrl ? (
                    <>
                      <div className="store-result-image">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={showOriginal ? scene.imageUrl : resultUrl}
                          alt={
                            showOriginal
                              ? "Votre pièce avant la visualisation"
                              : "Votre sélection visualisée dans votre pièce"
                          }
                        />
                        <span>
                          {showOriginal ? "Votre photo" : "Votre visualisation"}
                        </span>
                      </div>
                      <div className="store-result-actions">
                        <button
                          className="store-button secondary"
                          aria-pressed={showOriginal}
                          onClick={() => setShowOriginal((value) => !value)}
                        >
                          {showOriginal
                            ? "Voir ma sélection"
                            : "Comparer avec ma photo"}
                        </button>
                        <a
                          href={resultUrl}
                          className="store-button"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Ouvrir l’image
                        </a>
                      </div>
                      <p className="store-small-note">
                        Image d’inspiration à échelle approximative. Vérifiez
                        les dimensions et l’espace disponible avant votre achat.
                      </p>
                    </>
                  ) : (
                    <p className="store-help">
                      {render.error ||
                        "Votre sélection et votre photo restent disponibles pour ajuster les emplacements."}
                    </p>
                  )}
                  <button className="store-text-link" onClick={editAgain}>
                    <RotateCcw size={16} />
                    Revenir aux emplacements
                  </button>
                </>
              )}
            </div>
          ) : (
            <>
              <div className="store-workspace-heading">
                <div>
                  <p className="store-kicker">
                    {referenceReady
                      ? `POINT ${activeIndex + 1} · ${activeProduct.name}`
                      : "LA TAILLE DANS VOTRE PIÈCE"}
                  </p>
                  <h2>
                    {!referenceReady
                      ? "Affiner la taille, si vous le souhaitez."
                      : allPlaced
                        ? "Chaque pièce a sa place."
                        : "Où l’imaginez-vous ?"}
                  </h2>
                  <p>
                    {!referenceReady
                      ? referenceTarget === "base"
                        ? "Vous pouvez continuer avec une taille estimée. Si vous connaissez une hauteur dans la pièce, indiquez son bas puis son sommet pour affiner l’échelle."
                        : "Touchez maintenant le sommet de cet objet, puis indiquez sa hauteur."
                      : productPlacementKind(activeProduct) === "standing"
                        ? useMeasurement
                          ? "Touchez le point où la base de cet article touchera le sol ou le meuble, à la même profondeur que votre référence."
                          : "Touchez le point où la base de cet article touchera le sol ou le meuble."
                        : "Touchez le centre de l’emplacement souhaité."}
                  </p>
                </div>
                <button
                  className="store-text-link"
                  disabled={frozen}
                  onClick={() => photoInput.current?.click()}
                >
                  Changer la photo
                </button>
                <input
                  ref={photoInput}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="store-sr-only"
                  disabled={frozen}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void uploadPhoto(file);
                  }}
                />
              </div>
              {!referenceReady && (
                <button
                  type="button"
                  className="btn min-h-11 h-auto w-full whitespace-normal mb-4"
                  disabled={frozen}
                  onClick={() => {
                    setUseMeasurement(false);
                    setReferenceReady(true);
                    setError("");
                    frame.current?.focus();
                  }}
                >
                  Continuer avec une échelle estimée
                </button>
              )}
              {!referenceReady && (
                <div className="flex flex-col gap-2 sm:flex-row mb-4">
                  <button
                    type="button"
                    className="btn min-h-11 h-auto whitespace-normal"
                    aria-pressed={referenceTarget === "base"}
                    disabled={frozen}
                    onClick={() => setReferenceTarget("base")}
                  >
                    {referenceBase ? "Modifier le bas" : "1. Choisir le bas"}
                  </button>
                  <button
                    type="button"
                    className="btn min-h-11 h-auto whitespace-normal"
                    aria-pressed={referenceTarget === "top"}
                    disabled={frozen}
                    onClick={() => setReferenceTarget("top")}
                  >
                    {referenceTop
                      ? "Modifier le sommet"
                      : "2. Choisir le sommet"}
                  </button>
                </div>
              )}
              <button
                ref={frame}
                className="store-placement-frame"
                style={{ aspectRatio: `${scene.widthPx} / ${scene.heightPx}` }}
                onClick={tap}
                disabled={frozen || !sceneImageReady}
                aria-label={
                  referenceReady
                    ? `Placer ${activeProduct.name} sur la photo. Au clavier, utilisez les flèches puis Entrée.`
                    : `Choisir ${referenceTarget === "base" ? "le bas" : "le sommet"} de la référence sur la photo. Au clavier, utilisez les flèches puis Entrée.`
                }
                onKeyDown={(event) => {
                  if (
                    frozen ||
                    ![
                      "ArrowLeft",
                      "ArrowRight",
                      "ArrowUp",
                      "ArrowDown",
                    ].includes(event.key)
                  )
                    return;
                  event.preventDefault();
                  setKeyboardPoint((p) => ({
                    x: Math.max(
                      0.02,
                      Math.min(
                        0.98,
                        p.x +
                          (event.key === "ArrowRight"
                            ? 0.02
                            : event.key === "ArrowLeft"
                              ? -0.02
                              : 0),
                      ),
                    ),
                    y: Math.max(
                      0.02,
                      Math.min(
                        0.98,
                        p.y +
                          (event.key === "ArrowDown"
                            ? 0.02
                            : event.key === "ArrowUp"
                              ? -0.02
                              : 0),
                      ),
                    ),
                  }));
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={scene.imageUrl}
                  alt={
                    referenceReady
                      ? "Votre pièce : choisissez les emplacements de votre sélection"
                      : "Votre pièce : indiquez les extrémités d’une hauteur connue"
                  }
                  draggable={false}
                  onLoad={() => setSceneImageReady(true)}
                />
                {referenceBase &&
                  referenceTop &&
                  (!referenceReady || useMeasurement) && (
                    <svg
                      aria-hidden="true"
                      viewBox={`0 0 ${scene.widthPx} ${scene.heightPx}`}
                      className="absolute inset-0 h-full w-full pointer-events-none text-primary"
                    >
                      <line
                        x1={referenceBase.x * scene.widthPx}
                        y1={referenceBase.y * scene.heightPx}
                        x2={referenceTop.x * scene.widthPx}
                        y2={referenceTop.y * scene.heightPx}
                        stroke="currentColor"
                        strokeWidth={Math.max(scene.widthPx / 250, 3)}
                        strokeDasharray="12 8"
                      />
                    </svg>
                  )}
                {[
                  { point: referenceBase, label: "B" },
                  { point: referenceTop, label: "H" },
                ].map(
                  ({ point, label }) =>
                    point &&
                    (!referenceReady || useMeasurement) && (
                      <span
                        key={label}
                        className="store-placement-pin"
                        style={{
                          left: `${point.x * 100}%`,
                          top: `${point.y * 100}%`,
                        }}
                        aria-hidden="true"
                      >
                        {label}
                      </span>
                    ),
                )}
                {points.map(
                  (point, index) =>
                    point && (
                      <span
                        key={index}
                        className="store-placement-pin"
                        data-active={index === activeIndex}
                        style={{
                          left: `${point.x * 100}%`,
                          top: `${point.y * 100}%`,
                        }}
                        aria-hidden="true"
                      >
                        {index + 1}
                      </span>
                    ),
                )}
                <span
                  className="store-keyboard-cursor"
                  style={{
                    left: `${keyboardPoint.x * 100}%`,
                    top: `${keyboardPoint.y * 100}%`,
                  }}
                  aria-hidden="true"
                >
                  <Plus size={20} />
                </span>
              </button>
              {!referenceReady ? (
                <form
                  className="my-4 flex flex-col gap-4 min-w-0"
                  onSubmit={(event) => {
                    event.preventDefault();
                    try {
                      computeStorefrontReferenceScale(
                        scaleReference,
                        scene.widthPx,
                        scene.heightPx,
                      );
                      setReferenceReady(true);
                      setUseMeasurement(true);
                      setError("");
                      frame.current?.focus();
                    } catch (reason) {
                      setError(
                        reason instanceof Error
                          ? reason.message
                          : "Vérifiez votre référence.",
                      );
                    }
                  }}
                >
                  {error && (
                    <p
                      role="alert"
                      id="store-reference-error"
                      className="store-error"
                    >
                      {error}
                    </p>
                  )}
                  <label className="flex flex-col gap-2 min-w-0">
                    <span>Hauteur réelle de votre référence (cm)</span>
                    <input
                      className="input min-h-11 w-full min-w-0 text-base"
                      type="text"
                      inputMode="decimal"
                      required
                      value={referenceHeight}
                      disabled={frozen}
                      aria-describedby={`store-reference-help${error ? " store-reference-error" : ""}`}
                      onChange={(event) =>
                        setReferenceHeight(event.target.value)
                      }
                      placeholder="Exemple : 30"
                    />
                  </label>
                  <p
                    id="store-reference-help"
                    className="text-sm text-base-content/70"
                  >
                    Mesurez une hauteur verticale : une bouteille, une boîte ou
                    un meuble dont vous connaissez la hauteur. Ne mesurez pas
                    une longueur qui part vers le fond de la pièce.
                  </p>
                  <label className="flex gap-3 items-start min-h-11 py-2 cursor-pointer text-sm">
                    <input
                      type="checkbox"
                      required
                      className="mt-1 shrink-0 w-5 h-5 accent-primary"
                      checked={sameDepth}
                      disabled={frozen}
                      onChange={(event) => setSameDepth(event.target.checked)}
                    />
                    <span>
                      Ma référence repose sur le même sol ou meuble, près des
                      articles à placer et à la même profondeur.
                    </span>
                  </label>
                  <button
                    className="btn min-h-11 h-auto whitespace-normal"
                    type="submit"
                    disabled={frozen || !referenceBase || !referenceTop}
                  >
                    Confirmer cette hauteur et placer les articles
                  </button>
                </form>
              ) : (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between my-4">
                  <p className="text-sm">
                    {useMeasurement
                      ? `Repère de hauteur : ${referenceHeight} cm. Gardez les articles près du point B.`
                      : "Taille estimée à partir de votre photo."}
                  </p>
                  <button
                    type="button"
                    className="store-text-link min-h-11"
                    disabled={frozen}
                    onClick={() => {
                      setReferenceReady(false);
                      setPoints(products.map(() => null));
                      setActiveIndex(0);
                      pendingBody.current = null;
                    }}
                  >
                    {useMeasurement
                      ? "Modifier le repère"
                      : "Ajouter un repère de hauteur"}
                  </button>
                </div>
              )}
              {referenceReady && (
                <>
                  <div
                    className="store-placement-status"
                    role="status"
                    aria-live="polite"
                  >
                    <MapPin size={17} />
                    <span>
                      {points.filter(Boolean).length} emplacement
                      {points.filter(Boolean).length > 1 ? "s" : ""} choisi
                      {points.filter(Boolean).length > 1 ? "s" : ""} sur{" "}
                      {products.length}.
                      {allPlaced
                        ? " Vous pouvez encore les modifier en sélectionnant un article."
                        : ` À présent : ${activeProduct.name}.`}
                    </span>
                  </div>
                  {allPlaced && (
                    <p className="store-scale-note">
                      {useMeasurement
                        ? "Votre repère de hauteur sera utilisé avec les dimensions du catalogue. Les articles doivent rester à la même profondeur que ce repère."
                        : "Taille estimée. Vérifiez l’espace disponible avant votre achat."}
                    </p>
                  )}
                  <div className="store-generate-row">
                    <button
                      className="store-text-link"
                      disabled={frozen || !points.some(Boolean)}
                      onClick={() => {
                        setPoints(products.map(() => null));
                        setActiveIndex(0);
                        pendingBody.current = null;
                      }}
                    >
                      <RotateCcw size={16} />
                      Replacer les articles
                    </button>
                    <button
                      className="store-button"
                      disabled={!allPlaced || !!busy}
                      onClick={() => void generate()}
                    >
                      <ScanLine size={18} />
                      {uncertain
                        ? "Vérifier ma demande"
                        : "Créer ma visualisation"}
                    </button>
                  </div>
                </>
              )}
            </>
          )}
          {busy && (
            <div className="store-busy" role="status">
              <LoaderCircle size={19} className="spin" />
              {busy}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
