"use client";

import { useEffect, useMemo, useState } from "react";
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
    if (!scene || !product) return;
    setBusy(true);
    setError("");
    try {
      const payload = {
        placement: {
          sceneId: scene.id,
          productId: product.id,
          mode: "auto",
          surfaceType: surface,
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
    <section className={`studio-shell ${embedded ? "embedded" : ""}`}>
      <header className="studio-head">
        <div>
          <span className="eyebrow">Studio de visualisation</span>
          <h1>Voyez l’objet dans votre intérieur.</h1>
        </div>
        <div className="studio-meta">
          <Badge tone="positive">Placement IA</Badge>
          {!embedded && (
            <span className="credit-pill">
              <Sparkles size={14} /> {credits ?? "—"} crédits
            </span>
          )}
        </div>
      </header>

      <nav className="studio-steps" aria-label="Étapes du visualiseur">
        {["Pièce", "Support", "Résultat"].map((label, index) => (
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
            <div className="studio-panel">
              <span className="panel-index">01</span>
              <h2>Choisissez l’objet</h2>
              <p className="muted">
                Le produit catalogue reste protégé pendant l’intégration.
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
                        {item.widthCm} × {item.heightCm} cm
                      </small>
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <label className="upload-zone">
              <Upload size={32} />
              <strong>Ajoutez une photo de votre pièce</strong>
              <span>
                JPEG, PNG ou WebP · jusqu’à 20 Mo · optimisation automatique
              </span>
              <span className="button">
                {busy ? uploadStatus : "Choisir une photo"}
              </span>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                disabled={busy || !product}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void uploadRoom(file);
                }}
              />
              <small>
                En continuant, vous consentez au traitement. Suppression
                automatique sous 24 h.
              </small>
            </label>
          </div>
        )}

        {step === 2 && scene && (
          <div className="studio-grid settings-grid">
            <div className="room-preview">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={scene.imageUrl} alt="Pièce téléversée" />
              <div className="surface-guide" data-surface={surface}>
                <span>
                  {surface === "wall" ? "Zone murale" : "Surface de pose"}
                </span>
              </div>
            </div>
            <div className="studio-panel">
              <span className="panel-index">02</span>
              <h2>Choisissez le support</h2>
              <p className="muted">
                Indiquez seulement où l’objet peut être posé. L’IA analyse la
                photo et décide de la zone libre, de l’échelle, de la
                perspective et de la lumière.
              </p>
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
                  <strong>Placement automatique</strong>
                  <small>
                    L’objet sera placé une seule fois, sans superposition, en
                    respectant ses dimensions réelles et les instructions du
                    catalogue.
                  </small>
                </span>
              </div>
              <Button
                onClick={() => void generate()}
                disabled={busy || !credits}
              >
                {busy ? (
                  <LoaderCircle className="spin" size={17} />
                ) : (
                  <Sparkles size={17} />
                )}
                {busy
                  ? "Analyse et intégration en cours…"
                  : "Choisir le placement et générer · 1 crédit"}
                {!busy && <ArrowRight size={17} />}
              </Button>
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
              <h2>Il trouve sa place.</h2>
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
                <ArrowLeft size={15} /> Changer le support
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
