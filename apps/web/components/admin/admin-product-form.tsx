"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Archive,
  ArchiveRestore,
  CheckCircle2,
  ExternalLink,
  EyeOff,
  ImagePlus,
  LoaderCircle,
  Plus,
  Save,
  Trash2,
  Wand2,
} from "lucide-react";

import {
  adminApi,
  formatDate,
  objectTypeLabels,
  placementLabels,
  statusLabels,
  viewLabels,
  type AdminProduct,
} from "@/lib/admin-client";
import { prepareImageForUpload } from "@/lib/client-image";

interface VariantRow {
  key: string;
  id?: string;
  label: string;
  sku: string;
  widthCm: string;
  heightCm: string;
  depthCm: string;
  price: string;
  stock: string;
  available: boolean;
}

interface FormState {
  name: string;
  description: string;
  objectType: string;
  placementType: string;
  material: string;
  sku: string;
  brand: string;
  collection: string;
  tags: string;
  widthCm: string;
  heightCm: string;
  depthCm: string;
  weightKg: string;
  price: string;
  currency: string;
  stock: string;
  buyUrl: string;
  generationInstructions: string;
  lightingSource: string;
  reflectance: string;
  variants: VariantRow[];
}

const emptyForm: FormState = {
  name: "",
  description: "",
  objectType: "vase",
  placementType: "table",
  material: "",
  sku: "",
  brand: "",
  collection: "",
  tags: "",
  widthCm: "",
  heightCm: "",
  depthCm: "",
  weightKg: "",
  price: "",
  currency: "TND",
  stock: "",
  buyUrl: "",
  generationInstructions: "",
  lightingSource: "front",
  reflectance: "matte",
  variants: [],
};

const dimensionHints: Record<string, string> = {
  vase: "Pour un vase : largeur = diamètre, profondeur = diamètre.",
  lamp: "Pour une lampe : largeur = diamètre de l’abat-jour.",
  plant: "Pour une plante : largeur = envergure du feuillage.",
  frame: "Pour un cadre : profondeur = épaisseur du cadre.",
  mirror: "Pour un miroir : profondeur = épaisseur.",
  clock: "Pour une horloge : profondeur = épaisseur.",
  rug: "Pour un tapis : largeur × profondeur au sol, hauteur = épaisseur.",
  furniture: "Pour un meuble : largeur × hauteur × profondeur hors tout.",
  other: "Renseignez les mesures au point le plus large.",
};

const viewOrder = ["front", "three_quarter", "side", "back", "detail"] as const;

export function AdminProductForm({ productId }: { productId?: string }) {
  const router = useRouter();
  const editing = Boolean(productId);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [product, setProduct] = useState<AdminProduct | null>(null);
  const [frontFile, setFrontFile] = useState<File | null>(null);
  const [frontPreview, setFrontPreview] = useState("");
  const [loading, setLoading] = useState(editing);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!productId) return;
    void adminApi<AdminProduct>(`/products/${productId}`)
      .then((payload) => {
        setProduct(payload);
        setForm(toForm(payload));
      })
      .catch((reason: unknown) =>
        setError(
          reason instanceof Error ? reason.message : "Produit introuvable",
        ),
      )
      .finally(() => setLoading(false));
  }, [productId]);

  useEffect(
    () => () => {
      if (frontPreview) URL.revokeObjectURL(frontPreview);
    },
    [frontPreview],
  );

  const hint = useMemo(
    () => dimensionHints[form.objectType] ?? dimensionHints.other,
    [form.objectType],
  );

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function run(label: string, task: () => Promise<unknown>) {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await task();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Action impossible");
    } finally {
      setBusy("");
    }
  }

  async function save() {
    const payload = toPayload(form);
    if (!payload) {
      setError("Nom, matière et dimensions (largeur, hauteur) sont obligatoires.");
      return;
    }
    await run("save", async () => {
      if (editing && product) {
        const updated = await adminApi<AdminProduct>(`/products/${product.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        setProduct(updated);
        setForm(toForm(updated));
        setNotice("Fiche enregistrée.");
        router.refresh();
        return;
      }
      const created = await adminApi<AdminProduct>("/products", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (frontFile) {
        const prepared = await prepareImageForUpload(frontFile);
        const upload = new FormData();
        upload.set("file", prepared);
        upload.set("viewType", "front");
        await adminApi(`/products/${created.id}/views`, {
          method: "POST",
          body: upload,
        });
        await adminApi(`/products/${created.id}/actions`, {
          method: "POST",
          body: JSON.stringify({ action: "prepare" }),
        });
      }
      router.push(`/admin/produits/${created.id}`);
      router.refresh();
    });
  }

  async function uploadView(type: string, file: File) {
    if (!product) return;
    await run(`view:${type}`, async () => {
      const prepared = await prepareImageForUpload(file);
      const upload = new FormData();
      upload.set("file", prepared);
      upload.set("viewType", type);
      const updated = await adminApi<AdminProduct>(
        `/products/${product.id}/views`,
        { method: "POST", body: upload },
      );
      setProduct(updated);
      setNotice(
        type === "front"
          ? "Photo de face remplacée. Lancez la préparation pour republier."
          : "Vue ajoutée.",
      );
    });
  }

  async function removeView(type: string) {
    if (!product) return;
    await run(`view-delete:${type}`, async () => {
      const updated = await adminApi<AdminProduct>(
        `/products/${product.id}/views?type=${type}`,
        { method: "DELETE" },
      );
      setProduct(updated);
      setNotice("Vue supprimée.");
    });
  }

  async function action(name: string, label: string) {
    if (!product) return;
    await run(name, async () => {
      const updated = await adminApi<AdminProduct>(
        `/products/${product.id}/actions`,
        { method: "POST", body: JSON.stringify({ action: name }) },
      );
      if (name === "duplicate") {
        router.push(`/admin/produits/${updated.id}`);
        return;
      }
      setProduct(updated);
      setForm(toForm(updated));
      setNotice(label);
      router.refresh();
    });
  }

  async function destroy() {
    if (!product) return;
    const confirmed = window.confirm(
      `Supprimer définitivement « ${product.name} » et toutes ses images ?`,
    );
    if (!confirmed) return;
    await run("delete", async () => {
      await adminApi(`/products/${product.id}?permanent=true`, {
        method: "DELETE",
      });
      router.push("/admin/produits");
      router.refresh();
    });
  }

  if (loading) return <div className="bo-empty">Chargement de la fiche…</div>;
  if (editing && !product) {
    return <div className="bo-alert bo-alert-error">{error}</div>;
  }

  const viewsByType = new Map((product?.views ?? []).map((v) => [v.type, v]));

  return (
    <>
      <header className="bo-head">
        <div>
          <span className="bo-eyebrow">
            {editing ? "Catalogue · Modifier" : "Catalogue · Nouveau"}
          </span>
          <h1>{editing ? product?.name : "Nouveau produit."}</h1>
          <p>
            {editing
              ? `Créée le ${formatDate(product?.createdAt ?? null)} · modifiée le ${formatDate(product?.updatedAt ?? null)}`
              : "Renseignez la fiche, ajoutez la photo, puis publiez-la sur le site."}
          </p>
        </div>
        <div className="bo-head-actions">
          {product && (
            <span className={`bo-status bo-status-${product.status}`}>
              {statusLabels[product.status] ?? product.status}
            </span>
          )}
          <Link className="bo-button bo-button-ghost" href="/admin/produits">
            Retour
          </Link>
          <button
            className="bo-button bo-button-primary"
            type="button"
            onClick={() => void save()}
            disabled={busy === "save"}
          >
            {busy === "save" ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Save size={16} />
            )}
            {editing ? "Enregistrer" : "Créer la fiche"}
          </button>
        </div>
      </header>

      {error && <div className="bo-alert bo-alert-error">{error}</div>}
      {notice && <div className="bo-alert bo-alert-ok">{notice}</div>}

      <div className="bo-form-grid">
        <div className="bo-form-main">
          <section className="bo-panel">
            <div className="bo-panel-head">
              <div>
                <h2>Identité</h2>
                <p>Ce que le client voit dans le catalogue.</p>
              </div>
            </div>
            <div className="bo-field">
              <label htmlFor="name">Nom du produit *</label>
              <input
                id="name"
                value={form.name}
                onChange={(event) => set("name", event.target.value)}
                placeholder="Ex. Vase Sienne"
                required
              />
            </div>
            <div className="bo-grid-3">
              <TextField
                id="sku"
                label="Référence / SKU"
                value={form.sku}
                onChange={(value) => set("sku", value)}
                placeholder="VAS-042"
              />
              <TextField
                id="brand"
                label="Marque"
                value={form.brand}
                onChange={(value) => set("brand", value)}
                placeholder="Atelier Lili"
              />
              <TextField
                id="collection"
                label="Collection"
                value={form.collection}
                onChange={(value) => set("collection", value)}
                placeholder="Terracotta 2026"
              />
            </div>
            <div className="bo-grid-2">
              <div className="bo-field">
                <label htmlFor="objectType">Type d’objet *</label>
                <select
                  id="objectType"
                  value={form.objectType}
                  onChange={(event) => set("objectType", event.target.value)}
                >
                  {Object.entries(objectTypeLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="bo-field">
                <label htmlFor="placementType">Support conseillé *</label>
                <select
                  id="placementType"
                  value={form.placementType}
                  onChange={(event) => set("placementType", event.target.value)}
                >
                  {Object.entries(placementLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <TextField
              id="tags"
              label="Tags"
              value={form.tags}
              onChange={(value) => set("tags", value)}
              placeholder="artisanal, terracotta, salon"
              hint="Séparés par des virgules · 12 maximum"
            />
            <div className="bo-field">
              <label htmlFor="description">Description</label>
              <textarea
                id="description"
                rows={4}
                maxLength={2000}
                value={form.description}
                onChange={(event) => set("description", event.target.value)}
                placeholder="Quelques phrases sur la pièce, sa fabrication, ses finitions…"
              />
            </div>
          </section>

          <section className="bo-panel">
            <div className="bo-panel-head">
              <div>
                <h2>Dimensions & matière</h2>
                <p>{hint}</p>
              </div>
            </div>
            <div className="bo-grid-3">
              <NumberField
                id="widthCm"
                label="Largeur / longueur *"
                unit="cm"
                value={form.widthCm}
                onChange={(value) => set("widthCm", value)}
              />
              <NumberField
                id="heightCm"
                label="Hauteur *"
                unit="cm"
                value={form.heightCm}
                onChange={(value) => set("heightCm", value)}
              />
              <NumberField
                id="depthCm"
                label="Profondeur"
                unit="cm"
                value={form.depthCm}
                onChange={(value) => set("depthCm", value)}
              />
            </div>
            <div className="bo-grid-2">
              <TextField
                id="material"
                label="Matière principale *"
                value={form.material}
                onChange={(value) => set("material", value)}
                placeholder="Céramique mate, chêne massif…"
              />
              <NumberField
                id="weightKg"
                label="Poids"
                unit="kg"
                step="0.01"
                value={form.weightKg}
                onChange={(value) => set("weightKg", value)}
              />
            </div>
          </section>

          <section className="bo-panel">
            <div className="bo-panel-head">
              <div>
                <h2>Tailles & déclinaisons</h2>
                <p>
                  Une ligne par taille disponible. Laissez vide si le produit
                  existe en un seul format.
                </p>
              </div>
              <button
                className="bo-button bo-button-ghost"
                type="button"
                onClick={() =>
                  set("variants", [...form.variants, emptyVariant()])
                }
              >
                <Plus size={15} /> Ajouter une taille
              </button>
            </div>
            {form.variants.length === 0 && (
              <div className="bo-empty">Aucune déclinaison enregistrée.</div>
            )}
            {form.variants.map((variant, index) => (
              <div className="bo-variant" key={variant.key}>
                <div className="bo-grid-2">
                  <TextField
                    id={`variant-label-${variant.key}`}
                    label="Libellé *"
                    value={variant.label}
                    onChange={(value) =>
                      set(
                        "variants",
                        replaceAt(form.variants, index, { label: value }),
                      )
                    }
                    placeholder="Grand modèle · 120 cm"
                  />
                  <TextField
                    id={`variant-sku-${variant.key}`}
                    label="SKU"
                    value={variant.sku}
                    onChange={(value) =>
                      set(
                        "variants",
                        replaceAt(form.variants, index, { sku: value }),
                      )
                    }
                  />
                </div>
                <div className="bo-grid-5">
                  <NumberField
                    id={`variant-width-${variant.key}`}
                    label="Largeur"
                    unit="cm"
                    value={variant.widthCm}
                    onChange={(value) =>
                      set(
                        "variants",
                        replaceAt(form.variants, index, { widthCm: value }),
                      )
                    }
                  />
                  <NumberField
                    id={`variant-height-${variant.key}`}
                    label="Hauteur"
                    unit="cm"
                    value={variant.heightCm}
                    onChange={(value) =>
                      set(
                        "variants",
                        replaceAt(form.variants, index, { heightCm: value }),
                      )
                    }
                  />
                  <NumberField
                    id={`variant-depth-${variant.key}`}
                    label="Profondeur"
                    unit="cm"
                    value={variant.depthCm}
                    onChange={(value) =>
                      set(
                        "variants",
                        replaceAt(form.variants, index, { depthCm: value }),
                      )
                    }
                  />
                  <NumberField
                    id={`variant-price-${variant.key}`}
                    label="Prix"
                    unit={form.currency}
                    step="0.01"
                    value={variant.price}
                    onChange={(value) =>
                      set(
                        "variants",
                        replaceAt(form.variants, index, { price: value }),
                      )
                    }
                  />
                  <NumberField
                    id={`variant-stock-${variant.key}`}
                    label="Stock"
                    step="1"
                    value={variant.stock}
                    onChange={(value) =>
                      set(
                        "variants",
                        replaceAt(form.variants, index, { stock: value }),
                      )
                    }
                  />
                </div>
                <div className="bo-variant-footer">
                  <label className="bo-switch">
                    <input
                      type="checkbox"
                      checked={variant.available}
                      onChange={(event) =>
                        set(
                          "variants",
                          replaceAt(form.variants, index, {
                            available: event.target.checked,
                          }),
                        )
                      }
                    />
                    Disponible à la vente
                  </label>
                  <button
                    className="bo-icon-button danger"
                    type="button"
                    title="Retirer cette taille"
                    onClick={() =>
                      set(
                        "variants",
                        form.variants.filter((item) => item.key !== variant.key),
                      )
                    }
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            ))}
          </section>

          <section className="bo-panel">
            <div className="bo-panel-head">
              <div>
                <h2>Rendu IA</h2>
                <p>
                  Ces réglages guident la génération sans pouvoir modifier la
                  couleur ni la silhouette du produit.
                </p>
              </div>
            </div>
            <div className="bo-grid-2">
              <div className="bo-field">
                <label htmlFor="lightingSource">Lumière de la photo</label>
                <select
                  id="lightingSource"
                  value={form.lightingSource}
                  onChange={(event) => set("lightingSource", event.target.value)}
                >
                  <option value="front">Face uniforme</option>
                  <option value="softbox-left">Diffuse, depuis la gauche</option>
                  <option value="softbox-right">Diffuse, depuis la droite</option>
                </select>
              </div>
              <div className="bo-field">
                <label htmlFor="reflectance">Aspect de la matière</label>
                <select
                  id="reflectance"
                  value={form.reflectance}
                  onChange={(event) => set("reflectance", event.target.value)}
                >
                  <option value="matte">Mat</option>
                  <option value="satin">Satiné</option>
                  <option value="glossy">Brillant</option>
                </select>
              </div>
            </div>
            <div className="bo-field">
              <label htmlFor="generationInstructions">
                Instructions de génération
              </label>
              <textarea
                id="generationInstructions"
                rows={4}
                maxLength={1500}
                value={form.generationInstructions}
                onChange={(event) =>
                  set("generationInstructions", event.target.value)
                }
                placeholder="Ombre de contact douce, conserver les reflets satinés…"
              />
            </div>
          </section>
        </div>

        <aside className="bo-form-side">
          <section className="bo-panel">
            <div className="bo-panel-head">
              <div>
                <h2>Commercial</h2>
                <p>Prix affiché et disponibilité.</p>
              </div>
            </div>
            <div className="bo-grid-2">
              <NumberField
                id="price"
                label="Prix"
                step="0.01"
                value={form.price}
                onChange={(value) => set("price", value)}
              />
              <TextField
                id="currency"
                label="Devise"
                value={form.currency}
                onChange={(value) => set("currency", value.toUpperCase())}
                placeholder="TND"
              />
            </div>
            <NumberField
              id="stock"
              label="Stock disponible"
              step="1"
              value={form.stock}
              onChange={(value) => set("stock", value)}
            />
            <TextField
              id="buyUrl"
              label="Lien d’achat"
              value={form.buyUrl}
              onChange={(value) => set("buyUrl", value)}
              placeholder="https://boutique.exemple/vase"
            />
          </section>

          <section className="bo-panel">
            <div className="bo-panel-head">
              <div>
                <h2>Photos</h2>
                <p>
                  {editing
                    ? "La vue de face alimente le détourage utilisé par le rendu."
                    : "Ajoutez la vue de face ; les autres angles s’ajoutent après création."}
                </p>
              </div>
            </div>

            {!editing && (
              <label className="bo-upload">
                {frontPreview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={frontPreview} alt="Aperçu du produit" />
                ) : (
                  <>
                    <ImagePlus size={30} />
                    <strong>Choisir la photo de face</strong>
                    <span>PNG, JPEG ou WebP · fond neutre recommandé</span>
                  </>
                )}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(event) => {
                    const selected = event.target.files?.[0] ?? null;
                    setFrontFile(selected);
                    setFrontPreview(
                      selected ? URL.createObjectURL(selected) : "",
                    );
                  }}
                />
              </label>
            )}

            {editing && (
              <div className="bo-views">
                {viewOrder.map((type) => {
                  const view = viewsByType.get(type);
                  return (
                    <div className="bo-view" key={type}>
                      <label className="bo-view-slot">
                        {view?.url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={view.url} alt={viewLabels[type]} />
                        ) : (
                          <ImagePlus size={18} />
                        )}
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          aria-label={`Vue ${viewLabels[type]}`}
                          onChange={(event) => {
                            const selected = event.target.files?.[0];
                            if (selected) void uploadView(type, selected);
                            event.target.value = "";
                          }}
                        />
                      </label>
                      <div className="bo-view-meta">
                        <strong>{viewLabels[type]}</strong>
                        {busy === `view:${type}` ? (
                          <small>Envoi…</small>
                        ) : view ? (
                          <button
                            type="button"
                            className="bo-link-danger"
                            onClick={() => void removeView(type)}
                          >
                            Retirer
                          </button>
                        ) : (
                          <small>Vide</small>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {editing && (
              <button
                className="bo-button bo-button-secondary bo-button-block"
                type="button"
                onClick={() => void action("prepare", "Détourage régénéré.")}
                disabled={busy === "prepare"}
              >
                {busy === "prepare" ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Wand2 size={16} />
                )}
                Détourer et préparer
              </button>
            )}
          </section>

          {editing && product && (
            <section className="bo-panel">
              <div className="bo-panel-head">
                <div>
                  <h2>Publication</h2>
                  <p>
                    {product.hasCutout
                      ? "Le produit dispose d’un détourage exploitable."
                      : "Préparez le détourage avant de publier."}
                  </p>
                </div>
              </div>
              <div className="bo-actions-column">
                {product.status === "ready" ? (
                  <button
                    className="bo-button bo-button-secondary"
                    type="button"
                    onClick={() => void action("unpublish", "Produit dépublié.")}
                  >
                    <EyeOff size={16} /> Dépublier
                  </button>
                ) : (
                  <button
                    className="bo-button bo-button-secondary"
                    type="button"
                    onClick={() => void action("publish", "Produit publié.")}
                  >
                    <CheckCircle2 size={16} /> Publier sur le site
                  </button>
                )}
                {product.status === "archived" ? (
                  <button
                    className="bo-button bo-button-ghost"
                    type="button"
                    onClick={() => void action("restore", "Produit restauré.")}
                  >
                    <ArchiveRestore size={16} /> Restaurer
                  </button>
                ) : (
                  <button
                    className="bo-button bo-button-ghost"
                    type="button"
                    onClick={() => void action("archive", "Produit archivé.")}
                  >
                    <Archive size={16} /> Archiver
                  </button>
                )}
                {product.temporary && (
                  <button
                    className="bo-button bo-button-ghost"
                    type="button"
                    onClick={() =>
                      void action("persist", "Produit rendu permanent.")
                    }
                  >
                    Rendre permanent (expire le{" "}
                    {formatDate(product.expiresAt)})
                  </button>
                )}
                {product.status === "ready" && (
                  <a
                    className="bo-button bo-button-ghost"
                    href={`/demo?product=${product.id}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <ExternalLink size={16} /> Tester dans le visualiseur
                  </a>
                )}
                <button
                  className="bo-button bo-button-ghost"
                  type="button"
                  onClick={() => void action("duplicate", "Produit dupliqué.")}
                >
                  Dupliquer la fiche
                </button>
                <button
                  className="bo-button bo-button-danger"
                  type="button"
                  onClick={() => void destroy()}
                  disabled={busy === "delete"}
                >
                  <Trash2 size={16} /> Supprimer définitivement
                </button>
              </div>
            </section>
          )}
        </aside>
      </div>
    </>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <div className="bo-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint && <small>{hint}</small>}
    </div>
  );
}

function NumberField({
  id,
  label,
  value,
  onChange,
  unit,
  step = "0.1",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  unit?: string;
  step?: string;
}) {
  return (
    <div className="bo-field">
      <label htmlFor={id}>{label}</label>
      <div className={unit ? "bo-unit-input" : undefined}>
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min="0"
          step={step}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        {unit && <span>{unit}</span>}
      </div>
    </div>
  );
}

function emptyVariant(): VariantRow {
  return {
    key: crypto.randomUUID(),
    label: "",
    sku: "",
    widthCm: "",
    heightCm: "",
    depthCm: "",
    price: "",
    stock: "",
    available: true,
  };
}

function replaceAt(
  variants: VariantRow[],
  index: number,
  patch: Partial<VariantRow>,
): VariantRow[] {
  return variants.map((variant, position) =>
    position === index ? { ...variant, ...patch } : variant,
  );
}

function toForm(product: AdminProduct): FormState {
  return {
    name: product.name,
    description: product.description,
    objectType: product.objectType,
    placementType: product.placementType,
    material: product.material,
    sku: product.sku ?? "",
    brand: product.brand ?? "",
    collection: product.collection ?? "",
    tags: (product.tags ?? []).join(", "),
    widthCm: String(product.widthCm),
    heightCm: String(product.heightCm),
    depthCm: String(product.depthCm),
    weightKg: product.weightKg === null ? "" : String(product.weightKg),
    price: product.priceCents === null ? "" : (product.priceCents / 100).toFixed(2),
    currency: product.currency || "TND",
    stock: product.stock === null ? "" : String(product.stock),
    buyUrl: product.buyUrl ?? "",
    generationInstructions: product.generationInstructions ?? "",
    lightingSource: product.lightingSource || "front",
    reflectance: product.reflectance || "matte",
    variants: (product.variants ?? []).map((variant) => ({
      key: variant.id,
      id: variant.id,
      label: variant.label,
      sku: variant.sku ?? "",
      widthCm: variant.widthCm === null ? "" : String(variant.widthCm),
      heightCm: variant.heightCm === null ? "" : String(variant.heightCm),
      depthCm: variant.depthCm === null ? "" : String(variant.depthCm),
      price:
        variant.priceCents === null ? "" : (variant.priceCents / 100).toFixed(2),
      stock: variant.stock === null ? "" : String(variant.stock),
      available: variant.available,
    })),
  };
}

function toPayload(form: FormState): Record<string, unknown> | null {
  const width = numberOrNull(form.widthCm);
  const height = numberOrNull(form.heightCm);
  if (!form.name.trim() || !form.material.trim() || !width || !height) {
    return null;
  }
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    objectType: form.objectType,
    placementType: form.placementType,
    material: form.material.trim(),
    sku: form.sku.trim() || null,
    brand: form.brand.trim(),
    collection: form.collection.trim(),
    tags: form.tags,
    widthCm: width,
    heightCm: height,
    depthCm: numberOrNull(form.depthCm) ?? 0,
    weightKg: numberOrNull(form.weightKg),
    priceCents: centsOrNull(form.price),
    currency: form.currency.trim() || "TND",
    stock: numberOrNull(form.stock),
    buyUrl: form.buyUrl.trim() || null,
    generationInstructions: form.generationInstructions.trim(),
    lightingSource: form.lightingSource,
    reflectance: form.reflectance,
    variants: form.variants
      .filter((variant) => variant.label.trim())
      .map((variant) => ({
        ...(variant.id ? { id: variant.id } : {}),
        label: variant.label.trim(),
        sku: variant.sku.trim() || null,
        widthCm: numberOrNull(variant.widthCm),
        heightCm: numberOrNull(variant.heightCm),
        depthCm: numberOrNull(variant.depthCm),
        priceCents: centsOrNull(variant.price),
        stock: numberOrNull(variant.stock),
        available: variant.available,
      })),
  };
}

function numberOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function centsOrNull(value: string): number | null {
  const parsed = numberOrNull(value);
  return parsed === null ? null : Math.round(parsed * 100);
}
