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
  RefreshCw,
  RotateCcw,
  ScanLine,
  X,
} from "lucide-react";
import { renderSchema, type Render } from "@lili/types";
import { fitManualProductBox, isManualPlaneValid, manualPlacementAnchor, manualPlacementQuad, moveManualPlacement,
  normalizeManualBox, normalizeTap, projectManualPhotoPointToPlane, resizeManualPlacement, type ManualPlacement } from "@lili/geometry";
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
  type StorefrontProduct,
} from "@/lib/storefront";
import {
  startRenderTracking,
  type RenderTrackingIssue,
} from "@/lib/render-tracking";
import { renderTerminalAnnouncement } from "@/lib/render-progress";
import { RenderProgressPanel } from "@/components/render-progress-panel";
import {
  readStorefrontDraft,
  saveStorefrontDraft,
  storefrontDraftKey,
  type StorefrontVisualizationDraft,
} from "@/lib/storefront-visualization-draft";
import { useStorefrontCatalog } from "./catalog-state";
import { StorefrontCamera } from "./storefront-camera";
import { storefrontVisualFootprint, type StorefrontReplacementRegion } from "@/lib/storefront-visual-footprint";
import { ManualProductPreview } from "./manual-product-preview";
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
  const [manualPlacements, setManualPlacements] = useState<Array<ManualPlacement | null>>(() => products.map(() => null));
  const [planeCorners, setPlaneCorners] = useState<Point[][]>(() => products.map(() => []));
  const [placementFirstCorner, setPlacementFirstCorner] = useState<Point | null>(null);
  const [placementAction, setPlacementAction] = useState<"select" | "move">("select");
  const [cutoutAspects, setCutoutAspects] = useState<Array<number | null>>(() => products.map(product =>
    product.cutout ? product.cutout.widthPx / product.cutout.heightPx : null));
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [replacementRegion, setReplacementRegion] = useState<StorefrontReplacementRegion | null>(null);
  const [replacementConfirmed, setReplacementConfirmed] = useState(false);
  const [replacementFirstCorner, setReplacementFirstCorner] = useState<Point | null>(null);
  const [regionCorner, setRegionCorner] = useState<"first" | "second">("first");
  const [points, setPoints] = useState<Array<Point | null>>(() =>
    products.map(() => null),
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const [keyboardPoint, setKeyboardPoint] = useState<Point>({ x: 0.5, y: 0.7 });
  const [busy, setBusy] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [render, setRender] = useState<Render | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [trackingIssue, setTrackingIssue] =
    useState<RenderTrackingIssue | null>(null);
  const [restored, setRestored] = useState(false);
  const [restoreError, setRestoreError] = useState("");
  const [restoreUnavailable, setRestoreUnavailable] = useState(false);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const requestLock = useRef(false);
  const pendingBody = useRef<string | null>(null);
  const refresh = useRef<(() => void) | null>(null);
  const restoreController = useRef<AbortController | null>(null);
  const restoreAbandoned = useRef(false);
  const panel = useRef<HTMLDivElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const frame = useRef<HTMLButtonElement>(null);
  const selectionKey = products.map((product) => product.id).join(",");
  const renderedId = pending(render) ? render!.id : null;
  const frozen = Boolean(!restored || busy || render || uncertain);
  const allPlaced = manualPlacements.length === products.length && manualPlacements.every(Boolean);
  const step = render ? 3 : !scene ? 1 : 2;
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

  // Reloading only restores identifiers and reads the existing request. It never
  // submits another render; an uncertain POST retains its original idempotency key.
  useEffect(() => {
    const controller = new AbortController();
    restoreController.current = controller;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const restore = async () => {
      if (restoreAbandoned.current) return;
      setRestoreError("");
      setRestoreUnavailable(false);
      let saved: StorefrontVisualizationDraft | null = null;
      try {
        saved = readStorefrontDraft(
          window.sessionStorage,
          selectionKey.split(","),
        );
      } catch {
        /* Storage can be unavailable in a private browsing context. */
      }
      if (!saved) {
        setRestored(true);
        return;
      }
      timeout = setTimeout(() => controller.abort(), 15_000);
      try {
        const [photo, latest] = await Promise.all([
          storefrontApi(`/v1/scenes/${saved.sceneId}`, {
            signal: controller.signal,
          }).then((value) => sceneSchema.parse(value)),
          saved.renderId
            ? getRender(saved.renderId, controller.signal, storefrontApi)
            : Promise.resolve(null),
        ]);
        if (controller.signal.aborted) return;
        setConsent(true);
        setScene(photo);
        setPoints(saved.points);
        setManualPlacements(saved.manualPlacements ?? products.map((product, index) => {
          const point = saved!.points[index];
          if (!point || productPlacementKind(product) !== "standing") return null;
          // Historical point drafts migrate their visible guide, never a real measurement.
          const guide = storefrontVisualFootprint(product, photo, point, saved!.visualWidths?.[index] ?? 0.18);
          return { box: { xMin: guide.xMin, yMin: guide.yMin, xMax: guide.xMin + guide.width, yMax: guide.yMin + guide.height } };
        }));
        setPlaneCorners(saved.planeCorners ?? saved.productIds.map(() => []));
        setReplaceExisting(saved.replaceExisting);
        setReplacementRegion(saved.replacementRegion ?? null);
        setReplacementConfirmed(Boolean(saved.replacementConfirmed));
        setRender(latest);
        pendingBody.current = saved.pendingBody ?? null;
        setUncertain(Boolean(saved.pendingBody));
        if (saved.pendingBody)
          setError(
            "Votre demande précédente est conservée. Vérifiez-la pour retrouver son résultat sans créer une seconde visualisation.",
          );
        setRestored(true);
      } catch (reason) {
        if (restoreAbandoned.current || (controller.signal.aborted && !timeout)) return;
        const unavailable = reason instanceof ApiError && [403, 404, 410].includes(reason.status);
        setRestoreUnavailable(unavailable);
        setRestoreError(
          unavailable
            ? "Cette photo ou cette visualisation n’est plus accessible avec votre session. Vous pouvez vérifier à nouveau ou recommencer avec une photo."
            : "Votre demande est conservée dans cet onglet. Le suivi n’a pas encore pu être récupéré ; actualisez-le pour reprendre au même endroit.",
        );
      } finally {
        clearTimeout(timeout);
      }
    };
    const initial = setTimeout(() => void restore(), 0);
    return () => {
      clearTimeout(initial);
      clearTimeout(timeout);
      timeout = undefined;
      controller.abort();
    };
  }, [selectionKey, restoreAttempt, products]);

  function restartAfterLostAccess() {
    if (!restoreUnavailable || restored) return;
    // This abandons only this tab's inaccessible draft. It never submits a new
    // render or cancels/deletes a request that may still exist on the server.
    restoreAbandoned.current = true;
    restoreController.current?.abort();
    try {
      window.sessionStorage.removeItem(storefrontDraftKey(selectionKey.split(",")));
    } catch {
      /* The current page remains usable if browser storage was revoked. */
    }
    pendingBody.current = null;
    requestLock.current = false;
    setConsent(false);
    setScene(null);
    setSceneImageReady(false);
    setManualPlacements(products.map(() => null));
    setPlaneCorners(products.map(() => []));
    setPlacementFirstCorner(null);
    setPlacementAction("select");
    setReplaceExisting(false);
    setReplacementRegion(null);
    setReplacementConfirmed(false);
    setReplacementFirstCorner(null);
    setPoints(products.map(() => null));
    setActiveIndex(0);
    setKeyboardPoint({ x: 0.5, y: 0.7 });
    setRender(null);
    setUncertain(false);
    setShowOriginal(false);
    setTrackingIssue(null);
    setRefreshing(false);
    setSubmitting(false);
    setBusy("");
    setError("");
    setRestoreError("");
    setRestoreUnavailable(false);
    setRestored(true);
  }

  const draft = useMemo<StorefrontVisualizationDraft | null>(
    () =>
      scene
        ? {
            version: 1,
            savedAt: 0,
            productIds: selectionKey.split(","),
            sceneId: scene.id,
            points,
            referenceBase: null,
            referenceTop: null,
            referenceHeight: "",
            sameDepth: false,
            referenceReady: true,
            useMeasurement: false,
            manualPlacements,
            planeCorners,
            replaceExisting,
            replacementRegion: replacementRegion && (replacementRegion.xMax - replacementRegion.xMin) * (replacementRegion.yMax - replacementRegion.yMin) <= 0.5 && replacementRegion.xMax > replacementRegion.xMin && replacementRegion.yMax > replacementRegion.yMin ? replacementRegion : null,
            replacementConfirmed,
            ...(render ? { renderId: render.id } : {}),
          }
        : null,
    [
      scene,
      selectionKey,
      points,
      manualPlacements,
      planeCorners,
      replaceExisting,
      replacementRegion,
      replacementConfirmed,
      render,
    ],
  );
  useEffect(() => {
    if (!restored || !draft) return;
    try {
      saveStorefrontDraft(window.sessionStorage, {
        ...draft,
        savedAt: Date.now(),
        ...(!render && pendingBody.current
          ? { pendingBody: pendingBody.current }
          : {}),
      });
    } catch {
      /* The current page remains usable if tab storage is disabled. */
    }
  }, [draft, restored, render, uncertain]);

  useEffect(() => {
    if (!renderedId) return;
    panel.current?.focus({ preventScroll: true });
    panel.current?.scrollIntoView({ block: "start", behavior: "instant" });
    const tracking = startRenderTracking({
      renderId: renderedId,
      fetchRender: (id, signal) => getRender(id, signal, storefrontApi),
      onRender: (next) =>
        setRender((current) =>
          current?.id === next.id && !pending(current) ? current : next,
        ),
      onInterrupted: setTrackingIssue,
      onRefreshing: setRefreshing,
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
      setManualPlacements(products.map(() => null));
      setPlaneCorners(products.map(() => []));
      setPlacementFirstCorner(null);
      setPlacementAction("select");
      setReplaceExisting(false);
      setReplacementRegion(null);
      setReplacementConfirmed(false);
      setReplacementFirstCorner(null);
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
  function focusPlacement() {
    frame.current?.focus({ preventScroll: true });
    frame.current?.scrollIntoView({ block: "nearest", behavior: "instant" });
  }
  function updatePlacement(index: number, placement: ManualPlacement) {
    setManualPlacements(current => current.map((item, i) => i === index ? placement : item));
    setPoints(current => current.map((item, i) => i === index ? manualPlacementAnchor(placement, productPlacementKind(products[index]!)) : item));
    pendingBody.current = null;
    setError("");
  }
  function choosePoint(photoPoint: Point) {
    if (frozen || !scene) return;
    if (replaceExisting && !replacementConfirmed) {
      if (regionCorner === "first" || !replacementFirstCorner) {
        setReplacementFirstCorner(photoPoint);
        setReplacementRegion(null);
        setRegionCorner("second");
      } else setReplacementRegion(normalizeManualBox(replacementFirstCorner, photoPoint));
      setError("");
      pendingBody.current = null;
      return;
    }
    const kind = productPlacementKind(activeProduct);
    const corners = planeCorners[activeIndex] ?? [];
    if (kind !== "standing" && corners.length < 4) {
      const next = [...corners, photoPoint];
      if (next.length === 4 && !isManualPlaneValid(next)) {
        setError("Les coins se croisent ou sont trop proches. Recommencez le plan en suivant son contour.");
        return;
      }
      setPlaneCorners(current => current.map((item, i) => i === activeIndex ? next : item));
      setError("");
      pendingBody.current = null;
      return;
    }
    const plane = kind !== "standing" && isManualPlaneValid(corners) ? [...corners] as [Point, Point, Point, Point] : undefined;
    const point = plane ? projectManualPhotoPointToPlane(photoPoint, plane) : photoPoint;
    if (!point || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) {
      setError("Choisissez un emplacement à l’intérieur du plan délimité.");
      return;
    }
    const current = manualPlacements[activeIndex];
    if (placementAction === "move" && current) {
      updatePlacement(activeIndex, moveManualPlacement(current, point, kind));
      return;
    }
    if (!placementFirstCorner) {
      setPlacementFirstCorner(point);
      setError("");
      return;
    }
    const box = normalizeManualBox(placementFirstCorner, point);
    if (box.xMax - box.xMin < 0.01 || box.yMax - box.yMin < 0.01) {
      setError("Choisissez le coin opposé un peu plus loin pour définir la taille.");
      return;
    }
    updatePlacement(activeIndex, { box, ...(plane ? { plane } : {}) });
    setPlacementFirstCorner(null);
    setPlacementAction("move");
    const following = manualPlacements.findIndex((p, i) => i > activeIndex && !p);
    if (following >= 0) { setActiveIndex(following); setPlacementAction("select"); }
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
      (!pendingBody.current && !allPlaced) ||
      (!pendingBody.current && replaceExisting && !replacementConfirmed) ||
      requestLock.current ||
      render
    )
      return;
    requestLock.current = true;
    setSubmitting(true);
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
        replaceExisting,
        ...(replaceExisting && replacementConfirmed && replacementRegion ? { replacementRegion } : {}),
        simplePlacements: products.map((product, index) => ({
          productId: product.id,
          placementPoint: points[index],
          dimensionPair: productDimensionPair(product),
          placementKind: productPlacementKind(product),
          manualPlacement: manualPlacements[index],
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
    // Persist before the network call, including when the tab reloads before
    // the acceptance response arrives. Retrying will use this exact body.
    if (draft) {
      try {
        saveStorefrontDraft(window.sessionStorage, {
          ...draft,
          savedAt: Date.now(),
          pendingBody: pendingBody.current,
        });
      } catch {
        /* No effect on the idempotent request in this page. */
      }
    }
    try {
      await establishStorefrontSession();
      const created = renderSchema.parse(
        await storefrontApi("/v1/renders/final", {
          method: "POST",
          body: pendingBody.current,
          signal: AbortSignal.timeout(20_000),
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
      if (definitelyRefused) {
        pendingBody.current = null;
        if (draft) {
          try {
            saveStorefrontDraft(window.sessionStorage, {
              ...draft,
              savedAt: Date.now(),
            });
          } catch {
            /* Optional tab persistence. */
          }
        }
      }
      setUncertain(!definitelyRefused);
      setError(
        definitelyRefused && reason instanceof Error
          ? reason.message
          : "La réponse n’est pas arrivée. Votre demande a peut-être été enregistrée. Vérifiez-la avec le bouton ci-dessous ; la même demande sera utilisée.",
      );
    } finally {
      requestLock.current = false;
      setSubmitting(false);
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
  // Only the server can authorize a private adjustment preview after the identity
  // and background checks. A failed composite alone is never exposed here.
  const adjustmentUrl = render?.status === "failed"
    ? safeStorefrontUrl(render.adjustmentPreviewUrl) : null;
  const activePlacement = manualPlacements[activeIndex];
  const activeKind = productPlacementKind(activeProduct);
  const activePlane = planeCorners[activeIndex] ?? [];
  const needsPlane = activeKind !== "standing" && activePlane.length < 4;
  const fittedPlacements = manualPlacements.map((placement, index) => {
    if (!placement || !scene) return null;
    const product = products[index]!;
    const fallbackRatio = product.widthCm / (productPlacementKind(product) === "flat" ? product.depthCm : product.heightCm);
    return fitManualProductBox(placement, cutoutAspects[index] ?? fallbackRatio, scene.widthPx, scene.heightPx, productPlacementKind(product));
  });
  const instruction = replaceExisting && !replacementConfirmed
    ? `Zone à retirer : choisissez le ${replacementFirstCorner ? "coin opposé" : "premier coin"} autour de l’objet. Le placement du produit reste indépendant.`
    : needsPlane
      ? `${activeKind === "flat" ? "Sol" : "Mur"} : choisissez ${["le coin en haut à gauche", "le coin en haut à droite", "le coin en bas à droite", "le coin en bas à gauche"][activePlane.length]} du plan visible (${activePlane.length + 1}/4). Suivez un rectangle réel dans la pièce.`
      : placementAction === "move" && activePlacement
        ? `Touchez ${activeKind === "standing" ? "le nouveau point de contact avec le support" : "le nouveau centre dans le plan"} pour déplacer le produit. Sa taille est conservée.`
        : `Choisissez ${placementFirstCorner ? "le coin opposé" : "un premier coin"} de la boîte du nouveau produit. Les deux sens de sélection fonctionnent.`;
  function confirmReplacement() {
    if (!replacementRegion) return;
    const width = replacementRegion.xMax - replacementRegion.xMin;
    const height = replacementRegion.yMax - replacementRegion.yMin;
    if (width < 0.02 || height < 0.02 || width * height > 0.5) {
      setError("Entourez seulement l’objet à retirer, avec un peu d’espace autour. Préservez le meuble qui le supporte.");
      return;
    }
    setReplacementConfirmed(true);
    setError("");
    pendingBody.current = null;
  }
  function nudgePlacement(dx: number, dy: number) {
    if (!activePlacement || frozen) return;
    const b = activePlacement.box;
    updatePlacement(activeIndex, moveManualPlacement(activePlacement, {
      x: (b.xMin + b.xMax) / 2 + dx,
      y: (activeKind === "standing" ? b.yMax : (b.yMin + b.yMax) / 2) + dy,
    }, activeKind));
  }
  return (
    <>
      <ol className="store-steps" aria-label="Étapes de visualisation">
        {["Photo", "Placement", "Résultat"].map((label, i) => (
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
              disabled={frozen || !scene}
              aria-pressed={activeIndex === index && !render}
              onClick={() => {
                setActiveIndex(index);
                setPlacementFirstCorner(null);
                setPlacementAction(manualPlacements[index] ? "move" : "select");
                focusPlacement();
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
            photo est une estimation visuelle. Choisissez sa boîte, puis ajustez
            le patron et sa taille.
          </p>
        </aside>
        <section className="store-workspace" aria-label="Votre intérieur">
          {error && (
            <p role="alert" className="store-error">
              {error}
            </p>
          )}
          {!restored ? (
            <div className="flex flex-col gap-4 py-6" aria-busy={!restoreError}>
              <h2>
                {restoreError
                  ? "Retrouvons votre visualisation."
                  : "Récupération de votre demande…"}
              </h2>
              <div
                className="skeleton h-52 w-full motion-reduce:animate-none"
                aria-hidden="true"
              />
              <p role="status">
                {restoreError ||
                  "Votre photo, vos emplacements et le suivi sont récupérés dans cet onglet."}
              </p>
              {restoreError && (
                <button
                  type="button"
                  className="btn btn-outline min-h-11"
                  onClick={() => setRestoreAttempt((value) => value + 1)}
                >
                  <RefreshCw size={16} aria-hidden="true" />
                  Actualiser le suivi
                </button>
              )}
              {restoreUnavailable && (
                <button
                  type="button"
                  className="btn min-h-11 whitespace-normal"
                  onClick={restartAfterLostAccess}
                >
                  <RotateCcw size={16} aria-hidden="true" />
                  Recommencer avec une photo
                </button>
              )}
            </div>
          ) : !scene ? (
            <div className="store-upload">
              <div className="store-upload-icon">
                <Camera size={38} strokeWidth={1.4} />
              </div>
              <p className="store-kicker">COMMENÇONS CHEZ VOUS</p>
              <h2>Montrez-nous votre intérieur.</h2>
              <p>Prenez une photo ou choisissez-en une dans votre galerie. Placez ensuite votre article et ajustez sa taille à l’écran.</p>
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
                    ref={photoInput}
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
                <button type="button" className="store-button secondary" disabled={!consent || !!busy} onClick={() => setCameraOpen(true)}>
                  <Camera size={18} aria-hidden="true" />
                  Prendre une photo
                </button>
              </div>
              <small>JPEG, PNG ou WebP · 20 Mo maximum</small>
            </div>
          ) : render ? (
            <div className="store-render-result">
              <span className="store-sr-only" role="status" aria-live="polite">
                {adjustmentUrl ? "Aperçu non validé. Corrigez la taille, le placement ou le plan avant une nouvelle tentative." : renderTerminalAnnouncement(
                  render.status === "succeeded" && !resultUrl
                    ? undefined
                    : render.status,
                )}
              </span>
              {pending(render) ? (
                <>
                  <RenderProgressPanel
                    render={render}
                    sceneUrl={scene.imageUrl}
                    trackingIssue={trackingIssue}
                    onRefresh={() => refresh.current?.()}
                    refreshing={refreshing}
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
                        : adjustmentUrl ? "Aperçu à corriger." : "Nous n’avons pas pu terminer cette visualisation."}
                  </h2>
                  {(render.status === "succeeded" && resultUrl) || adjustmentUrl ? (
                    <>
                      <div className="store-result-image">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={showOriginal ? scene.imageUrl : (resultUrl ?? adjustmentUrl)!}
                          alt={
                            showOriginal
                              ? "Votre pièce avant la visualisation"
                              : adjustmentUrl ? "Aperçu de votre article, taille et placement à ajuster" : "Votre sélection visualisée dans votre pièce"
                          }
                        />
                        <span>
                          {showOriginal ? "Votre photo" : adjustmentUrl ? "Aperçu non validé" : "Votre visualisation"}
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
                        {!adjustmentUrl && <a
                          href={resultUrl!}
                          className="store-button"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Ouvrir l’image
                        </a>}
                      </div>
                      <p className="store-small-note">
                        {adjustmentUrl
                          ? `Corrigez la boîte, la taille ou les quatre coins du plan pour améliorer l’intégration. ${render.creditCharged ? "Le crédit de cette tentative a été utilisé." : "Cette tentative n’a pas utilisé de crédit."}`
                          : "Image d’inspiration à échelle approximative. Vérifiez les dimensions et l’espace disponible avant votre achat."}
                      </p>
                      {adjustmentUrl && <p className="store-help" role="status">{render.qualityDecision?.feedback || render.error || "L’intégration doit être corrigée avant de valider ce résultat."}</p>}
                    </>
                  ) : (
                    <p className="store-help">
                      {render.error ||
                        "Votre sélection et votre photo restent disponibles pour ajuster les emplacements."}
                    </p>
                  )}
                  <button className="store-text-link min-h-11" onClick={editAgain}>
                    <RotateCcw size={16} />
                    {adjustmentUrl ? "Ajuster placement et taille" : "Revenir aux emplacements"}
                  </button>
                </>
              )}
            </div>
          ) : submitting ? (
            <div className="flex flex-col gap-4 py-6" aria-busy="true">
              <h2>Envoi de votre demande…</h2>
              <div
                className="skeleton h-64 w-full motion-reduce:animate-none"
                aria-hidden="true"
              />
              <p role="status">
                Un instant, nous enregistrons votre photo et vos emplacements.
              </p>
            </div>
          ) : (
            <>
              <div className="store-workspace-heading">
                <div>
                  <p className="store-kicker">ARTICLE {activeIndex + 1} · {activeProduct.name}</p>
                  <h2>{allPlaced ? "Chaque pièce a sa place." : "Dessinez-lui une place."}</h2>
                  <p id="store-placement-help" role="status" aria-live="polite">{instruction}</p>
                </div>
                <button type="button" className="store-text-link min-h-11" disabled={frozen}
                  onClick={() => photoInput.current?.click()}>Changer la photo</button>
                <input ref={photoInput} type="file" accept="image/jpeg,image/png,image/webp" className="store-sr-only" disabled={frozen}
                  onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void uploadPhoto(file); }} />
              </div>
              <div className="flex flex-wrap gap-2 my-4" role="group" aria-label="Corriger le placement">
                <button type="button" className="btn min-h-11 h-auto whitespace-normal" disabled={frozen || needsPlane}
                  aria-pressed={placementAction === "select"} onClick={() => {
                    setPlacementAction("select"); setPlacementFirstCorner(null); focusPlacement();
                  }}>{activePlacement ? "Modifier la boîte · 2 coins" : "Choisir la boîte · 2 coins"}</button>
                <button type="button" className="btn min-h-11 h-auto whitespace-normal" disabled={frozen || !activePlacement}
                  aria-pressed={placementAction === "move"} onClick={() => {
                    setPlacementAction("move"); setPlacementFirstCorner(null); focusPlacement();
                  }}>Déplacer le produit</button>
                {activeKind !== "standing" && <button type="button" className="btn min-h-11 h-auto whitespace-normal" disabled={frozen || !activePlane.length}
                  onClick={() => {
                    setPlaneCorners(current => current.map((corners, i) => i === activeIndex ? [] : corners));
                    setManualPlacements(current => current.map((placement, i) => i === activeIndex ? null : placement));
                    setPoints(current => current.map((point, i) => i === activeIndex ? null : point));
                    setPlacementFirstCorner(null); setPlacementAction("select"); pendingBody.current = null; setError(""); focusPlacement();
                  }}>Recommencer le plan · 4 coins</button>}
                {needsPlane && activePlane.length > 0 && <button type="button" className="btn min-h-11" disabled={frozen} onClick={() => {
                  setPlaneCorners(current => current.map((corners, i) => i === activeIndex ? corners.slice(0, -1) : corners)); setError(""); focusPlacement();
                }}>Annuler le dernier coin</button>}
              </div>
              <button ref={frame} className="store-placement-frame" style={{ aspectRatio: `${scene.widthPx} / ${scene.heightPx}` }}
                onClick={tap} disabled={frozen || !sceneImageReady}
                aria-label={`${instruction} Au clavier, utilisez les flèches puis Entrée.`} aria-describedby="store-placement-help"
                onKeyDown={event => {
                  if (frozen || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
                  event.preventDefault();
                  setKeyboardPoint(p => ({
                    x: Math.max(0.001, Math.min(0.999, p.x + (event.key === "ArrowRight" ? 0.02 : event.key === "ArrowLeft" ? -0.02 : 0))),
                    y: Math.max(0.001, Math.min(0.999, p.y + (event.key === "ArrowDown" ? 0.02 : event.key === "ArrowUp" ? -0.02 : 0))),
                  }));
                }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={scene.imageUrl} alt="Votre pièce : choisissez la boîte du nouveau produit et sa perspective" draggable={false}
                  onLoad={() => setSceneImageReady(true)} />
                {sceneImageReady && fittedPlacements.map((placement, index) => {
                  const product = products[index]!; const url = safeStorefrontUrl(product.cutoutUrl);
                  return placement && url ? <ManualProductPreview key={`${product.id}-${index}`} placement={placement} url={url} name={product.name} onAspect={ratio => {
                    setCutoutAspects(current => current[index] === ratio ? current : current.map((value, i) => i === index ? ratio : value));
                  }} /> : null;
                })}
                {sceneImageReady && <svg aria-hidden="true" viewBox={`0 0 ${scene.widthPx} ${scene.heightPx}`} className="store-visual-guides">
                  {manualPlacements.map((placement, index) => {
                    if (!placement) return null;
                    const quad = manualPlacementQuad(placement);
                    return <polygon key={index} className="store-visual-footprint" data-active={activeIndex === index}
                      points={quad.map(p => `${p.x * scene.widthPx},${p.y * scene.heightPx}`).join(" ")} />;
                  })}
                  {activePlane.length > 0 && <polyline className="text-info" fill="none" stroke="currentColor" strokeWidth={scene.widthPx / 300} strokeDasharray="10 7"
                    points={[...activePlane, ...(activePlane.length === 4 ? [activePlane[0]!] : [])].map(p => `${p.x * scene.widthPx},${p.y * scene.heightPx}`).join(" ")} />}
                  {replaceExisting && replacementRegion && <rect className="store-replacement-region"
                    x={replacementRegion.xMin * scene.widthPx} y={replacementRegion.yMin * scene.heightPx}
                    width={(replacementRegion.xMax - replacementRegion.xMin) * scene.widthPx} height={(replacementRegion.yMax - replacementRegion.yMin) * scene.heightPx} />}
                  {replaceExisting && !replacementConfirmed && replacementFirstCorner && <circle className="store-replacement-corner"
                    cx={replacementFirstCorner.x * scene.widthPx} cy={replacementFirstCorner.y * scene.heightPx} r={scene.widthPx / 70} />}
                </svg>}
                {activePlane.map((point, index) => <span key={`plane-${index}`} className="store-placement-pin" style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }} aria-hidden="true">{index + 1}</span>)}
                {placementFirstCorner && (() => {
                  const point = activeKind !== "standing" && isManualPlaneValid(activePlane)
                    ? manualPlacementQuad({ box: { xMin: placementFirstCorner.x, xMax: placementFirstCorner.x, yMin: placementFirstCorner.y, yMax: placementFirstCorner.y }, plane: [...activePlane] as [Point, Point, Point, Point] })[0]
                    : placementFirstCorner;
                  return <span className="store-placement-pin" style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }} aria-hidden="true">A</span>;
                })()}
                {points.map((point, index) => point && <span key={`product-${index}`} className="store-placement-pin" data-active={index === activeIndex}
                  style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }} aria-hidden="true">{index + 1}</span>)}
                <span className="store-keyboard-cursor" style={{ left: `${keyboardPoint.x * 100}%`, top: `${keyboardPoint.y * 100}%` }} aria-hidden="true"><Plus size={20} /></span>
              </button>
              <div className="store-placement-status" role="status" aria-live="polite">
                <MapPin size={17} aria-hidden="true" /><span>{manualPlacements.filter(Boolean).length} emplacement(s) choisi(s) sur {products.length}.
                  {allPlaced ? " Vous pouvez encore ajuster chaque article." : ` À présent : ${activeProduct.name}.`}</span>
              </div>
              {activePlacement && <div className="store-visual-size my-4 flex flex-col gap-3">
                <label htmlFor="store-visual-width" className="text-sm font-medium">Taille visuelle de {activeProduct.name}</label>
                <input id="store-visual-width" className="range min-h-11 w-full" type="range" min="0.01"
                  max={Math.max(0.01, resizeManualPlacement(activePlacement, 1, activeKind).box.xMax - resizeManualPlacement(activePlacement, 1, activeKind).box.xMin)} step="0.005"
                  value={activePlacement.box.xMax - activePlacement.box.xMin} disabled={frozen} aria-describedby="store-visual-size-help"
                  onChange={event => updatePlacement(activeIndex, resizeManualPlacement(activePlacement, Number(event.target.value), activeKind))} />
                <p id="store-visual-size-help" className="text-sm text-base-content/70">Le vrai produit détouré garde ses proportions dans la boîte. La taille est une estimation visuelle, sans mesure en centimètres.
                  {activeKind !== "standing" && " La perspective suit les quatre coins du plan choisi ; ce repérage reste visuel."}</p>
                {!safeStorefrontUrl(activeProduct.cutoutUrl) && <p className="text-sm text-base-content/70">Le patron indique l’emplacement. L’aperçu détouré de cet article est momentanément indisponible.</p>}
                <div className="flex flex-wrap gap-2" role="group" aria-label="Déplacer le produit par petits pas">
                  {([["Gauche", -0.02, 0], ["Droite", 0.02, 0], ["Haut", 0, -0.02], ["Bas", 0, 0.02]] as const).map(([label, dx, dy]) =>
                    <button key={label} type="button" className="btn min-h-11" disabled={frozen} onClick={() => nudgePlacement(dx, dy)}>{label}</button>)}
                </div>
              </div>}
              <label className="my-4 flex min-h-11 items-start gap-3 text-sm cursor-pointer">
                <input type="checkbox" className="checkbox mt-1 shrink-0" checked={replaceExisting} disabled={frozen} onChange={event => {
                  setReplaceExisting(event.target.checked); setReplacementConfirmed(false); setReplacementRegion(null); setReplacementFirstCorner(null);
                  setRegionCorner("first"); setPlacementFirstCorner(null); pendingBody.current = null; if (event.target.checked) focusPlacement();
                }} />
                <span>Retirer un objet présent dans la photo <small className="mt-1 block text-base-content/70">Facultatif : entourez l’objet à supprimer avec deux coins. Cette zone est séparée de la boîte du nouveau produit.</small></span>
              </label>
              {replaceExisting && <div className="my-4 flex flex-col gap-3" aria-label="Zone à retirer">
                <p role="status" className="text-sm">{replacementConfirmed ? "Zone de retrait confirmée. Le meuble de support et le reste de la pièce seront préservés."
                  : replacementRegion ? "Vérifiez la zone entourée, puis confirmez le retrait." : regionCorner === "first" ? "Choisissez le premier coin autour de l’objet à retirer." : "Choisissez le coin opposé autour de l’objet à retirer."}</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="btn min-h-11" disabled={frozen} onClick={() => {
                    setReplacementConfirmed(false); setReplacementFirstCorner(null); setReplacementRegion(null); setRegionCorner("first"); focusPlacement();
                  }}>{replacementConfirmed ? "Modifier la zone de retrait" : "Recommencer la zone de retrait"}</button>
                  {!replacementConfirmed && <button type="button" className="btn min-h-11" disabled={frozen || !replacementRegion} onClick={confirmReplacement}>Confirmer la zone à retirer</button>}
                </div>
              </div>}
              <p className="store-scale-note">Taille estimée dans la photo. Vérifiez les dimensions du catalogue et l’espace disponible avant votre achat.</p>
              <div className="store-generate-row">
                <button className="store-text-link min-h-11" disabled={frozen || !points.some(Boolean)} onClick={() => {
                  setManualPlacements(products.map(() => null)); setPoints(products.map(() => null)); setActiveIndex(0); setPlacementFirstCorner(null);
                  setPlacementAction("select"); pendingBody.current = null;
                }}><RotateCcw size={16} aria-hidden="true" />Replacer les articles</button>
                <button className="store-button min-h-11" disabled={(!uncertain && !allPlaced) || !!busy || (!uncertain && replaceExisting && !replacementConfirmed)}
                  onClick={() => void generate()}><ScanLine size={18} aria-hidden="true" />{uncertain ? "Vérifier ma demande" : "Créer ma visualisation"}</button>
              </div>
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
      {cameraOpen && <StorefrontCamera placementKind={activeKind} onClose={() => setCameraOpen(false)} onCapture={(file) => {
        setCameraOpen(false);
        void uploadPhoto(file);
      }} onChooseExisting={() => { setCameraOpen(false); photoInput.current?.click(); }} />}
    </>
  );
}
