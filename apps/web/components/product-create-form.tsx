"use client";

import { useState } from "react";
import { Check, ImagePlus, LoaderCircle, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@lili/ui";
import { api } from "@/lib/api";
import { prepareImageForUpload } from "@/lib/client-image";

interface CreatedProduct {
  id: string;
  name: string;
  status: string;
  cutoutUrl?: string | null;
}

export function ProductCreateForm() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [phase, setPhase] = useState("Informations");

  async function submit(formData: FormData) {
    if (!file) {
      setError("Ajoutez une photo produit");
      return;
    }
    setBusy(true);
    setError("");
    try {
      setPhase("Optimisation de l’image");
      const preparedFile = await prepareImageForUpload(file);
      setPhase("Création");
      const product = await api<CreatedProduct>("/v1/products", {
        method: "POST",
        body: JSON.stringify({
          name: formData.get("name"),
          description: formData.get("description"),
          sku: formData.get("sku") || null,
          widthCm: Number(formData.get("widthCm")),
          heightCm: Number(formData.get("heightCm")),
          depthCm: Number(formData.get("depthCm")),
          material: formData.get("material"),
          placementType: formData.get("placementType"),
          generationInstructions: formData.get("generationInstructions") || "",
          lightingProfile: {
            source: formData.get("lighting"),
            reflectance: formData.get("reflectance"),
          },
          buyUrl: formData.get("buyUrl") || null,
        }),
      });
      setPhase("Nettoyage de l’image");
      const upload = new FormData();
      upload.set("file", preparedFile);
      await api(`/v1/products/${product.id}/assets`, {
        method: "POST",
        body: upload,
      });
      setPhase("Segmentation locale");
      await api(`/v1/products/${product.id}/prepare`, { method: "POST" });
      setPhase("Point d’ancrage");
      await api(`/v1/products/${product.id}/anchor`, {
        method: "POST",
        body: JSON.stringify({
          anchorType: "bottom_center",
          xNormalized: 0.5,
          yNormalized: 1,
        }),
      });
      setPhase("Publié");
      router.push("/app/catalog");
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
    <form action={(formData) => void submit(formData)} className="product-form">
      <header className="app-page-head">
        <div>
          <span className="eyebrow">Nouveau produit</span>
          <h1>Préparez votre objet.</h1>
          <p>
            Une image nette, des mesures réelles et un ancrage précis suffisent.
          </p>
        </div>
        <div className="creation-phase">
          {busy ? (
            <LoaderCircle className="spin" size={17} />
          ) : (
            <Check size={17} />
          )}
          {phase}
        </div>
      </header>
      {error && <div className="studio-error">{error}</div>}
      <div className="product-form-grid">
        <div className="app-card">
          <div className="form-section-title">
            <span>01</span>
            <div>
              <h2>Photo produit</h2>
              <p>Fond uni ou transparent recommandé.</p>
            </div>
          </div>
          <label className="product-upload">
            {preview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={preview} alt="Aperçu du produit" />
            ) : (
              <>
                <ImagePlus size={32} />
                <strong>Déposez votre image</strong>
                <span>
                  JPEG, PNG ou WebP · jusqu’à 20 Mo · optimisation auto
                </span>
              </>
            )}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) => {
                const selected = event.target.files?.[0] ?? null;
                setFile(selected);
                if (selected) setPreview(URL.createObjectURL(selected));
              }}
            />
          </label>
          <div className="mask-note">
            <Upload size={17} />
            <span>
              Le MVP produit un masque déterministe sur fond clair. Le pinceau
              de correction est préparé comme prochaine extension GPU/SAM.
            </span>
          </div>
        </div>
        <div className="app-card form-fields">
          <div className="form-section-title">
            <span>02</span>
            <div>
              <h2>Identité & dimensions</h2>
              <p>Ces valeurs pilotent l’échelle, pas le modèle IA.</p>
            </div>
          </div>
          <div className="field">
            <label htmlFor="name">Nom</label>
            <input id="name" name="name" required placeholder="Vase Sienne" />
          </div>
          <div className="two-fields">
            <div className="field">
              <label htmlFor="sku">SKU</label>
              <input id="sku" name="sku" placeholder="VAS-042" />
            </div>
            <div className="field">
              <label htmlFor="material">Matériau</label>
              <input
                id="material"
                name="material"
                required
                placeholder="Céramique mate"
              />
            </div>
          </div>
          <div className="three-fields">
            <Dimension name="widthCm" label="Largeur" />
            <Dimension name="heightCm" label="Hauteur" />
            <Dimension name="depthCm" label="Profondeur" />
          </div>
          <div className="two-fields">
            <div className="field">
              <label htmlFor="placementType">Placement</label>
              <select id="placementType" name="placementType">
                <option value="table">Table</option>
                <option value="shelf">Étagère</option>
                <option value="wall">Mur</option>
                <option value="floor">Sol</option>
                <option value="niche">Niche</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="reflectance">Réflexion</label>
              <select id="reflectance" name="reflectance">
                <option value="matte">Mate</option>
                <option value="satin">Satinée</option>
                <option value="glossy">Brillante</option>
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor="lighting">Lumière photo produit</label>
            <select id="lighting" name="lighting">
              <option value="softbox-left">Diffuse, depuis la gauche</option>
              <option value="softbox-right">Diffuse, depuis la droite</option>
              <option value="front">Face uniforme</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="buyUrl">Lien d’achat</label>
            <input
              id="buyUrl"
              name="buyUrl"
              type="url"
              placeholder="https://boutique.example/objet"
            />
          </div>
          <div className="field">
            <label htmlFor="description">Description</label>
            <textarea
              id="description"
              name="description"
              rows={3}
              placeholder="Description courte du catalogue…"
            />
          </div>
          <div className="field prompt-field">
            <label htmlFor="generationInstructions">
              Instructions de génération IA
            </label>
            <textarea
              id="generationInstructions"
              name="generationInstructions"
              rows={5}
              maxLength={1500}
              placeholder="Ex. ambiance naturelle et chaleureuse, ombre douce, conserver les reflets satinés, style photographie éditoriale…"
            />
            <small>
              Ces indications affinent l’ambiance et le traitement. L’identité,
              les dimensions et la couleur du produit restent prioritaires.
            </small>
          </div>
          <Button type="submit" disabled={busy}>
            <Check size={17} /> Créer et préparer
          </Button>
        </div>
      </div>
    </form>
  );
}

function Dimension({ name, label }: { name: string; label: string }) {
  return (
    <div className="field">
      <label htmlFor={name}>{label}</label>
      <div className="unit-input">
        <input
          id={name}
          name={name}
          type="number"
          required
          min="1"
          max="1000"
          step="0.1"
        />
        <span>cm</span>
      </div>
    </div>
  );
}
