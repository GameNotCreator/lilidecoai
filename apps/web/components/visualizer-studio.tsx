"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Download,
  ImagePlus,
  LoaderCircle,
  Move,
  Ruler,
  Share2,
  ShoppingBag,
  Sparkles,
  Upload,
} from "lucide-react";
import type { Product, Render } from "@lili/types";
import { Badge, Button } from "@lili/ui";
import { api, establishPublicSession, getProducts } from "@/lib/api";
import { PlacementCanvas, type PlacementState } from "./placement-canvas";

interface Scene {
  id: string;
  status: string;
  imageUrl: string;
  widthPx: number;
  heightPx: number;
  analysis: Record<string, unknown>;
}

interface Calibration {
  id: string;
  mode: "quick" | "wall" | "surface";
  label: string;
}

const initialPlacement: PlacementState = {
  x: 0.5,
  y: 0.78,
  scale: 0.22,
  rotation: 0,
};

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
  const [calibrationMode, setCalibrationMode] = useState<
    "quick" | "wall" | "surface"
  >("quick");
  const [calibration, setCalibration] = useState<Calibration | null>(null);
  const [referenceCm, setReferenceCm] = useState(100);
  const [placement, setPlacement] = useState(initialPlacement);
  const [lighting, setLighting] = useState("neutral");
  const [render, setRender] = useState<Render | null>(null);
  const [beforePercent, setBeforePercent] = useState(48);
  const [credits, setCredits] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const product = useMemo(
    () => products.find((item) => item.id === productId) ?? null,
    [products, productId],
  );

  useEffect(() => {
    async function load() {
      if (embedded && merchantSlug && initialProductId) {
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
        setProductId((current) => current || availableProducts[0]?.id || "");
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
      const form = new FormData();
      form.set("file", file);
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
    }
  }

  async function calibrate() {
    if (!scene) return;
    setBusy(true);
    setError("");
    try {
      const parameters =
        calibrationMode === "wall"
          ? {
              start: { x: 0.25, y: 0.68 },
              end: { x: 0.75, y: 0.68 },
              realLengthCm: referenceCm,
            }
          : calibrationMode === "surface"
            ? {
                corners: [
                  { x: 0.18, y: 0.62 },
                  { x: 0.82, y: 0.62 },
                  { x: 0.9, y: 0.84 },
                  { x: 0.1, y: 0.84 },
                ],
                widthCm: referenceCm,
                depthCm: Math.max(30, Math.round(referenceCm * 0.6)),
              }
            : {};
      const value = await api<Calibration>(`/v1/scenes/${scene.id}/calibrate`, {
        method: "POST",
        body: JSON.stringify({ mode: calibrationMode, parameters }),
      });
      setCalibration(value);
      setStep(3);
      await recordEvent("calibration_completed");
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Calibration impossible",
      );
    } finally {
      setBusy(false);
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
          calibrationId: calibration?.id,
          mode: calibrationMode,
          xNormalized: placement.x,
          yNormalized: placement.y,
          scale: placement.scale,
          rotationDegrees: placement.rotation,
          lighting: {
            direction: "left",
            temperature: lighting,
            hardness: lighting === "dramatic" ? "hard" : "soft",
          },
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
      setStep(4);
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
          <Badge tone={calibration?.mode === "quick" ? "warning" : "positive"}>
            {calibration?.label ?? "Échelle estimée"}
          </Badge>
          {!embedded && (
            <span className="credit-pill">
              <Sparkles size={14} /> {credits ?? "—"} crédits
            </span>
          )}
        </div>
      </header>

      <nav className="studio-steps" aria-label="Étapes du visualiseur">
        {["Pièce", "Surface", "Placement", "Résultat"].map((label, index) => (
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
          {error}. Vérifiez la connexion MongoDB et les variables Vercel.
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
                    onClick={() => setProductId(item.id)}
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
              <span>JPEG, PNG ou WebP · 4 Mo max · min. 320 px</span>
              <span className="button">
                {busy ? "Analyse…" : "Choisir une photo"}
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
              <h2>Surface & échelle</h2>
              <p className="muted">
                Les suggestions locales restent entièrement modifiables.
              </p>
              <div className="choice-grid">
                {["table", "shelf", "wall", "floor"].map((value) => (
                  <button
                    key={value}
                    className={surface === value ? "choice active" : "choice"}
                    onClick={() => setSurface(value)}
                  >
                    {value === "table"
                      ? "Table"
                      : value === "shelf"
                        ? "Étagère"
                        : value === "wall"
                          ? "Mur"
                          : "Sol"}
                  </button>
                ))}
              </div>
              <div className="divider" />
              <div className="mode-cards">
                <button
                  className={
                    calibrationMode === "quick"
                      ? "mode-card active"
                      : "mode-card"
                  }
                  onClick={() => setCalibrationMode("quick")}
                >
                  <Move size={19} />
                  <span>
                    <strong>Mode rapide</strong>
                    <small>Échelle visuelle estimée</small>
                  </span>
                </button>
                <button
                  className={
                    calibrationMode === "wall"
                      ? "mode-card active"
                      : "mode-card"
                  }
                  onClick={() => setCalibrationMode("wall")}
                >
                  <Ruler size={19} />
                  <span>
                    <strong>Précision murale</strong>
                    <small>Segment de longueur connue</small>
                  </span>
                </button>
                <button
                  className={
                    calibrationMode === "surface"
                      ? "mode-card active"
                      : "mode-card"
                  }
                  onClick={() => setCalibrationMode("surface")}
                >
                  <Ruler size={19} />
                  <span>
                    <strong>Précision surface</strong>
                    <small>Homographie à quatre coins</small>
                  </span>
                </button>
              </div>
              {calibrationMode !== "quick" && (
                <div className="field">
                  <label htmlFor="reference">
                    Longueur réelle de référence
                  </label>
                  <div className="unit-input">
                    <input
                      id="reference"
                      type="number"
                      min={10}
                      max={1000}
                      value={referenceCm}
                      onChange={(event) =>
                        setReferenceCm(Number(event.target.value))
                      }
                    />
                    <span>cm</span>
                  </div>
                </div>
              )}
              <Button onClick={() => void calibrate()} disabled={busy}>
                {busy ? <LoaderCircle className="spin" size={17} /> : null}
                Valider la surface <ArrowRight size={17} />
              </Button>
            </div>
          </div>
        )}

        {step === 3 && scene && product?.cutoutUrl && (
          <div className="studio-grid editor-grid">
            <PlacementCanvas
              sceneUrl={scene.imageUrl}
              productUrl={product.cutoutUrl}
              value={placement}
              onChange={(value) => {
                setPlacement(value);
                void recordEvent("placement_adjusted");
              }}
            />
            <div className="studio-panel">
              <span className="panel-index">03</span>
              <h2>Ajustez le placement</h2>
              <p className="muted">
                Glissez l’objet. Utilisez les poignées pour l’échelle et la
                rotation.
              </p>
              <div className="measure-card">
                <div>
                  <span>Dimensions réelles</span>
                  <strong>
                    {product.widthCm} × {product.heightCm} cm
                  </strong>
                </div>
                <Badge
                  tone={calibrationMode === "quick" ? "warning" : "positive"}
                >
                  {calibrationMode === "quick" ? "estimée" : "calibrée"}
                </Badge>
              </div>
              <div className="field">
                <label htmlFor="scale">Taille à l’écran</label>
                <input
                  id="scale"
                  type="range"
                  min="0.06"
                  max="0.6"
                  step="0.01"
                  value={placement.scale}
                  onChange={(event) =>
                    setPlacement({
                      ...placement,
                      scale: Number(event.target.value),
                    })
                  }
                />
              </div>
              <div className="field">
                <label htmlFor="light">Ambiance lumineuse</label>
                <select
                  id="light"
                  value={lighting}
                  onChange={(event) => setLighting(event.target.value)}
                >
                  <option value="neutral">Naturelle neutre</option>
                  <option value="warm">Fin de journée chaude</option>
                  <option value="cool">Lumière nord douce</option>
                  <option value="dramatic">Contraste marqué</option>
                </select>
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
                {busy ? "Intégration en cours…" : "Générer l’aperçu · 1 crédit"}
              </Button>
              <button className="back-link" onClick={() => setStep(2)}>
                <ArrowLeft size={15} /> Modifier la calibration
              </button>
            </div>
          </div>
        )}

        {step === 4 && scene && render?.resultUrl && (
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
                Produit protégé, échelle{" "}
                {calibrationMode === "quick" ? "estimée" : "calibrée"} et
                intégration lumineuse contrôlée.
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
                  setStep(3);
                }}
              >
                <ArrowLeft size={15} /> Ajuster le placement
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
