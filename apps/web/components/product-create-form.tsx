"use client";

import { useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ImagePlus,
  LoaderCircle,
  Upload,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@lili/ui";
import { api, establishGuestEditorSession } from "@/lib/api";
import { prepareImageForUpload } from "@/lib/client-image";

interface CreatedProduct {
  id: string;
  name: string;
  status: string;
  cutoutUrl?: string | null;
}

type ObjectType =
  | "vase"
  | "lamp"
  | "frame"
  | "mirror"
  | "rug"
  | "furniture"
  | "plant"
  | "clock"
  | "other";

type ExtraViewType = "three_quarter" | "side" | "back";

const extraViewChoices: Array<{ value: ExtraViewType; label: string }> = [
  { value: "three_quarter", label: "Vue trois-quarts" },
  { value: "side", label: "Vue de côté" },
  { value: "back", label: "Vue arrière" },
];

const objectTypes: Array<{
  value: ObjectType;
  label: string;
  help: string;
  placement: string;
}> = [
  {
    value: "vase",
    label: "Vase ou pot",
    help: "Diamètre et hauteur",
    placement: "table",
  },
  {
    value: "lamp",
    label: "Lampe",
    help: "Diamètre et hauteur",
    placement: "table",
  },
  {
    value: "frame",
    label: "Cadre ou tableau",
    help: "Largeur, hauteur et épaisseur",
    placement: "wall",
  },
  {
    value: "mirror",
    label: "Miroir",
    help: "Largeur, hauteur et épaisseur",
    placement: "wall",
  },
  {
    value: "rug",
    label: "Tapis",
    help: "Largeur, longueur et épaisseur",
    placement: "floor",
  },
  {
    value: "furniture",
    label: "Meuble",
    help: "Largeur, hauteur et profondeur",
    placement: "floor",
  },
  {
    value: "plant",
    label: "Plante en pot",
    help: "Diamètre et hauteur",
    placement: "floor",
  },
  {
    value: "clock",
    label: "Horloge murale",
    help: "Largeur, hauteur et épaisseur",
    placement: "wall",
  },
  {
    value: "other",
    label: "Autre objet",
    help: "Largeur, hauteur et profondeur",
    placement: "table",
  },
];

export function ProductCreateForm({
  afterCreate = "catalog",
  guestAccess = false,
}: {
  afterCreate?: "catalog" | "visualizer";
  guestAccess?: boolean;
}) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [extraViews, setExtraViews] = useState<
    Partial<Record<ExtraViewType, File>>
  >({});
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [phase, setPhase] = useState(
    guestAccess ? "Préparation de l’espace" : "Prêt",
  );
  const [editorReady, setEditorReady] = useState(!guestAccess);
  const [objectType, setObjectType] = useState<ObjectType>("vase");
  const objectConfig = objectTypes.find((item) => item.value === objectType)!;

  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );

  useEffect(() => {
    if (!guestAccess) return;
    void establishGuestEditorSession()
      .then(() => {
        setEditorReady(true);
        setPhase("Prêt");
      })
      .catch((reason: unknown) => {
        setError(
          reason instanceof Error
            ? reason.message
            : "Impossible de préparer l’ajout d’objet",
        );
        setPhase("Réessayer");
      });
  }, [guestAccess]);

  async function submit(formData: FormData) {
    if (!editorReady) {
      setError("Patientez une seconde, l’espace de test se prépare.");
      return;
    }
    if (!file) {
      setError("Ajoutez le fichier PNG de votre objet.");
      return;
    }
    const dimensions = readDimensions(formData, objectType);
    setBusy(true);
    setError("");
    try {
      setPhase("Optimisation du PNG");
      const preparedFile = await prepareImageForUpload(file);
      setPhase("Création de l’objet");
      const product = await api<CreatedProduct>("/v1/products", {
        method: "POST",
        body: JSON.stringify({
          name: formData.get("name"),
          description: formData.get("description") || "",
          sku: formData.get("sku") || null,
          objectType,
          ...dimensions,
          material: formData.get("material"),
          placementType: formData.get("placementType"),
          generationInstructions: formData.get("generationInstructions") || "",
          lightingProfile: {
            source: formData.get("lighting") || "front",
            reflectance: formData.get("reflectance") || "matte",
          },
          buyUrl: formData.get("buyUrl") || null,
        }),
      });
      setPhase("Envoi de l’image");
      const upload = new FormData();
      upload.set("file", preparedFile);
      upload.set("viewType", "front");
      await api(`/v1/products/${product.id}/assets`, {
        method: "POST",
        body: upload,
      });
      for (const choice of extraViewChoices) {
        const extraFile = extraViews[choice.value];
        if (!extraFile) continue;
        setPhase(`Envoi : ${choice.label.toLowerCase()}`);
        const preparedView = await prepareImageForUpload(extraFile);
        const viewUpload = new FormData();
        viewUpload.set("file", preparedView);
        viewUpload.set("viewType", choice.value);
        await api(`/v1/products/${product.id}/assets`, {
          method: "POST",
          body: viewUpload,
        });
      }
      setPhase("Détourage automatique");
      await api(`/v1/products/${product.id}/prepare`, { method: "POST" });
      setPhase("Finalisation");
      await api(`/v1/products/${product.id}/anchor`, {
        method: "POST",
        body: JSON.stringify({
          anchorType: "bottom_center",
          xNormalized: 0.5,
          yNormalized: 1,
        }),
      });
      setPhase("Objet prêt");
      router.push(
        afterCreate === "visualizer"
          ? `/?product=${product.id}`
          : "/app/catalog",
      );
      router.refresh();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Création impossible",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      action={(formData) => void submit(formData)}
      className="product-form focused-product-form"
    >
      <header className="object-page-head">
        <div>
          <span className="eyebrow">Ajouter un objet</span>
          <h1>Préparez votre objet en quelques minutes.</h1>
          <p>
            Un PNG propre et les vraies dimensions suffisent. Les réglages
            techniques restent facultatifs.
          </p>
        </div>
        <div className="creation-phase" aria-live="polite">
          {busy ? (
            <LoaderCircle className="spin" size={18} />
          ) : (
            <Check size={18} />
          )}
          {phase}
        </div>
      </header>

      {error && (
        <div className="studio-error" role="alert">
          {error}
        </div>
      )}

      <div className="focused-product-grid">
        <section className="object-form-section object-photo-section">
          <div className="simple-section-title">
            <span>1</span>
            <div>
              <h2>Ajoutez 1 à 4 vues</h2>
              <p>Commencez par une vue de face, bien éclairée.</p>
            </div>
          </div>
          <label
            className={
              preview ? "product-upload has-preview" : "product-upload"
            }
          >
            {preview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={preview} alt="Aperçu du produit" />
            ) : (
              <>
                <ImagePlus size={38} />
                <strong>Choisir un fichier PNG</strong>
                <span>Fond transparent recommandé · 20 Mo maximum</span>
              </>
            )}
            <input
              type="file"
              aria-label="Image PNG de l’objet"
              accept="image/png,.png"
              disabled={!editorReady || busy}
              onChange={(event) => {
                const selected = event.target.files?.[0] ?? null;
                if (
                  selected &&
                  selected.type !== "image/png" &&
                  !selected.name.toLowerCase().endsWith(".png")
                ) {
                  setError("Choisissez un fichier au format PNG.");
                  event.target.value = "";
                  return;
                }
                setError("");
                setFile(selected);
                setPreview(selected ? URL.createObjectURL(selected) : "");
              }}
            />
          </label>
          {preview && (
            <label className="replace-image-button">
              <Upload size={17} /> Remplacer le PNG
              <input
                type="file"
                aria-label="Remplacer l’image PNG"
                accept="image/png,.png"
                disabled={!editorReady || busy}
                onChange={(event) => {
                  const selected = event.target.files?.[0] ?? null;
                  if (selected) {
                    setFile(selected);
                    setPreview(URL.createObjectURL(selected));
                  }
                }}
              />
            </label>
          )}
          <div className="product-extra-views">
            <div>
              <strong>Angles supplémentaires</strong>
              <span>Facultatifs, mais utiles pour un rendu fidèle.</span>
            </div>
            <div className="product-extra-view-grid">
              {extraViewChoices.map((choice) => (
                <label
                  className={
                    extraViews[choice.value]
                      ? "product-extra-view selected"
                      : "product-extra-view"
                  }
                  key={choice.value}
                >
                  <ImagePlus size={20} />
                  <span>
                    <strong>{choice.label}</strong>
                    <small>
                      {extraViews[choice.value]?.name ?? "Ajouter un PNG"}
                    </small>
                  </span>
                  <input
                    type="file"
                    accept="image/png,.png"
                    aria-label={choice.label}
                    disabled={!editorReady || busy}
                    onChange={(event) => {
                      const selected = event.target.files?.[0];
                      setExtraViews((current) => {
                        const next = { ...current };
                        if (selected) next[choice.value] = selected;
                        else delete next[choice.value];
                        return next;
                      });
                    }}
                  />
                </label>
              ))}
            </div>
            {file && Object.keys(extraViews).length === 0 && (
              <p className="product-view-warning" role="status">
                Certains angles non visibles seront estimés par l’intelligence
                artificielle.
              </p>
            )}
          </div>
        </section>

        <section className="object-form-section object-details-section">
          <div className="simple-section-title">
            <span>2</span>
            <div>
              <h2>Décrivez l’objet</h2>
              <p>Nous adaptons les mesures au type choisi.</p>
            </div>
          </div>

          <div className="field large-field">
            <label htmlFor="name">Nom de l’objet</label>
            <input
              id="name"
              name="name"
              required
              placeholder="Ex. Vase Sienne"
              autoComplete="off"
            />
          </div>

          <fieldset className="object-type-fieldset">
            <legend>Type d’objet</legend>
            <div className="object-type-grid">
              {objectTypes.map((item) => (
                <label
                  key={item.value}
                  className={
                    objectType === item.value
                      ? "object-type-option selected"
                      : "object-type-option"
                  }
                >
                  <input
                    type="radio"
                    name="objectTypeChoice"
                    value={item.value}
                    checked={objectType === item.value}
                    onChange={() => setObjectType(item.value)}
                  />
                  <strong>{item.label}</strong>
                  <small>{item.help}</small>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="field">
            <label htmlFor="material">Matière principale</label>
            <input
              id="material"
              name="material"
              required
              placeholder="Ex. céramique mate, bois, métal…"
            />
          </div>

          <div className="dimensions-block">
            <div>
              <strong>Dimensions réelles</strong>
              <span>Mesurez l’objet au point le plus large.</span>
            </div>
            <DimensionFields objectType={objectType} />
          </div>

          <div className="field">
            <label htmlFor="placementType">
              Où pose-t-on généralement cet objet ?
            </label>
            <select
              key={objectType}
              id="placementType"
              name="placementType"
              defaultValue={objectConfig.placement}
            >
              <option value="table">Sur une table</option>
              <option value="nightstand">Sur une table de nuit</option>
              <option value="shelf">Sur une étagère</option>
              <option value="niche">Dans une niche</option>
              <option value="wall">Sur un mur</option>
              <option value="floor">Au sol</option>
            </select>
          </div>

          <details className="advanced-options">
            <summary>
              Options facultatives <ChevronDown size={18} />
            </summary>
            <div className="advanced-options-body">
              <div className="two-fields">
                <div className="field">
                  <label htmlFor="sku">Référence / SKU</label>
                  <input id="sku" name="sku" placeholder="Ex. VAS-042" />
                </div>
                <div className="field">
                  <label htmlFor="buyUrl">Lien d’achat</label>
                  <input
                    id="buyUrl"
                    name="buyUrl"
                    type="url"
                    placeholder="https://…"
                  />
                </div>
              </div>
              <div className="field">
                <label htmlFor="description">Description</label>
                <textarea
                  id="description"
                  name="description"
                  rows={3}
                  placeholder="Quelques mots sur l’objet…"
                />
              </div>
              <div className="field prompt-field">
                <label htmlFor="generationInstructions">
                  Indications pour le rendu IA
                </label>
                <textarea
                  id="generationInstructions"
                  name="generationInstructions"
                  rows={4}
                  maxLength={1500}
                  placeholder="Ex. ombre douce, conserver les reflets satinés…"
                />
                <small>
                  L’IA ne peut pas changer les couleurs, la silhouette ou les
                  proportions du produit.
                </small>
              </div>
              <div className="two-fields">
                <div className="field">
                  <label htmlFor="reflectance">Aspect de la matière</label>
                  <select
                    id="reflectance"
                    name="reflectance"
                    defaultValue="matte"
                  >
                    <option value="matte">Mat</option>
                    <option value="satin">Satiné</option>
                    <option value="glossy">Brillant</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="lighting">Lumière du PNG</label>
                  <select id="lighting" name="lighting" defaultValue="front">
                    <option value="front">De face</option>
                    <option value="softbox-left">Depuis la gauche</option>
                    <option value="softbox-right">Depuis la droite</option>
                  </select>
                </div>
              </div>
            </div>
          </details>

          <Button type="submit" disabled={busy || !editorReady}>
            {busy ? (
              <LoaderCircle className="spin" size={18} />
            ) : (
              <Check size={18} />
            )}
            {busy || !editorReady ? phase : "Préparer cet objet"}
            {!busy && <ArrowRight size={18} />}
          </Button>
          <p className="form-submit-help">
            Le détourage et la préparation se font automatiquement.
          </p>
        </section>
      </div>
    </form>
  );
}

function DimensionFields({ objectType }: { objectType: ObjectType }) {
  if (
    objectType === "vase" ||
    objectType === "lamp" ||
    objectType === "plant"
  ) {
    return (
      <div className="two-fields">
        <Dimension name="diameterCm" label="Diamètre" />
        <Dimension name="heightCm" label="Hauteur" />
      </div>
    );
  }
  if (
    objectType === "frame" ||
    objectType === "mirror" ||
    objectType === "clock"
  ) {
    return (
      <div className="three-fields">
        <Dimension name="widthCm" label="Largeur" />
        <Dimension name="heightCm" label="Hauteur" />
        <Dimension name="thicknessCm" label="Épaisseur" min="0.1" />
      </div>
    );
  }
  if (objectType === "rug") {
    return (
      <div className="three-fields">
        <Dimension name="widthCm" label="Largeur" />
        <Dimension name="lengthCm" label="Longueur" />
        <Dimension name="thicknessCm" label="Épaisseur" min="0.1" />
      </div>
    );
  }
  return (
    <div className="three-fields">
      <Dimension name="widthCm" label="Largeur" />
      <Dimension name="heightCm" label="Hauteur" />
      <Dimension name="depthCm" label="Profondeur" min="0.1" />
    </div>
  );
}

function Dimension({
  name,
  label,
  min = "1",
}: {
  name: string;
  label: string;
  min?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={name}>{label}</label>
      <div className="unit-input">
        <input
          id={name}
          name={name}
          type="number"
          inputMode="decimal"
          required
          min={min}
          max="1000"
          step="0.1"
          placeholder="0"
        />
        <span>cm</span>
      </div>
    </div>
  );
}

function readDimensions(formData: FormData, objectType: ObjectType) {
  const number = (name: string) => Number(formData.get(name));
  if (
    objectType === "vase" ||
    objectType === "lamp" ||
    objectType === "plant"
  ) {
    const diameter = number("diameterCm");
    return {
      widthCm: diameter,
      heightCm: number("heightCm"),
      depthCm: diameter,
    };
  }
  if (
    objectType === "frame" ||
    objectType === "mirror" ||
    objectType === "clock"
  ) {
    return {
      widthCm: number("widthCm"),
      heightCm: number("heightCm"),
      depthCm: number("thicknessCm"),
    };
  }
  if (objectType === "rug") {
    return {
      widthCm: number("widthCm"),
      heightCm: number("thicknessCm"),
      depthCm: number("lengthCm"),
    };
  }
  return {
    widthCm: number("widthCm"),
    heightCm: number("heightCm"),
    depthCm: number("depthCm"),
  };
}
