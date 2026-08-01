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
import { api, establishPublicSession, getProducts } from "@/lib/api";
import { prepareImageForUpload } from "@/lib/client-image";

interface Scene {
  id: string;
  status: string;
  imageUrl: string;
  widthPx: number;
  heightPx: number;
  analysis: Record<string, unknown>;
}

export function VisualizerStudio({
  embedded = false,
  initialProductId,
  merchantSlug,
}: {
  embedded?: boolean;
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

  useEffect(() => {
    async function load() {
      if (merchantSlug && initialProductId) {
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
  }, [embedded, initialProductId, merchantSlug]);

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
        quality: "medium",
        fidelityMode: "catalog",
      };
      const result = await api<Render>("/v1/renders", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setRender(result);
      setCredits((value) =>
        value === null ? value : value - (result.creditCharged ? 1 : 0),
      );
      setStep(3);
      await recordEvent(
        result.status === "succeeded" ? "render_succeeded" : "render_failed",
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
                    Elle adapte automatiquement la taille, la perspective,
                    l’ombre et la lumière sans modifier votre pièce.
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

        {step === 3 && scene && render?.resultUrl && (
          <div className="result-layout">
            <div className="compare-frame">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={render.resultUrl} alt="Rendu avec le produit intégré" />
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
            </div>
            <div className="result-summary card">
              <Badge tone="positive">Rendu accepté</Badge>
              <h2>Voilà le résultat.</h2>
              <p className="muted">
                {typeof render.placement?.rationale === "string"
                  ? render.placement.rationale
                  : "Placement, échelle et lumière choisis automatiquement à partir de la pièce et des dimensions du produit."}
              </p>
              <div className="score-row">
                <span>Score de fidélité</span>
                <strong>
                  {Math.round(Number(render.qualityScore ?? 0) * 100)}%
                </strong>
              </div>
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
              </div>
              <button
                className="back-link"
                onClick={() => {
                  setRender(null);
                  setStep(2);
                }}
              >
                <ArrowLeft size={15} /> Essayer un autre endroit
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
