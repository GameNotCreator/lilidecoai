"use client";

import {
  ArrowLeft,
  ArrowRight,
  Check,
  ImagePlus,
  LoaderCircle,
  MapPin,
  RefreshCw,
  Ruler,
  Sparkles,
  Upload,
} from "lucide-react";
import { type MouseEvent, useEffect, useMemo, useState } from "react";
import type { Render } from "@lili/types";

import { api, establishGuestEditorSession, getRender } from "@/lib/api";
import { prepareImageForUpload } from "@/lib/client-image";

type DimensionAxis = "width" | "height";
type Step = 1 | 2 | 3;

interface PreparedProduct {
  id: string;
  name: string;
  cutoutUrl?: string | null;
  widthCm: number;
  heightCm: number;
  depthCm: number;
}

interface Scene {
  id: string;
  imageUrl: string;
  widthPx: number;
  heightPx: number;
}

interface Point {
  x: number;
  y: number;
}

const progressLabels = ["Votre objet", "Votre intérieur", "Résultat"];

export function SimpleDemoStudio() {
  const [step, setStep] = useState<Step>(1);
  const [ready, setReady] = useState(false);
  const [busyLabel, setBusyLabel] = useState("Préparation de la démo…");
  const [error, setError] = useState("");
  const [objectFile, setObjectFile] = useState<File | null>(null);
  const [objectPreview, setObjectPreview] = useState("");
  const [dimensionAxis, setDimensionAxis] =
    useState<DimensionAxis>("height");
  const [dimensionValue, setDimensionValue] = useState("");
  const [product, setProduct] = useState<PreparedProduct | null>(null);
  const [scene, setScene] = useState<Scene | null>(null);
  const [point, setPoint] = useState<Point | null>(null);
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [render, setRender] = useState<Render | null>(null);

  const busy = Boolean(busyLabel && ready);
  const dimensionCm = Number(dimensionValue);
  const pixelPoint = useMemo(() => {
    if (!point || !scene) return null;
    return {
      x: Math.round(point.x * scene.widthPx),
      y: Math.round(point.y * scene.heightPx),
    };
  }, [point, scene]);

  useEffect(() => {
    void establishGuestEditorSession()
      .then(() => {
        setReady(true);
        setBusyLabel("");
      })
      .catch((reason: unknown) => {
        setBusyLabel("");
        setError(
          reason instanceof Error
            ? reason.message
            : "Impossible de préparer la démo.",
        );
      });
  }, []);

  useEffect(
    () => () => {
      if (objectPreview) URL.revokeObjectURL(objectPreview);
    },
    [objectPreview],
  );

  useEffect(() => {
    if (!render || render.status !== "processing") return;
    const renderId = render.id;
    const timer = window.setInterval(() => {
      void getRender(renderId)
        .then((next) => {
          setRender(next);
          if (next.status !== "processing") window.clearInterval(timer);
        })
        .catch((reason: unknown) => {
          window.clearInterval(timer);
          setError(
            reason instanceof Error
              ? reason.message
              : "Impossible de suivre la génération.",
          );
        });
    }, 1600);
    return () => window.clearInterval(timer);
  }, [render]);

  async function prepareObject() {
    if (!objectFile || !Number.isFinite(dimensionCm) || dimensionCm <= 0) {
      setError("Ajoutez une image et indiquez une dimension valide.");
      return;
    }
    setError("");
    setBusyLabel("Préparation de l’objet…");
    try {
      await establishGuestEditorSession();
      const imageSize = await readImageSize(objectFile);
      const ratio = imageSize.width / Math.max(1, imageSize.height);
      const heightCm =
        dimensionAxis === "height" ? dimensionCm : dimensionCm / ratio;
      const widthCm =
        dimensionAxis === "width" ? dimensionCm : dimensionCm * ratio;
      const depthCm = Math.max(0.1, Math.min(widthCm, heightCm) * 0.4);
      const name = objectName(objectFile.name);
      const created = await api<PreparedProduct>("/v1/products", {
        method: "POST",
        body: JSON.stringify({
          temporary: true,
          name,
          description: "Objet fourni par l’utilisateur pour cette visualisation.",
          objectType: "other",
          widthCm: roundDimension(widthCm),
          heightCm: roundDimension(heightCm),
          depthCm: roundDimension(depthCm),
          material: "Matière visible sur la photo de référence",
          generationInstructions:
            "Conserver fidèlement la forme, les couleurs et tous les détails visibles.",
          placementType: "table",
          lightingProfile: {},
          buyUrl: null,
        }),
      });
      setBusyLabel("Envoi de l’image…");
      const preparedFile = await prepareImageForUpload(objectFile);
      const upload = new FormData();
      upload.set("file", preparedFile);
      upload.set("viewType", "front");
      await api(`/v1/products/${created.id}/assets`, {
        method: "POST",
        body: upload,
      });
      setBusyLabel("Détourage de l’objet…");
      const prepared = await api<PreparedProduct>(
        `/v1/products/${created.id}/prepare`,
        { method: "POST" },
      );
      await api(`/v1/products/${created.id}/anchor`, {
        method: "POST",
        body: JSON.stringify({
          anchorType: "bottom_center",
          xNormalized: 0.5,
          yNormalized: 1,
        }),
      });
      setProduct(prepared);
      setStep(2);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Objet impossible à préparer.",
      );
    } finally {
      setBusyLabel("");
    }
  }

  async function uploadRoom(file: File) {
    setError("");
    setBusyLabel("Envoi de la photo…");
    try {
      await establishGuestEditorSession();
      const prepared = await prepareImageForUpload(file);
      const form = new FormData();
      form.set("file", prepared);
      form.set("consent", "true");
      const created = await api<Scene>("/v1/scenes", {
        method: "POST",
        body: form,
      });
      setScene(created);
      setPoint(null);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Photo de l’intérieur impossible à envoyer.",
      );
    } finally {
      setBusyLabel("");
    }
  }

  function selectPoint(event: MouseEvent<HTMLButtonElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    setPoint({
      x: clamp((event.clientX - bounds.left) / bounds.width),
      y: clamp((event.clientY - bounds.top) / bounds.height),
    });
    setError("");
  }

  async function generate() {
    if (!product || !scene || !point) {
      setError("Ajoutez les deux images puis placez le point rouge.");
      return;
    }
    setError("");
    setBusyLabel("Lancement de GPT Image 2…");
    try {
      const mode = replaceExisting ? "replace" : "insert";
      const created = await api<Render>("/v1/renders/final", {
        method: "POST",
        body: JSON.stringify({
          workflow: "simple_point",
          mode,
          placement: {
            sceneId: scene.id,
            productId: product.id,
            mode,
            surfaceType: replaceExisting ? "existing_object" : "tabletop",
            xNormalized: point.x,
            yNormalized: point.y,
          },
          placementPoint: point,
          ...(replaceExisting ? { targetPoint: point } : {}),
          surfaceType: replaceExisting ? "existing_object" : "tabletop",
          dimensionReference: {
            axis: dimensionAxis,
            valueCm: dimensionCm,
          },
          outputQuality: "final",
          preserveBackground: true,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      setRender(created);
      setStep(3);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Génération impossible.",
      );
    } finally {
      setBusyLabel("");
    }
  }

  function reset() {
    if (objectPreview) URL.revokeObjectURL(objectPreview);
    setStep(1);
    setError("");
    setObjectFile(null);
    setObjectPreview("");
    setDimensionAxis("height");
    setDimensionValue("");
    setProduct(null);
    setScene(null);
    setPoint(null);
    setReplaceExisting(false);
    setRender(null);
    setBusyLabel("");
  }

  return (
    <section className="simple-demo" data-step={step}>
      <header className="simple-demo-head">
        <span className="simple-demo-kicker">Visualisation IA</span>
        <h1>Voyez votre objet chez vous.</h1>
        <p>Deux photos, une dimension et un point. C’est tout.</p>
      </header>

      <ol className="simple-demo-progress" aria-label="Étapes de la démo">
        {progressLabels.map((label, index) => {
          const number = (index + 1) as Step;
          return (
            <li
              key={label}
              className={
                number === step ? "active" : number < step ? "done" : ""
              }
            >
              <span>{number < step ? <Check size={16} /> : number}</span>
              <strong>{label}</strong>
            </li>
          );
        })}
      </ol>

      {error && (
        <div className="simple-demo-error" role="alert">
          {error}
        </div>
      )}

      {!ready && (
        <div className="simple-demo-loading" aria-live="polite">
          <LoaderCircle className="spin" size={22} /> Préparation de la démo…
        </div>
      )}

      {step === 1 && (
        <div className="simple-demo-card">
          <div className="simple-demo-title">
            <span>1</span>
            <div>
              <h2>Ajoutez l’objet à placer</h2>
              <p>Une photo nette où l’objet est visible en entier.</p>
            </div>
          </div>

          <label
            className={
              objectPreview
                ? "simple-upload simple-object-upload has-image"
                : "simple-upload simple-object-upload"
            }
          >
            {objectPreview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={objectPreview} alt="Objet à placer" />
            ) : (
              <>
                <ImagePlus size={34} />
                <strong>Choisir l’image de l’objet</strong>
                <span>PNG, JPG ou WebP · objet bien cadré</span>
              </>
            )}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              aria-label="Image de l’objet à placer"
              disabled={!ready || busy}
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                if (objectPreview) URL.revokeObjectURL(objectPreview);
                setObjectFile(file);
                setObjectPreview(file ? URL.createObjectURL(file) : "");
                setProduct(null);
                setError("");
              }}
            />
          </label>

          {objectPreview && (
            <label className="simple-replace-file">
              <Upload size={17} /> Changer l’image
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                aria-label="Changer l’image de l’objet"
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  if (!file) return;
                  if (objectPreview) URL.revokeObjectURL(objectPreview);
                  setObjectFile(file);
                  setObjectPreview(URL.createObjectURL(file));
                }}
              />
            </label>
          )}

          <div className="simple-dimension-block">
            <div className="simple-field-label">
              <Ruler size={19} />
              <div>
                <strong>Quelle dimension connaissez-vous ?</strong>
                <span>Mesurez l’objet au point le plus large.</span>
              </div>
            </div>
            <div className="simple-segmented" role="group" aria-label="Dimension">
              <button
                type="button"
                className={dimensionAxis === "width" ? "selected" : ""}
                aria-pressed={dimensionAxis === "width"}
                onClick={() => setDimensionAxis("width")}
              >
                Largeur
              </button>
              <button
                type="button"
                className={dimensionAxis === "height" ? "selected" : ""}
                aria-pressed={dimensionAxis === "height"}
                onClick={() => setDimensionAxis("height")}
              >
                Hauteur
              </button>
            </div>
            <label className="simple-unit-input">
              <span>{dimensionAxis === "height" ? "Hauteur" : "Largeur"}</span>
              <div>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0.1"
                  max="1500"
                  step="0.1"
                  value={dimensionValue}
                  aria-label={`${dimensionAxis === "height" ? "Hauteur" : "Largeur"} en centimètres`}
                  placeholder="Ex. 42"
                  onChange={(event) => setDimensionValue(event.target.value)}
                />
                <span>cm</span>
              </div>
            </label>
          </div>

          <button
            type="button"
            className="simple-demo-primary"
            disabled={!ready || busy || !objectFile || dimensionCm <= 0}
            onClick={() => void prepareObject()}
          >
            {busy ? <LoaderCircle className="spin" size={19} /> : null}
            {busy ? busyLabel : "Continuer"}
            {!busy && <ArrowRight size={19} />}
          </button>
        </div>
      )}

      {step === 2 && product && (
        <div className="simple-demo-card simple-room-card">
          <div className="simple-demo-title">
            <span>2</span>
            <div>
              <h2>Ajoutez la photo du lieu</h2>
              <p>Puis touchez exactement l’endroit où placer l’objet.</p>
            </div>
          </div>

          <div className="photo-guideline">
            <MapPin size={21} />
            <div>
              <strong>Reculez d’au moins 1,5 mètre.</strong>
              <span>
                Cadrez l’emplacement et le sol ou le support. Évitez le zoom et
                gardez le téléphone droit.
              </span>
            </div>
          </div>

          {!scene ? (
            <label className="simple-upload simple-room-upload">
              <ImagePlus size={34} />
              <strong>Choisir la photo du lieu</strong>
              <span>Prise à 1,5 m minimum · nette et bien éclairée</span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                aria-label="Photo du lieu de réception"
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void uploadRoom(file);
                }}
              />
            </label>
          ) : (
            <div className="point-picker-block">
              <div className="point-picker-heading">
                <div>
                  <strong>Placez le point rouge</strong>
                  <span>Touchez la surface ou l’objet concerné.</span>
                </div>
                <label>
                  <Upload size={16} /> Changer la photo
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    aria-label="Changer la photo du lieu"
                    disabled={busy}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void uploadRoom(file);
                    }}
                  />
                </label>
              </div>
              <button
                type="button"
                className="simple-point-picker"
                aria-label="Placer le point dans l’image"
                onClick={selectPoint}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={scene.imageUrl} alt="Lieu de réception" />
                {point && (
                  <span
                    className="simple-red-dot"
                    style={{
                      left: `${point.x * 100}%`,
                      top: `${point.y * 100}%`,
                    }}
                    data-testid="placement-dot"
                  />
                )}
              </button>
              <div className={point ? "point-coordinates ready" : "point-coordinates"}>
                {pixelPoint ? (
                  <>
                    <Check size={17} />
                    Point enregistré : x {pixelPoint.x} px · y {pixelPoint.y} px
                  </>
                ) : (
                  <>
                    <MapPin size={17} /> Touchez la photo pour choisir l’endroit
                  </>
                )}
              </div>
            </div>
          )}

          {scene && (
            <fieldset className="replacement-choice">
              <legend>Est-ce qu’on remplace un objet déjà présent ?</legend>
              <div>
                <label className={!replaceExisting ? "selected" : ""}>
                  <input
                    type="radio"
                    name="replacement"
                    checked={!replaceExisting}
                    onChange={() => setReplaceExisting(false)}
                  />
                  <span>
                    <strong>Non, ajouter l’objet</strong>
                    <small>L’espace choisi est libre.</small>
                  </span>
                </label>
                <label className={replaceExisting ? "selected" : ""}>
                  <input
                    type="radio"
                    name="replacement"
                    checked={replaceExisting}
                    onChange={() => setReplaceExisting(true)}
                  />
                  <span>
                    <strong>Oui, remplacer l’objet</strong>
                    <small>Le point rouge vise l’objet à supprimer.</small>
                  </span>
                </label>
              </div>
            </fieldset>
          )}

          <div className="simple-demo-actions">
            <button
              type="button"
              className="simple-demo-secondary"
              disabled={busy}
              onClick={() => setStep(1)}
            >
              <ArrowLeft size={18} /> Retour
            </button>
            <button
              type="button"
              className="simple-demo-primary"
              disabled={busy || !scene || !point}
              onClick={() => void generate()}
            >
              {busy ? (
                <LoaderCircle className="spin" size={19} />
              ) : (
                <Sparkles size={19} />
              )}
              {busy ? busyLabel : "Générer avec GPT Image 2"}
            </button>
          </div>
        </div>
      )}

      {step === 3 && scene && (
        <div className="simple-demo-card simple-result-card">
          <div className="simple-demo-title">
            <span>3</span>
            <div>
              <h2>Votre visualisation</h2>
              <p>
                {render?.status === "processing"
                  ? "GPT Image 2 intègre votre objet…"
                  : "Comparez le lieu original et le résultat."}
              </p>
            </div>
          </div>

          {render?.status === "processing" && (
            <div className="render-waiting" aria-live="polite">
              <LoaderCircle className="spin" size={30} />
              <strong>Création du rendu réaliste</strong>
              <span>Cette étape peut prendre quelques instants.</span>
            </div>
          )}

          {render?.status === "failed" && (
            <div className="simple-demo-error" role="alert">
              {render.error ?? "La génération a échoué. Réessayez."}
            </div>
          )}

          {render?.status === "succeeded" && render.resultUrl && (
            <div className="simple-result-grid">
              <figure>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={scene.imageUrl} alt="Photo avant" />
                <figcaption>Avant</figcaption>
              </figure>
              <figure>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={render.resultUrl} alt="Visualisation après" />
                <figcaption>Après · {render.model ?? "gpt-image-2"}</figcaption>
              </figure>
            </div>
          )}

          <button
            type="button"
            className="simple-demo-secondary restart-button"
            onClick={reset}
          >
            <RefreshCw size={18} /> Faire un nouvel essai
          </button>
        </div>
      )}
    </section>
  );
}

async function readImageSize(file: File): Promise<{
  width: number;
  height: number;
}> {
  const bitmap = await createImageBitmap(file);
  const result = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return result;
}

function objectName(filename: string): string {
  const cleaned = filename
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length < 2) return "Objet à placer";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1, 118);
}

function roundDimension(value: number): number {
  return Math.round(Math.max(0.1, Math.min(1000, value)) * 10) / 10;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
