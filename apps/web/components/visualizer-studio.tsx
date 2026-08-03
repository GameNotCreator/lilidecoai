"use client";

import { type MouseEvent, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Download,
  ImagePlus,
  LoaderCircle,
  Share2,
  ShoppingBag,
  Sparkles,
  Upload,
} from "lucide-react";
import type { Product, Render } from "@lili/types";
import { Badge, Button } from "@lili/ui";
import {
  api,
  establishGuestEditorSession,
  establishPublicSession,
  getProducts,
  getRender,
} from "@/lib/api";
import { prepareImageForUpload } from "@/lib/client-image";

interface Scene {
  id: string;
  status: string;
  imageUrl: string;
  widthPx: number;
  heightPx: number;
  analysis: Record<string, unknown>;
}

const pipelineCopy: Record<string, { title: string; detail: string }> = {
  inspecting_scene: {
    title: "Analyse de la zone…",
    detail: "Nous vérifions le support et détectons ce qui occupe le point.",
  },
  removing_obstacle: {
    title: "Suppression de l’obstacle…",
    detail: "L’objet présent est retiré et le fond est reconstruit proprement.",
  },
  analyzing_cleaned_scene: {
    title: "Nouvelle lecture de l’espace…",
    detail:
      "La perspective et les limites sont recalculées sur l’image nettoyée.",
  },
  validating_fit: {
    title: "Vérification de la taille…",
    detail: "Nous contrôlons que l’objet repose bien et ne dépasse nulle part.",
  },
  composing_preview: {
    title: "Placement de l’objet…",
    detail: "La position et l’échelle validées sont appliquées à votre photo.",
  },
  refining_final: {
    title: "Finition photoréaliste…",
    detail: "Les ombres, la lumière et les textures sont harmonisées.",
  },
};

function currentPipelineCopy(render: Render) {
  const stage =
    typeof render.placement?.pipelineStage === "string"
      ? render.placement.pipelineStage
      : "inspecting_scene";
  return pipelineCopy[stage] ?? pipelineCopy.inspecting_scene!;
}

export function VisualizerStudio({
  embedded = false,
  catalogSession = false,
  initialProductId,
  merchantSlug,
}: {
  embedded?: boolean;
  catalogSession?: boolean;
  initialProductId?: string;
  merchantSlug?: string;
}) {
  const [step, setStep] = useState(1);
  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState(initialProductId ?? "");
  const [scene, setScene] = useState<Scene | null>(null);
  const [surface, setSurface] = useState("table");
  const [placementPoint, setPlacementPoint] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [render, setRender] = useState<Render | null>(null);
  const [beforePercent, setBeforePercent] = useState(48);
  const [credits, setCredits] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadStatus, setUploadStatus] = useState("Choisir une photo");
  const [error, setError] = useState("");

  const product = useMemo(
    () => products.find((item) => item.id === productId) ?? null,
    [products, productId],
  );
  const pendingRenderId = render?.status === "processing" ? render.id : null;

  useEffect(() => {
    async function load() {
      if (catalogSession) {
        await establishGuestEditorSession();
      } else if (merchantSlug && initialProductId) {
        await establishPublicSession(merchantSlug, initialProductId);
      }
      const [availableProducts, wallet] = await Promise.all([
        getProducts(),
        api<{ balance: number }>("/v1/credits"),
      ]);
      return { availableProducts, wallet };
    }

    void load()
      .then(({ availableProducts, wallet }) => {
        setProducts(availableProducts);
        const nextProductId =
          initialProductId || availableProducts[0]?.id || "";
        setProductId(nextProductId);
        const selected = availableProducts.find(
          (item) => item.id === nextProductId,
        );
        if (selected) setSurface(selected.placementType);
        setCredits(wallet.balance);
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : "API indisponible"),
      );
  }, [catalogSession, embedded, initialProductId, merchantSlug]);

  useEffect(() => {
    if (!pendingRenderId) return;
    const renderId = pendingRenderId;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let consecutiveFailures = 0;

    async function refreshRender() {
      try {
        const nextRender = await getRender(renderId);
        if (cancelled) return;
        consecutiveFailures = 0;
        setRender(nextRender);
        if (nextRender.status === "succeeded") {
          if (nextRender.creditCharged) {
            setCredits((value) => (value === null ? value : value - 1));
          }
          return;
        }
        if (nextRender.status === "failed") {
          setError(
            nextRender.error ??
              "Le rendu n’a pas abouti. Choisissez un autre endroit ou une autre photo.",
          );
          return;
        }
        timer = setTimeout(refreshRender, 3_000);
      } catch {
        if (cancelled) return;
        consecutiveFailures += 1;
        if (consecutiveFailures >= 5) {
          setError(
            "La finition continue en arrière-plan. Vérifiez le résultat dans quelques instants.",
          );
        }
        timer = setTimeout(refreshRender, 4_000);
      }
    }

    timer = setTimeout(refreshRender, 2_000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [pendingRenderId]);

  async function uploadRoom(file: File) {
    setBusy(true);
    setError("");
    try {
      setUploadStatus("Optimisation…");
      const preparedFile = await prepareImageForUpload(file);
      setUploadStatus("Envoi et analyse…");
      const form = new FormData();
      form.set("file", preparedFile);
      form.set("consent", "true");
      const created = await api<Scene>("/v1/scenes", {
        method: "POST",
        body: form,
      });
      const analysed = await api<Scene>(`/v1/scenes/${created.id}/analyse`, {
        method: "POST",
      });
      setScene(analysed);
      setPlacementPoint(null);
      setStep(2);
      await recordEvent("room_uploaded");
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Téléversement impossible",
      );
    } finally {
      setBusy(false);
      setUploadStatus("Choisir une photo");
    }
  }

  async function generate() {
    if (!scene || !product || !placementPoint) return;
    setBusy(true);
    setError("");
    try {
      const payload = {
        placement: {
          sceneId: scene.id,
          productId: product.id,
          mode: "guided",
          surfaceType: surface,
          xNormalized: placementPoint.x,
          yNormalized: placementPoint.y,
        },
        idempotencyKey: `web-${crypto.randomUUID()}`,
        quality: "high",
        fidelityMode: "catalog",
      };
      const result = await api<Render>("/v1/renders", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setRender(result);
      if (result.creditCharged) {
        setCredits((value) => (value === null ? value : value - 1));
      }
      setStep(3);
      await recordEvent(
        result.status === "succeeded" ? "render_succeeded" : "render_requested",
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Rendu impossible");
    } finally {
      setBusy(false);
    }
  }

  function placeMarker(event: MouseEvent<HTMLButtonElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = Math.max(
      0,
      Math.min(1, (event.clientX - bounds.left) / bounds.width),
    );
    const y = Math.max(
      0,
      Math.min(1, (event.clientY - bounds.top) / bounds.height),
    );
    setPlacementPoint({ x, y });
    void recordEvent("placement_point_selected");
  }

  async function recordEvent(event: string) {
    await api("/v1/analytics", {
      method: "POST",
      body: JSON.stringify({
        event,
        sessionId: "demo-session",
        productId: productId || null,
        properties: { embedded, step },
      }),
    }).catch(() => undefined);
  }

  return (
    <section
      className={`studio-shell ${embedded ? "embedded" : ""}`}
      data-step={step}
    >
      <header className="studio-head">
        <div>
          <span className="eyebrow">Simple, rapide, sans installation</span>
          <h1>Voyez l’objet chez vous.</h1>
          <p>
            Choisissez une photo, indiquez l’endroit, puis laissez l’IA faire.
          </p>
        </div>
        <div className="studio-meta">
          {!embedded && (
            <span className="credit-pill" aria-label="Crédits disponibles">
              <Sparkles size={14} /> {credits ?? "—"} crédits
            </span>
          )}
        </div>
      </header>

      <nav className="studio-steps" aria-label="Étapes du visualiseur">
        {["Photo", "Placement", "Résultat"].map((label, index) => (
          <button
            key={label}
            className={
              step === index + 1 ? "active" : step > index + 1 ? "done" : ""
            }
            onClick={() => step > index + 1 && setStep(index + 1)}
            disabled={step < index + 1}
          >
            <span>{step > index + 1 ? <Check size={14} /> : index + 1}</span>
            {label}
          </button>
        ))}
      </nav>

      {error && (
        <div className="studio-error" role="alert">
          {error}
        </div>
      )}

      <div className="studio-body">
        {step === 1 && (
          <div className="studio-grid intro-grid">
            <div className="studio-panel object-choice-panel">
              <span className="panel-index">1 — L’objet</span>
              <h2>Que voulez-vous essayer ?</h2>
              <p className="muted">
                Touchez simplement l’objet de votre choix.
              </p>
              <div className="product-options">
                {products.map((item) => (
                  <button
                    key={item.id}
                    className={
                      item.id === productId
                        ? "product-option selected"
                        : "product-option"
                    }
                    aria-pressed={item.id === productId}
                    onClick={() => {
                      setProductId(item.id);
                      setSurface(item.placementType);
                    }}
                  >
                    {item.cutoutUrl ? (
                      // The URL is returned by the trusted local API.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={item.cutoutUrl} alt="" />
                    ) : (
                      <ImagePlus />
                    )}
                    <span>
                      <strong>{item.name}</strong>
                      <small>
                        {item.widthCm} × {item.heightCm} cm · {item.material}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
              {product?.imageSourceUrl && (
                <p className="demo-image-credit">
                  Image de test :{" "}
                  <a
                    href={product.imageSourceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {product.imageCredit ?? "Wikimedia Commons"}
                  </a>
                </p>
              )}
            </div>
            <label className="upload-zone">
              <Upload size={32} />
              <span className="panel-index">2 — Votre pièce</span>
              <strong>Ajoutez une photo de la pièce</strong>
              <span>Prenez-la bien droite et avec assez de lumière.</span>
              <span className="button upload-button" aria-live="polite">
                {busy ? uploadStatus : "Choisir une photo"}
              </span>
              <span>JPEG, PNG ou WebP · 20 Mo maximum</span>
              <input
                type="file"
                aria-label="Photo de votre pièce"
                accept="image/jpeg,image/png,image/webp"
                disabled={busy || !product}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void uploadRoom(file);
                }}
              />
              <small>La photo est automatiquement allégée avant l’envoi.</small>
            </label>
          </div>
        )}

        {step === 2 && scene && (
          <div className="studio-grid settings-grid">
            <p className="mobile-placement-hint">
              Touchez la photo à l’endroit où poser l’objet.
            </p>
            <button
              type="button"
              className="room-preview marker-placement"
              aria-label="Placer le point rouge sur la pièce"
              onClick={placeMarker}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={scene.imageUrl} alt="Pièce téléversée" />
              {placementPoint && (
                <span
                  className="red-placement-dot"
                  data-testid="placement-dot"
                  style={{
                    left: `${placementPoint.x * 100}%`,
                    top: `${placementPoint.y * 100}%`,
                  }}
                />
              )}
            </button>
            <div className="studio-panel">
              <span className="panel-index">Étape 2 sur 3</span>
              <h2>Indiquez l’endroit.</h2>
              <p className="muted">
                Touchez la photo pour déplacer le point rouge, puis choisissez
                ce qui se trouve dessous.
              </p>
              <strong className="choice-label">L’objet sera posé sur :</strong>
              <div className="choice-grid">
                {["table", "nightstand", "shelf", "niche", "wall", "floor"].map(
                  (value) => (
                    <button
                      key={value}
                      className={surface === value ? "choice active" : "choice"}
                      onClick={() => setSurface(value)}
                    >
                      {value === "table"
                        ? "Table"
                        : value === "nightstand"
                          ? "Table de nuit"
                          : value === "shelf"
                            ? "Étagère"
                            : value === "niche"
                              ? "Niche"
                              : value === "wall"
                                ? "Mur"
                                : "Sol"}
                    </button>
                  ),
                )}
              </div>
              <div className="divider" />
              <div className="auto-placement-note">
                <Sparkles size={20} />
                <span>
                  <strong>L’IA s’occupe du reste</strong>
                  <small>
                    Elle adapte la taille à la distance et remplace
                    automatiquement l’objet déjà présent sous votre point.
                  </small>
                </span>
              </div>
              <Button
                onClick={() => void generate()}
                disabled={
                  busy || credits === null || credits < 1 || !placementPoint
                }
              >
                {busy ? (
                  <LoaderCircle className="spin" size={17} />
                ) : (
                  <Sparkles size={17} />
                )}
                {busy
                  ? "Création de votre aperçu…"
                  : !placementPoint
                    ? "Touchez d’abord la photo"
                    : credits === 0
                      ? "Aucun crédit disponible"
                      : "Créer mon aperçu · 1 crédit"}
                {!busy && <ArrowRight size={17} />}
              </Button>
              <button
                className="back-link"
                type="button"
                onClick={() => {
                  setScene(null);
                  setPlacementPoint(null);
                  setStep(1);
                }}
              >
                <ArrowLeft size={15} /> Choisir une autre photo
              </button>
            </div>
          </div>
        )}

        {step === 3 && scene && render && (
          <div className="result-layout">
            <div className="compare-frame">
              {render.resultUrl ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={render.resultUrl}
                    alt="Rendu avec le produit intégré"
                  />
                  <div
                    className="before-layer"
                    style={{
                      clipPath: `polygon(0 0, ${beforePercent}% 0, ${beforePercent}% 100%, 0 100%)`,
                    }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={scene.imageUrl} alt="Photo avant intégration" />
                  </div>
                  <span className="before-label">Avant</span>
                  <span className="after-label">Après</span>
                  <input
                    aria-label="Comparer avant et après"
                    className="compare-range"
                    type="range"
                    min="0"
                    max="100"
                    value={beforePercent}
                    onChange={(event) =>
                      setBeforePercent(Number(event.target.value))
                    }
                  />
                </>
              ) : (
                <div className="pipeline-waiting-visual">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={scene.imageUrl} alt="Photo en cours d’analyse" />
                  <div className="pipeline-waiting-overlay">
                    {render.status === "failed" ? (
                      <>
                        <strong>Rendu interrompu</strong>
                        <span>
                          {render.error ??
                            "Choisissez un autre endroit ou une photo plus claire."}
                        </span>
                      </>
                    ) : (
                      <>
                        <LoaderCircle className="spin" size={34} />
                        <strong>{currentPipelineCopy(render).title}</strong>
                        <span>{currentPipelineCopy(render).detail}</span>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
            <div className="result-summary card">
              <Badge
                tone={render.status === "succeeded" ? "positive" : "warning"}
              >
                {render.status === "processing" && (
                  <LoaderCircle className="spin refining-icon" size={14} />
                )}
                {render.status === "processing"
                  ? currentPipelineCopy(render).title
                  : render.status === "failed"
                    ? "Placement impossible"
                    : "Rendu contrôlé"}
              </Badge>
              <h2>
                {render.status === "processing"
                  ? "Nous avançons étape par étape."
                  : render.status === "failed"
                    ? "Nous préférons vous arrêter ici."
                    : "Voilà le résultat."}
              </h2>
              <p className="muted">
                {render.status === "processing"
                  ? currentPipelineCopy(render).detail
                  : render.status === "failed"
                    ? (render.error ??
                      "Choisissez un autre endroit ou fournissez une photo plus claire.")
                    : typeof render.placement?.rationale === "string"
                      ? render.placement.rationale
                      : "Placement, échelle et lumière choisis automatiquement à partir de la pièce et des dimensions du produit."}
              </p>
              {render.status === "succeeded" && render.resultUrl && (
                <div className="score-row">
                  <span>Score de fidélité</span>
                  <strong>
                    {Math.round(Number(render.qualityScore ?? 0) * 100)}%
                  </strong>
                </div>
              )}
              {render.status === "succeeded" && render.resultUrl && (
                <div className="result-actions">
                  <a
                    className="button"
                    href={product?.buyUrl ?? "#"}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => void recordEvent("add_to_cart_clicked")}
                  >
                    <ShoppingBag size={17} /> Acheter
                  </a>
                  <>
                    <a
                      className="button secondary"
                      href={render.resultUrl}
                      download
                      onClick={() => void recordEvent("result_downloaded")}
                    >
                      <Download size={17} /> Télécharger
                    </a>
                    <button
                      className="button secondary"
                      onClick={() => {
                        void navigator.share?.({
                          title: "Mon aperçu déco",
                          url: render.resultUrl ?? undefined,
                        });
                        void recordEvent("result_shared");
                      }}
                    >
                      <Share2 size={17} /> Partager
                    </button>
                  </>
                </div>
              )}
              {render.status !== "processing" && (
                <button
                  className="back-link"
                  onClick={() => {
                    setRender(null);
                    setStep(2);
                  }}
                >
                  <ArrowLeft size={15} /> Essayer un autre endroit
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
