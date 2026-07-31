"use client";

import { useEffect, useState } from "react";
import { Check, ImagePlus, LoaderCircle, Upload } from "lucide-react";
import { Button } from "@lili/ui";
import { api } from "@/lib/api";
import { prepareImageForUpload } from "@/lib/client-image";

interface ProductDetails {
  id: string;
  name: string;
  description: string;
  sku: string | null;
  widthCm: number;
  heightCm: number;
  depthCm: number;
  material: string;
  placementType: string;
  generationInstructions: string;
  lightingProfile?: Record<string, unknown>;
  buyUrl?: string | null;
  assetUrl?: string | null;
  cutoutUrl?: string | null;
  status: string;
  updatedAt: string;
}

export function ProductEditForm({ productId }: { productId: string }) {
  const [product, setProduct] = useState<ProductDetails | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [phase, setPhase] = useState("Prêt à modifier");

  useEffect(() => {
    void api<ProductDetails>(`/v1/products/${productId}`)
      .then(setProduct)
      .catch((reason: unknown) =>
        setError(
          reason instanceof Error ? reason.message : "Produit introuvable",
        ),
      );
  }, [productId]);

  async function submit(formData: FormData) {
    if (!product) return;
    setBusy(true);
    setError("");
    try {
      setPhase("Enregistrement");
      await api<ProductDetails>(`/v1/products/${product.id}`, {
        method: "PATCH",
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

      if (file) {
        setPhase("Optimisation de la nouvelle photo");
        const preparedFile = await prepareImageForUpload(file);
        const upload = new FormData();
        upload.set("file", preparedFile);
        setPhase("Détourage du produit");
        await api(`/v1/products/${product.id}/assets`, {
          method: "POST",
          body: upload,
        });
        await api(`/v1/products/${product.id}/prepare`, { method: "POST" });
        await api(`/v1/products/${product.id}/anchor`, {
          method: "POST",
          body: JSON.stringify({
            anchorType: "bottom_center",
            xNormalized: 0.5,
            yNormalized: 1,
          }),
        });
      }

      const refreshed = await api<ProductDetails>(`/v1/products/${product.id}`);
      setProduct(refreshed);
      setFile(null);
      setPreview("");
      setPhase("Modifications enregistrées");
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Modification impossible",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!product && !error) {
    return <div className="empty-state">Chargement du produit…</div>;
  }
  if (!product) return <div className="studio-error">{error}</div>;

  const lightingSource = String(product.lightingProfile?.source ?? "front");
  const reflectance = String(product.lightingProfile?.reflectance ?? "matte");

  return (
    <form
      key={product.updatedAt}
      action={(formData) => void submit(formData)}
      className="product-form"
    >
      <header className="app-page-head">
        <div>
          <span className="eyebrow">Catalogue · Modifier</span>
          <h1>{product.name}</h1>
          <p>
            Ajustez les informations qui pilotent l’échelle, le placement et la
            génération.
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
              <p>Ajoutez une nouvelle photo seulement si elle doit changer.</p>
            </div>
          </div>
          <label className="product-upload">
            {preview || product.cutoutUrl || product.assetUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={preview || product.cutoutUrl || product.assetUrl || ""}
                alt={`Aperçu de ${product.name}`}
              />
            ) : (
              <>
                <ImagePlus size={32} />
                <strong>Remplacer la photo</strong>
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
              Le nouveau traitement retire uniquement le fond connecté aux bords
              et protège mieux les détails clairs du produit.
            </span>
          </div>
        </div>
        <div className="app-card form-fields">
          <div className="form-section-title">
            <span>02</span>
            <div>
              <h2>Identité, dimensions & IA</h2>
              <p>Ces valeurs deviennent la source de vérité du rendu.</p>
            </div>
          </div>
          <div className="field">
            <label htmlFor="name">Nom</label>
            <input id="name" name="name" required defaultValue={product.name} />
          </div>
          <div className="two-fields">
            <Field label="SKU" name="sku" defaultValue={product.sku ?? ""} />
            <Field
              label="Matériau"
              name="material"
              required
              defaultValue={product.material}
            />
          </div>
          <div className="three-fields">
            <Dimension name="widthCm" label="Largeur" value={product.widthCm} />
            <Dimension
              name="heightCm"
              label="Hauteur"
              value={product.heightCm}
            />
            <Dimension
              name="depthCm"
              label="Profondeur"
              value={product.depthCm}
            />
          </div>
          <div className="two-fields">
            <div className="field">
              <label htmlFor="placementType">Support conseillé</label>
              <select
                id="placementType"
                name="placementType"
                defaultValue={product.placementType}
              >
                <option value="table">Table</option>
                <option value="nightstand">Table de nuit</option>
                <option value="shelf">Étagère</option>
                <option value="niche">Niche</option>
                <option value="wall">Mur</option>
                <option value="floor">Sol</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="reflectance">Réflexion</label>
              <select
                id="reflectance"
                name="reflectance"
                defaultValue={reflectance}
              >
                <option value="matte">Mate</option>
                <option value="satin">Satinée</option>
                <option value="glossy">Brillante</option>
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor="lighting">Lumière de la photo produit</label>
            <select id="lighting" name="lighting" defaultValue={lightingSource}>
              <option value="softbox-left">Diffuse, depuis la gauche</option>
              <option value="softbox-right">Diffuse, depuis la droite</option>
              <option value="front">Face uniforme</option>
            </select>
          </div>
          <Field
            label="Lien d’achat"
            name="buyUrl"
            type="url"
            defaultValue={product.buyUrl ?? ""}
          />
          <div className="field">
            <label htmlFor="description">Description</label>
            <textarea
              id="description"
              name="description"
              rows={3}
              defaultValue={product.description}
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
              defaultValue={product.generationInstructions}
              placeholder="Ambiance, ombre, reflets, style photographique…"
            />
            <small>
              Elles affinent le rendu sans pouvoir déplacer, recolorer ou
              dupliquer le produit.
            </small>
          </div>
          <Button type="submit" disabled={busy}>
            <Check size={17} /> Enregistrer les modifications
          </Button>
        </div>
      </div>
    </form>
  );
}

function Field({
  label,
  name,
  defaultValue,
  type = "text",
  required = false,
}: {
  label: string;
  name: string;
  defaultValue: string;
  type?: string;
  required?: boolean;
}) {
  return (
    <div className="field">
      <label htmlFor={name}>{label}</label>
      <input
        id={name}
        name={name}
        type={type}
        required={required}
        defaultValue={defaultValue}
      />
    </div>
  );
}

function Dimension({
  name,
  label,
  value,
}: {
  name: string;
  label: string;
  value: number;
}) {
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
          defaultValue={value}
        />
        <span>cm</span>
      </div>
    </div>
  );
}
