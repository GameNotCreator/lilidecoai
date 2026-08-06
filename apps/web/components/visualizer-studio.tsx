"use client";

import type { Product, Render } from "@lili/types";
import { Badge, Button } from "@lili/ui";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Download,
  ImagePlus,
  LoaderCircle,
  RefreshCw,
  Share2,
  ShoppingBag,
  Sparkles,
  Upload,
} from "lucide-react";
import { type MouseEvent, useEffect, useMemo, useState } from "react";

import {
  api,
  establishGuestEditorSession,
  establishPublicSession,
  getProducts,
  getRender,
} from "@/lib/api";
import { prepareImageForUpload } from "@/lib/client-image";
import { MaskEditor } from "./mask-editor";

interface Scene {
  id: string;
  status: string;
  imageUrl: string;
  widthPx: number;
  heightPx: number;
  analysis: Record<string, unknown>;
}

interface Segmentation {
  id: string;
  status: "proposed" | "confirmed";
  label: string;
  confidence: number;
  box: { xMin: number; yMin: number; xMax: number; yMax: number };
  maskUrl: string;
}

interface PlacementPreparation {
  mode: "insert" | "replace";
  surfaceType: string;
  placementPoint: { x: number; y: number };
  targetPoint?: { x: number; y: number };
  targetLabel?: string;
  confidence: number;
  needsClarification: boolean;
  rationale: string;
  segmentation?: Segmentation;
}

interface PreparedRenderInput {
  mode: "insert" | "replace";
  surfaceType: string;
  placementPoint: { x: number; y: number };
  targetPoint?: { x: number; y: number };
  targetMaskId?: string;
  outputQuality: "preview" | "final";
}

const pipelineCopy: Record<string, { title: string; detail: string }> = {
  uploaded: {
    title: "Photo reçue…",
    detail: "Nous préparons une copie sécurisée de votre pièce.",
  },
  analyzing_scene: {
    title: "Analyse de la pièce…",
    detail: "Perspective, support, lumière et obstacles sont étudiés.",
  },
  inspecting_scene: {
    title: "Analyse de la zone…",
    detail: "Nous vérifions le support et ce qui occupe le point.",
  },
  segmenting_target: {
    title: "Sélection de l’objet…",
    detail: "Nous isolons précisément l’élément que vous avez touché.",
  },
  removing_target: {
    title: "Suppression de l’ancien objet…",
    detail: "Le fond caché est reconstruit avant d’ajouter le nouveau produit.",
  },
  removing_obstacle: {
    title: "Suppression de l’ancien objet…",
    detail: "Le fond caché est reconstruit avant d’ajouter le nouveau produit.",
  },
  analyzing_cleaned_scene: {
    title: "Nouvelle lecture de l’espace…",
    detail: "La perspective est recalculée sur la zone maintenant dégagée.",
  },
  computing_geometry: {
    title: "Calcul des dimensions…",
    detail: "La taille et le contact sont adaptés à la perspective réelle.",
  },
  validating_fit: {
    title: "Vérification de la taille…",
    detail: "Nous contrôlons que le produit tient entièrement dans la zone.",
  },
  building_prompt: {
    title: "Préparation du rendu…",
    detail: "Toutes les vues et contraintes du produit sont assemblées.",
  },
  composing_preview: {
    title: "Placement du produit…",
    detail: "La position et l’échelle calculées sont appliquées à la photo.",
  },
  generating_preview: {
    title: "Création de l’aperçu…",
    detail: "Nano Banana 2 compose une prévisualisation rapide.",
  },
  generating_final: {
    title: "Création du rendu final…",
    detail: "Nano Banana Pro affine matière, lumière et perspective.",
  },
  refining_final: {
    title: "Finition photoréaliste…",
    detail: "Les ombres, la lumière et les textures sont harmonisées.",
  },
  quality_check: {
    title: "Contrôle du réalisme…",
    detail: "Fidélité, doublons, contact et décor sont vérifiés.",
  },
  retrying: {
    title: "Correction ciblée…",
    detail: "Une anomalie précise est corrigée une dernière fois.",
  },
};

function currentPipelineCopy(render: Render) {
  const stage =
    render.pipelineState ??
    (typeof render.placement?.pipelineStage === "string"
      ? render.placement.pipelineStage
      : "analyzing_scene");
  return pipelineCopy[stage] ?? pipelineCopy.analyzing_scene!;
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
  const [surface, setSurface] = useState("tabletop");
  const [renderMode, setRenderMode] = useState<"insert" | "replace">("insert");
  const [outputQuality, setOutputQuality] = useState<"preview" | "final">(
    "final",
  );
  const [placementPoint, setPlacementPoint] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [targetPoint, setTargetPoint] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [segmentation, setSegmentation] = useState<Segmentation | null>(null);
  const [render, setRender] = useState<Render | null>(null);
  const [beforePercent, setBeforePercent] = useState(48);
  const [credits, setCredits] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadStatus, setUploadStatus] = useState("Choisir une photo");
  const [userInstructions, setUserInstructions] = useState("");
  const [manualPlacement, setManualPlacement] = useState(false);
  const [feedbackSent, setFeedbackSent] = useState(false);
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
        if (selected) setSurface(toSurfaceType(selected.placementType));
        setCredits(wallet.balance);
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : "API indisponible"),
      );
  }, [catalogSession, initialProductId, merchantSlug]);

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
              "Le rendu n’a pas abouti. Choisissez une autre zone ou une photo plus claire.",
          );
          return;
        }
        timer = setTimeout(refreshRender, 2_500);
      } catch {
        if (cancelled) return;
        consecutiveFailures += 1;
        if (consecutiveFailures >= 5) {
          setError(
            "Le rendu continue en arrière-plan. Revenez dans quelques instants.",
          );
        }
        timer = setTimeout(refreshRender, 4_000);
      }
    }

    timer = setTimeout(refreshRender, 1_500);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [pendingRenderId]);

  async function uploadRoom(file: File) {
    setBusy(true);
    setError("");
    try {
      if (catalogSession) {
        await establishGuestEditorSession();
      } else if (merchantSlug && initialProductId) {
        await establishPublicSession(merchantSlug, initialProductId);
      }
      setUploadStatus("Optimisation…");
      const preparedFile = await prepareImageForUpload(file);
      setUploadStatus("Envoi sécurisé…");
      const form = new FormData();
      form.set("file", preparedFile);
      form.set("consent", "true");
      const created = await api<Scene>("/v1/scenes", {
        method: "POST",
        body: form,
      });
      setScene(created);
      setPlacementPoint(null);
      setTargetPoint(null);
      setSegmentation(null);
      setManualPlacement(false);
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

  function pointFromEvent(event: MouseEvent<HTMLButtonElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    };
  }

  function placeMarker(event: MouseEvent<HTMLButtonElement>) {
    const point = pointFromEvent(event);
    setPlacementPoint(point);
    if (renderMode === "replace") {
      setTargetPoint(point);
      void segmentTarget(point);
    }
    void recordEvent("placement_point_selected");
  }

  async function segmentTarget(point: { x: number; y: number }) {
    if (!scene) return;
    setBusy(true);
    setError("");
    setSegmentation(null);
    try {
      const result = await api<Segmentation>(`/v1/scenes/${scene.id}/segment`, {
        method: "POST",
        body: JSON.stringify({ point }),
      });
      setSegmentation(result);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Impossible d’isoler cet objet.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function confirmMask(mask: Blob) {
    if (!scene || !segmentation) return;
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.set(
        "file",
        new File([mask], "corrected-mask.png", { type: "image/png" }),
      );
      const confirmed = await api<Segmentation>(
        `/v1/scenes/${scene.id}/segments/${segmentation.id}/confirm`,
        { method: "POST", body: form },
      );
      setSegmentation(confirmed);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Confirmation du masque impossible.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function requestRender(
    prepared: PreparedRenderInput,
  ): Promise<Render> {
    if (!scene || !product) throw new Error("Photos introuvables");
    return api<Render>(`/v1/renders/${prepared.outputQuality}`, {
      method: "POST",
      body: JSON.stringify({
        mode: prepared.mode,
        placement: {
          sceneId: scene.id,
          productId: product.id,
          mode: prepared.mode,
          surfaceType:
            prepared.mode === "replace"
              ? "existing_object"
              : prepared.surfaceType,
          xNormalized: prepared.placementPoint.x,
          yNormalized: prepared.placementPoint.y,
        },
        placementPoint: prepared.placementPoint,
        ...(prepared.targetPoint ? { targetPoint: prepared.targetPoint } : {}),
        ...(prepared.targetMaskId
          ? { targetMaskId: prepared.targetMaskId }
          : {}),
        surfaceType:
          prepared.mode === "replace"
            ? "existing_object"
            : prepared.surfaceType,
        idempotencyKey: `web-${crypto.randomUUID()}`,
        outputQuality: prepared.outputQuality,
        quality: prepared.outputQuality === "preview" ? "low" : "high",
        preserveBackground: true,
        userInstructions:
          userInstructions.trim() ||
          "Place ce produit à l’endroit le plus naturel et réaliste.",
      }),
    });
  }

  async function generate() {
    if (!scene || !product || !placementPoint) return;
    setBusy(true);
    setError("");
    try {
      const result = await requestRender({
        mode: renderMode,
        surfaceType: surface,
        placementPoint,
        ...(targetPoint ? { targetPoint } : {}),
        ...(segmentation?.status === "confirmed"
          ? { targetMaskId: segmentation.id }
          : {}),
        outputQuality,
      });
      setRender(result);
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

  async function generateFromInstruction() {
    if (!scene || !product) return;
    setBusy(true);
    setError("");
    try {
      const prepared = await api<PlacementPreparation>(
        `/v1/scenes/${scene.id}/prepare`,
        {
          method: "POST",
          body: JSON.stringify({
            productId: product.id,
            instruction: userInstructions,
          }),
        },
      );
      setRenderMode(prepared.mode);
      setSurface(prepared.surfaceType);
      setPlacementPoint(prepared.placementPoint);
      setTargetPoint(prepared.targetPoint ?? null);
      setSegmentation(prepared.segmentation ?? null);
      if (prepared.needsClarification) {
        setManualPlacement(true);
        setError(
          "Je n’ai pas identifié la zone avec assez de certitude. Touchez simplement l’endroit sur la photo.",
        );
        return;
      }
      const result = await requestRender({
        mode: prepared.mode,
        surfaceType: prepared.surfaceType,
        placementPoint: prepared.placementPoint,
        ...(prepared.targetPoint ? { targetPoint: prepared.targetPoint } : {}),
        ...(prepared.segmentation
          ? { targetMaskId: prepared.segmentation.id }
          : {}),
        outputQuality: "final",
      });
      setRender(result);
      setOutputQuality("final");
      setStep(3);
      await recordEvent("natural_language_render_requested");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Je n’ai pas pu comprendre la demande.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function retryRender() {
    if (!render) return;
    setBusy(true);
    setError("");
    try {
      const retried = await api<Render>(`/v1/renders/${render.id}/retry`, {
        method: "POST",
      });
      setRender(retried);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Nouvel essai impossible",
      );
    } finally {
      setBusy(false);
    }
  }

  async function sendFeedback(rating: number) {
    if (!render) return;
    await api(`/v1/renders/${render.id}/feedback`, {
      method: "POST",
      body: JSON.stringify({ rating }),
    });
    setFeedbackSent(true);
  }

  async function recordEvent(event: string) {
    await api("/v1/analytics", {
      method: "POST",
      body: JSON.stringify({
        event,
        sessionId: "demo-session",
        productId: productId || null,
        properties: { embedded, step, renderMode, outputQuality },
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
          <span className="eyebrow">Aussi simple qu’un message</span>
          <h1>Montrez. Demandez. Visualisez.</h1>
          <p>Un produit, une photo de votre pièce et une phrase. C’est tout.</p>
        </div>
        {!embedded && (
          <span className="credit-pill" aria-label="Crédits disponibles">
            <Sparkles size={14} /> {credits ?? "—"} crédits
          </span>
        )}
      </header>

      <nav className="studio-steps" aria-label="Étapes du visualiseur">
        {["Photos", "Demande", "Résultat"].map((label, index) => (
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
                      setSurface(toSurfaceType(item.placementType));
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
              {product && product.views.length <= 1 && (
                <p className="single-view-warning">
                  Certains angles non visibles seront estimés par l’intelligence
                  artificielle.
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

        {step === 2 && scene && !manualPlacement && (
          <div className="studio-grid ai-request-grid">
            <div className="ai-room-preview">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={scene.imageUrl} alt="Votre pièce" />
              <span>Votre pièce</span>
            </div>
            <div className="studio-panel ai-request-panel">
              <span className="panel-index">Votre demande</span>
              <h2>Dites simplement ce que vous voulez.</h2>
              <p className="muted">
                L’intelligence artificielle trouvera seule l’objet, le support,
                la taille et la perspective.
              </p>

              <div className="ai-attachments" aria-label="Images fournies">
                <div className="ai-attachment">
                  {product?.cutoutUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={product.cutoutUrl} alt={product.name} />
                  ) : (
                    <ImagePlus size={24} />
                  )}
                  <span>
                    <small>Produit</small>
                    <strong>{product?.name}</strong>
                  </span>
                  <Check size={16} />
                </div>
                <div className="ai-attachment">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={scene.imageUrl} alt="Pièce à modifier" />
                  <span>
                    <small>Pièce</small>
                    <strong>Votre photo</strong>
                  </span>
                  <Check size={16} />
                </div>
              </div>

              <label className="ai-instruction-field">
                <span>Que voulez-vous faire ?</span>
                <textarea
                  aria-label="Votre demande"
                  value={userInstructions}
                  maxLength={1500}
                  rows={4}
                  autoFocus
                  placeholder="Ex. Place le vase sur l’étagère"
                  onChange={(event) => setUserInstructions(event.target.value)}
                />
              </label>
              <p className="ai-example-copy">
                Vous pouvez écrire naturellement : « sur l’étagère », « au
                centre de la table » ou laisser le champ vide pour que l’IA
                choisisse.
              </p>

              <Button
                onClick={() => void generateFromInstruction()}
                disabled={busy || credits === null || credits < 1 || !product}
              >
                {busy ? (
                  <LoaderCircle className="spin" size={18} />
                ) : (
                  <Sparkles size={18} />
                )}
                {busy
                  ? "Je comprends votre demande…"
                  : credits === 0
                    ? "Aucun crédit disponible"
                    : "Créer le rendu · 1 crédit"}
                {!busy && <ArrowRight size={18} />}
              </Button>

              <div className="ai-hidden-work">
                <Sparkles size={18} />
                <span>
                  <strong>Tout est automatique</strong>
                  <small>
                    Analyse de la zone, échelle, perspective, ombres et contrôle
                    du réalisme sont effectués en arrière-plan.
                  </small>
                </span>
              </div>

              <button
                className="back-link ai-manual-link"
                type="button"
                onClick={() => {
                  setError("");
                  setManualPlacement(true);
                }}
              >
                Je préfère indiquer précisément l’endroit
              </button>
              <button
                className="back-link"
                type="button"
                onClick={() => {
                  setScene(null);
                  setPlacementPoint(null);
                  setTargetPoint(null);
                  setSegmentation(null);
                  setStep(1);
                }}
              >
                <ArrowLeft size={15} /> Changer les photos
              </button>
            </div>
          </div>
        )}

        {step === 2 && scene && manualPlacement && (
          <div className="studio-grid settings-grid">
            <p className="mobile-placement-hint">
              {renderMode === "replace"
                ? "Touchez précisément l’élément présent à cet endroit."
                : "Touchez l’endroit où poser le produit."}
            </p>
            {renderMode === "replace" && segmentation ? (
              <MaskEditor
                imageUrl={scene.imageUrl}
                maskUrl={segmentation.maskUrl}
                busy={busy}
                confirmed={segmentation.status === "confirmed"}
                onConfirm={confirmMask}
                onReset={() => {
                  setSegmentation(null);
                  setPlacementPoint(null);
                  setTargetPoint(null);
                }}
              />
            ) : (
              <button
                type="button"
                className="room-preview marker-placement"
                aria-label={
                  renderMode === "replace"
                    ? "Sélectionner l’élément présent"
                    : "Placer le point rouge sur la pièce"
                }
                onClick={placeMarker}
                disabled={busy}
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
                {busy && renderMode === "replace" && (
                  <span className="segmenting-indicator">
                    <LoaderCircle className="spin" size={20} /> Sélection en
                    cours…
                  </span>
                )}
              </button>
            )}
            <div className="studio-panel placement-panel">
              <span className="panel-index">Étape 2 sur 3</span>
              <h2>Indiquez l’endroit.</h2>
              <p className="muted">
                Touchez simplement la photo. Si la zone est occupée, l’IA la
                préparera automatiquement.
              </p>

              {renderMode === "insert" ? (
                <>
                  <strong className="choice-label">
                    Le produit sera posé sur :
                  </strong>
                  <div className="choice-grid">
                    {surfaceChoices.map(([value, label]) => (
                      <button
                        type="button"
                        key={value}
                        className={
                          surface === value ? "choice active" : "choice"
                        }
                        onClick={() => setSurface(value)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <div className="mask-status-copy">
                  <strong>
                    {segmentation?.status === "confirmed"
                      ? `${segmentation.label} correctement sélectionné`
                      : segmentation
                        ? "Corrigez la zone rouge si nécessaire"
                        : "Touchez l’objet dans la photo"}
                  </strong>
                  <small>Rien ne sera généré avant votre confirmation.</small>
                </div>
              )}

              <div
                className="quality-choice"
                role="group"
                aria-label="Qualité du rendu"
              >
                <button
                  type="button"
                  className={outputQuality === "preview" ? "active" : ""}
                  onClick={() => setOutputQuality("preview")}
                >
                  <strong>Aperçu rapide</strong>
                  <small>Nano Banana 2 · 1K</small>
                </button>
                <button
                  type="button"
                  className={outputQuality === "final" ? "active" : ""}
                  onClick={() => setOutputQuality("final")}
                >
                  <strong>Rendu final</strong>
                  <small>Nano Banana Pro · 2K</small>
                </button>
              </div>

              <details className="user-render-note">
                <summary>Ajouter une indication (facultatif)</summary>
                <textarea
                  value={userInstructions}
                  maxLength={1500}
                  rows={3}
                  placeholder="Ex. conserver le rideau devant le meuble…"
                  onChange={(event) => setUserInstructions(event.target.value)}
                />
              </details>

              <div className="auto-placement-note">
                <Sparkles size={20} />
                <span>
                  <strong>L’IA mesure et place pour vous</strong>
                  <small>
                    Échelle, perspective, contact et lumière sont calculés
                    automatiquement.
                  </small>
                </span>
              </div>
              <Button
                onClick={() => void generate()}
                disabled={
                  busy ||
                  credits === null ||
                  credits < 1 ||
                  !placementPoint ||
                  (renderMode === "replace" &&
                    segmentation?.status !== "confirmed")
                }
              >
                {busy ? (
                  <LoaderCircle className="spin" size={17} />
                ) : (
                  <Sparkles size={17} />
                )}
                {!placementPoint
                  ? renderMode === "replace"
                    ? "Touchez l’élément présent"
                    : "Touchez d’abord la photo"
                  : renderMode === "replace" &&
                      segmentation?.status !== "confirmed"
                    ? "Confirmez d’abord le masque"
                    : credits === 0
                      ? "Aucun crédit disponible"
                      : outputQuality === "preview"
                        ? "Créer mon aperçu · 1 crédit"
                        : "Créer le rendu final · 1 crédit"}
                {!busy && <ArrowRight size={17} />}
              </Button>
              <button
                className="back-link"
                type="button"
                onClick={() => {
                  setError("");
                  setManualPlacement(false);
                }}
              >
                <Sparkles size={15} /> Revenir à la demande simple
              </button>
              <button
                className="back-link"
                type="button"
                onClick={() => {
                  setScene(null);
                  setPlacementPoint(null);
                  setTargetPoint(null);
                  setSegmentation(null);
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
                            "Choisissez une autre zone ou une photo plus claire."}
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
                    ? (render.error ?? "Essayez une autre zone.")
                    : typeof render.placement?.rationale === "string"
                      ? render.placement.rationale
                      : "Placement, échelle et lumière calculés automatiquement."}
              </p>
              {render.status === "succeeded" && (
                <>
                  <div className="score-row">
                    <span>Score de fidélité</span>
                    <strong>
                      {Math.round(Number(render.qualityScore ?? 0) * 100)}%
                    </strong>
                  </div>
                  <div className="render-facts">
                    <span>
                      {render.placement?.perspective &&
                      typeof render.placement.perspective === "object" &&
                      "scale" in render.placement.perspective
                        ? "Dimensions calibrées"
                        : "Dimensions estimées"}
                    </span>
                    <span>{render.model}</span>
                    <span>
                      Coût estimé $
                      {Number(render.estimatedCostUsd ?? 0).toFixed(3)}
                    </span>
                  </div>
                </>
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
              )}
              {render.status === "succeeded" && !feedbackSent && (
                <div className="feedback-row">
                  <span>Ce rendu vous aide à choisir ?</span>
                  <button type="button" onClick={() => void sendFeedback(5)}>
                    Oui
                  </button>
                  <button type="button" onClick={() => void sendFeedback(1)}>
                    Non
                  </button>
                </div>
              )}
              {render.status !== "processing" && (
                <div className="result-secondary-actions">
                  <button
                    className="back-link"
                    type="button"
                    onClick={() => void retryRender()}
                  >
                    <RefreshCw size={15} /> Nouvelle tentative
                  </button>
                  <button
                    className="back-link"
                    type="button"
                    onClick={() => {
                      setRender(null);
                      setStep(2);
                    }}
                  >
                    <ArrowLeft size={15} /> Essayer un autre endroit
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );

}

const surfaceChoices: Array<[string, string]> = [
  ["tabletop", "Table"],
  ["shelf", "Étagère"],
  ["niche", "Niche"],
  ["wall", "Mur"],
  ["floor", "Sol"],
  ["rug_zone", "Zone tapis"],
  ["ceiling", "Plafond"],
];

function toSurfaceType(value: string): string {
  if (value === "table" || value === "nightstand") return "tabletop";
  return value;
}
