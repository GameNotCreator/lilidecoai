"use client";

import {
  ArrowLeft,
  ArrowRight,
  Check,
  ImagePlus,
  LoaderCircle,
  MapPin,
  Plus,
  RefreshCw,
  Ruler,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import type { Render } from "@lili/types";

import { api, establishGuestEditorSession, getRender } from "@/lib/api";
import { prepareImageForUpload } from "@/lib/client-image";

type DimensionMode = "height_length" | "length_width";
type ObjectDimensionPair =
  | { mode: "height_length"; heightCm: number; lengthCm: number }
  | { mode: "length_width"; lengthCm: number; widthCm: number };
type Step = 1 | 2 | 3;

interface PreparedProduct {
  id: string;
  name: string;
  cutoutUrl?: string | null;
  widthCm: number;
  heightCm: number;
  depthCm: number;
}

interface DemoObject {
  key: string;
  file: File | null;
  preview: string;
  dimensionMode: DimensionMode;
  heightValue: string;
  lengthValue: string;
  widthValue: string;
  product: PreparedProduct | null;
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

const MAX_OBJECTS = 3;
const progressLabels = ["Vos objets", "Votre intérieur", "Résultat"];

export function SimpleDemoStudio() {
  const [step, setStep] = useState<Step>(1);
  const [ready, setReady] = useState(false);
  const [busyLabel, setBusyLabel] = useState("Préparation de la démo…");
  const [error, setError] = useState("");
  const [objects, setObjects] = useState<DemoObject[]>(() => [createObject(1)]);
  const [scene, setScene] = useState<Scene | null>(null);
  const [points, setPoints] = useState<Point[]>([]);
  const [render, setRender] = useState<Render | null>(null);
  const nextObjectId = useRef(2);
  const previewUrls = useRef(new Set<string>());

  const busy = Boolean(busyLabel && ready);
  const objectsAreValid = objects.every(isObjectReady);
  const allPointsPlaced = points.length === objects.length;
  const pixelPoints = useMemo(() => {
    if (!scene) return [];
    return points.map((point) => ({
      x: Math.round(point.x * scene.widthPx),
      y: Math.round(point.y * scene.heightPx),
    }));
  }, [points, scene]);

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

  useEffect(() => {
    const urls = previewUrls.current;
    return () => {
      urls.forEach((url) => URL.revokeObjectURL(url));
      urls.clear();
    };
  }, []);

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

  function updateObject(
    key: string,
    changes: Partial<Omit<DemoObject, "key">>,
  ) {
    setObjects((current) =>
      current.map((object) =>
        object.key === key ? { ...object, ...changes } : object,
      ),
    );
    setPoints([]);
    setError("");
  }

  function selectObjectFile(key: string, file: File | null) {
    const previous = objects.find((object) => object.key === key)?.preview;
    if (previous) {
      URL.revokeObjectURL(previous);
      previewUrls.current.delete(previous);
    }
    const preview = file ? URL.createObjectURL(file) : "";
    if (preview) previewUrls.current.add(preview);
    updateObject(key, { file, preview, product: null });
  }

  function addObject() {
    if (objects.length >= MAX_OBJECTS) return;
    setObjects((current) => [...current, createObject(nextObjectId.current++)]);
    setPoints([]);
    setError("");
  }

  function removeObject(key: string) {
    if (objects.length === 1) return;
    const removed = objects.find((object) => object.key === key);
    if (removed?.preview) {
      URL.revokeObjectURL(removed.preview);
      previewUrls.current.delete(removed.preview);
    }
    setObjects((current) => current.filter((object) => object.key !== key));
    setPoints([]);
    setError("");
  }

  async function prepareObjects() {
    if (!objectsAreValid) {
      setError("Ajoutez une image et une dimension valide pour chaque objet.");
      return;
    }
    setError("");
    try {
      await establishGuestEditorSession();
      for (let index = 0; index < objects.length; index += 1) {
        const object = objects[index];
        if (!object) continue;
        if (object.product) continue;
        setBusyLabel(
          objects.length === 1
            ? "Préparation de l’objet…"
            : `Préparation de l’objet ${index + 1} sur ${objects.length}…`,
        );
        const prepared = await prepareObject(object);
        setObjects((current) =>
          current.map((item) =>
            item.key === object.key ? { ...item, product: prepared } : item,
          ),
        );
      }
      setPoints([]);
      setStep(2);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Un objet n’a pas pu être préparé.",
      );
    } finally {
      setBusyLabel("");
    }
  }

  async function prepareObject(object: DemoObject): Promise<PreparedProduct> {
    if (!object.file) throw new Error("L’image de l’objet est manquante.");
    const lengthCm = Number(object.lengthValue);
    const imageSize = await readImageSize(object.file);
    const ratio = imageSize.width / Math.max(1, imageSize.height);
    const heightCm =
      object.dimensionMode === "height_length"
        ? Number(object.heightValue)
        : lengthCm / ratio;
    const depthCm =
      object.dimensionMode === "length_width"
        ? Number(object.widthValue)
        : Math.max(0.1, Math.min(lengthCm, heightCm) * 0.4);
    const name = objectName(object.file.name);
    const created = await api<PreparedProduct>("/v1/products", {
      method: "POST",
      body: JSON.stringify({
        temporary: true,
        name,
        description: "Objet fourni par l’utilisateur pour cette visualisation.",
        objectType: "other",
        widthCm: roundDimension(lengthCm),
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
    setBusyLabel(`Envoi de ${name}…`);
    const preparedFile = await prepareImageForUpload(object.file);
    const upload = new FormData();
    upload.set("file", preparedFile);
    upload.set("viewType", "front");
    await api(`/v1/products/${created.id}/assets`, {
      method: "POST",
      body: upload,
    });
    setBusyLabel(`Détourage de ${name}…`);
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
    return prepared;
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
      setPoints([]);
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
    if (allPointsPlaced) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const point = {
      x: clamp((event.clientX - bounds.left) / bounds.width),
      y: clamp((event.clientY - bounds.top) / bounds.height),
    };
    setPoints((current) => [...current, point]);
    setError("");
  }

  async function generate() {
    const products = objects.map((object) => object.product);
    if (!scene || products.some((product) => !product) || !allPointsPlaced) {
      setError("Ajoutez les images puis placez un point par objet.");
      return;
    }
    const firstProduct = products[0];
    const firstPoint = points[0];
    if (!firstProduct || !firstPoint) return;

    setError("");
    setBusyLabel("Lancement de GPT Image 2…");
    try {
      const simplePlacements = objects.map((object, index) => ({
        productId: object.product!.id,
        placementPoint: points[index],
        dimensionPair: objectDimensionPair(object),
      }));
      const created = await api<Render>("/v1/renders/final", {
        method: "POST",
        body: JSON.stringify({
          workflow: "simple_point",
          mode: "insert",
          simplePlacements,
          placement: {
            sceneId: scene.id,
            productId: firstProduct.id,
            mode: "insert",
            surfaceType: "tabletop",
            xNormalized: firstPoint.x,
            yNormalized: firstPoint.y,
          },
          placementPoint: firstPoint,
          surfaceType: "tabletop",
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

  function resetPoints() {
    setPoints([]);
    setError("");
  }

  function reset() {
    previewUrls.current.forEach((url) => URL.revokeObjectURL(url));
    previewUrls.current.clear();
    nextObjectId.current = 2;
    setStep(1);
    setError("");
    setObjects([createObject(1)]);
    setScene(null);
    setPoints([]);
    setRender(null);
    setBusyLabel("");
  }

  const nextObject = objects[points.length];

  return (
    <section className="simple-demo" data-step={step}>
      <header className="simple-demo-head">
        <span className="simple-demo-kicker">Visualisation IA</span>
        <h1>Voyez vos objets chez vous.</h1>
        <p>Jusqu’à trois objets, une photo et leurs points. C’est tout.</p>
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
              <h2>Ajoutez les objets à placer</h2>
              <p>De un à trois objets, visibles en entier sur leurs photos.</p>
            </div>
          </div>

          <div className="simple-objects-list">
            {objects.map((object, index) => {
              const objectReady = isObjectReady(object);
              return (
                <article className="simple-object-entry" key={object.key}>
                  <div className="simple-object-entry-head">
                    <div>
                      <span>{index + 1}</span>
                      <strong>Objet {index + 1}</strong>
                    </div>
                    {objects.length > 1 && (
                      <button
                        type="button"
                        className="simple-object-remove"
                        aria-label={`Supprimer l’objet ${index + 1}`}
                        disabled={busy}
                        onClick={() => removeObject(object.key)}
                      >
                        <Trash2 size={17} />
                        <span>Supprimer</span>
                      </button>
                    )}
                  </div>

                  <div className="simple-object-entry-body">
                    <div>
                      <label
                        className={
                          object.preview
                            ? "simple-upload simple-object-upload has-image"
                            : "simple-upload simple-object-upload"
                        }
                      >
                        {object.preview ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={object.preview}
                            alt={`Objet ${index + 1} à placer`}
                          />
                        ) : (
                          <>
                            <ImagePlus size={30} />
                            <strong>Choisir l’image</strong>
                            <span>PNG, JPG ou WebP</span>
                          </>
                        )}
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          aria-label={`Image de l’objet ${index + 1}`}
                          disabled={!ready || busy}
                          onChange={(event) =>
                            selectObjectFile(
                              object.key,
                              event.target.files?.[0] ?? null,
                            )
                          }
                        />
                      </label>

                      {object.preview && (
                        <label className="simple-change-file">
                          <Upload size={17} /> Changer l’image
                          <input
                            type="file"
                            accept="image/png,image/jpeg,image/webp"
                            aria-label={`Changer l’image de l’objet ${index + 1}`}
                            disabled={busy}
                            onChange={(event) => {
                              const file = event.target.files?.[0];
                              if (file) selectObjectFile(object.key, file);
                            }}
                          />
                        </label>
                      )}
                    </div>

                    <div className="simple-object-dimensions">
                      <div className="simple-field-label">
                        <Ruler size={19} />
                        <div>
                          <strong>Deux dimensions connues</strong>
                          <span>Choisissez la paire que vous pouvez mesurer.</span>
                        </div>
                      </div>
                      <div
                        className="simple-segmented"
                        role="group"
                        aria-label={`Dimensions de l’objet ${index + 1}`}
                      >
                        <button
                          type="button"
                          className={
                            object.dimensionMode === "height_length"
                              ? "selected"
                              : ""
                          }
                          aria-pressed={
                            object.dimensionMode === "height_length"
                          }
                          onClick={() =>
                            updateObject(object.key, {
                              dimensionMode: "height_length",
                              product: null,
                            })
                          }
                        >
                          Hauteur + longueur
                        </button>
                        <button
                          type="button"
                          className={
                            object.dimensionMode === "length_width"
                              ? "selected"
                              : ""
                          }
                          aria-pressed={
                            object.dimensionMode === "length_width"
                          }
                          onClick={() =>
                            updateObject(object.key, {
                              dimensionMode: "length_width",
                              product: null,
                            })
                          }
                        >
                          Longueur + largeur
                        </button>
                      </div>
                      <div className="simple-size-inputs">
                        {object.dimensionMode === "height_length" ? (
                          <>
                            <SizeInput
                              label="Hauteur"
                              objectNumber={index + 1}
                              value={object.heightValue}
                              onChange={(value) =>
                                updateObject(object.key, {
                                  heightValue: value,
                                  product: null,
                                })
                              }
                            />
                            <SizeInput
                              label="Longueur"
                              objectNumber={index + 1}
                              value={object.lengthValue}
                              onChange={(value) =>
                                updateObject(object.key, {
                                  lengthValue: value,
                                  product: null,
                                })
                              }
                            />
                          </>
                        ) : (
                          <>
                            <SizeInput
                              label="Longueur"
                              objectNumber={index + 1}
                              value={object.lengthValue}
                              onChange={(value) =>
                                updateObject(object.key, {
                                  lengthValue: value,
                                  product: null,
                                })
                              }
                            />
                            <SizeInput
                              label="Largeur"
                              objectNumber={index + 1}
                              value={object.widthValue}
                              onChange={(value) =>
                                updateObject(object.key, {
                                  widthValue: value,
                                  product: null,
                                })
                              }
                            />
                          </>
                        )}
                      </div>
                      {objectReady && (
                        <span className="simple-object-ready">
                          <Check size={15} /> Objet {index + 1} prêt
                        </span>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>

          {objects.length < MAX_OBJECTS && (
            <button
              type="button"
              className="simple-add-object"
              disabled={busy}
              onClick={addObject}
            >
              <Plus size={19} /> Ajouter un objet
              <span>
                {objects.length}/{MAX_OBJECTS}
              </span>
            </button>
          )}

          <button
            type="button"
            className="simple-demo-primary"
            disabled={!ready || busy || !objectsAreValid}
            onClick={() => void prepareObjects()}
          >
            {busy ? <LoaderCircle className="spin" size={19} /> : null}
            {busy
              ? busyLabel
              : `Continuer avec ${objects.length} objet${objects.length > 1 ? "s" : ""}`}
            {!busy && <ArrowRight size={19} />}
          </button>
        </div>
      )}

      {step === 2 && objects.every((object) => object.product) && (
        <div className="simple-demo-card simple-room-card">
          <div className="simple-demo-title">
            <span>2</span>
            <div>
              <h2>Ajoutez la photo du lieu</h2>
              <p>Placez ensuite un point numéroté pour chaque objet.</p>
            </div>
          </div>

          <div
            className="simple-placement-objects"
            aria-label="Objets à placer"
          >
            {objects.map((object, index) => (
              <div
                className={
                  points[index]
                    ? "placed"
                    : index === points.length
                      ? "current"
                      : ""
                }
                key={object.key}
              >
                <span className="simple-placement-number">{index + 1}</span>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={object.product?.cutoutUrl || object.preview} alt="" />
                <span>
                  <strong>
                    {object.product?.name || `Objet ${index + 1}`}
                  </strong>
                  <small>
                    {dimensionPairSummary(object)}
                  </small>
                </span>
                {points[index] && <Check size={17} />}
              </div>
            ))}
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
                  <strong>
                    {allPointsPlaced
                      ? "Tous les points sont placés"
                      : `Placez le point ${points.length + 1}`}
                  </strong>
                  <span>
                    {nextObject
                      ? `Touchez l’endroit où poser ${nextObject.product?.name || `l’objet ${points.length + 1}`}.`
                      : `${points.length} point${points.length > 1 ? "s" : ""} enregistré${points.length > 1 ? "s" : ""}.`}
                  </span>
                </div>
                <div className="point-picker-tools">
                  {points.length > 0 && (
                    <button type="button" onClick={resetPoints} disabled={busy}>
                      <RefreshCw size={16} /> Replacer les points
                    </button>
                  )}
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
              </div>
              <button
                type="button"
                className={
                  allPointsPlaced
                    ? "simple-point-picker points-complete"
                    : "simple-point-picker"
                }
                aria-label={
                  allPointsPlaced
                    ? "Tous les points sont placés"
                    : `Placer le point ${points.length + 1} dans l’image`
                }
                onClick={selectPoint}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={scene.imageUrl} alt="Lieu de réception" />
                {points.map((point, index) => (
                  <span
                    className="simple-red-dot"
                    style={{
                      left: `${point.x * 100}%`,
                      top: `${point.y * 100}%`,
                    }}
                    data-testid="placement-dot"
                    data-point-number={index + 1}
                    key={`${point.x}-${point.y}-${index}`}
                  >
                    {index + 1}
                  </span>
                ))}
              </button>
              <div
                className={
                  points.length > 0
                    ? "point-coordinates ready"
                    : "point-coordinates"
                }
              >
                {points.length > 0 ? (
                  <>
                    <Check size={17} />
                    {pixelPoints.map((point, index) => (
                      <span key={`${point.x}-${point.y}-${index}`}>
                        Point {index + 1} : x {point.x} · y {point.y}
                      </span>
                    ))}
                  </>
                ) : (
                  <>
                    <MapPin size={17} /> Touchez la photo pour placer le point 1
                  </>
                )}
              </div>
            </div>
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
              disabled={busy || !scene || !allPointsPlaced}
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
                  ? "GPT Image 2 intègre vos objets…"
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

function createObject(id: number): DemoObject {
  return {
    key: `object-${id}`,
    file: null,
    preview: "",
    dimensionMode: "height_length",
    heightValue: "",
    lengthValue: "",
    widthValue: "",
    product: null,
  };
}

function isObjectReady(object: DemoObject): boolean {
  if (!object.file || !positiveDimension(object.lengthValue)) return false;
  return object.dimensionMode === "height_length"
    ? positiveDimension(object.heightValue)
    : positiveDimension(object.widthValue);
}

function positiveDimension(value: string): boolean {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1_500;
}

function objectDimensionPair(object: DemoObject): ObjectDimensionPair {
  return object.dimensionMode === "height_length"
    ? {
        mode: "height_length",
        heightCm: Number(object.heightValue),
        lengthCm: Number(object.lengthValue),
      }
    : {
        mode: "length_width",
        lengthCm: Number(object.lengthValue),
        widthCm: Number(object.widthValue),
      };
}

function dimensionPairSummary(object: DemoObject): string {
  const dimensions = objectDimensionPair(object);
  return dimensions.mode === "height_length"
    ? `Hauteur ${dimensions.heightCm} cm · Longueur ${dimensions.lengthCm} cm`
    : `Longueur ${dimensions.lengthCm} cm · Largeur ${dimensions.widthCm} cm`;
}

function SizeInput({
  label,
  objectNumber,
  value,
  onChange,
}: {
  label: "Hauteur" | "Longueur" | "Largeur";
  objectNumber: number;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="simple-unit-input">
      <span>{label}</span>
      <div>
        <input
          type="number"
          inputMode="decimal"
          min="0.1"
          max="1500"
          step="0.1"
          value={value}
          aria-label={`${label} de l’objet ${objectNumber} en centimètres`}
          placeholder="Ex. 42"
          onChange={(event) => onChange(event.target.value)}
        />
        <span>cm</span>
      </div>
    </label>
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
