"use client";
import { useState } from "react";
import { planarTextureInputSchema } from "@lili/types";
import { adminApi, viewLabels, type AdminProduct } from "@/lib/admin-client";
import { currentPlanarTexture } from "@/lib/planar-texture";

export function PlanarTextureEditor({
  product,
  onSaved,
}: {
  product: AdminProduct;
  onSaved: (product: AdminProduct) => void;
}) {
  const saved = currentPlanarTexture(product);
  const photos = [
    ...(product.sourceAssetId && product.assetUrl
      ? [
          {
            id: product.sourceAssetId,
            url: product.assetUrl,
            label: "Photo principale",
          },
        ]
      : []),
    ...product.views
      .filter((v) => v.validationStatus === "valid" && v.url)
      .map((v) => ({
        id: v.assetId,
        url: v.url!,
        label: viewLabels[v.type] ?? v.type,
      })),
  ].filter((p, i, all) => all.findIndex((q) => q.id === p.id) === i);
  const [assetId, setAssetId] = useState(saved?.assetId ?? photos[0]?.id ?? "");
  const [corners, setCorners] = useState<Array<{ x: number; y: number }>>(
    saved?.corners ?? [],
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const photo = photos.find((p) => p.id === assetId);
  const validation = planarTextureInputSchema.safeParse({ assetId, corners });
  async function save(remove = false) {
    setBusy(true);
    setError("");
    try {
      onSaved(
        await adminApi<AdminProduct>(`/products/${product.id}/planar-texture`, {
          method: remove ? "DELETE" : "PUT",
          ...(!remove ? { body: JSON.stringify({ assetId, corners }) } : {}),
        }),
      );
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Enregistrement impossible",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="bo-panel" aria-label="Texture du tapis">
      <h2>Texture du tapis</h2>
      <p>
        Dimensions enregistrées : {product.widthCm} × {product.depthCm} cm.
        Enregistrez toute modification de ces mesures avant de choisir les
        coins.
      </p>
      <p>
        Choisissez une photo du tapis entier, à plat, sans meuble dessus.
        Cliquez sur ses coins dans cet ordre : haut gauche, haut droit, bas
        droit, bas gauche. Le premier côté correspond à la largeur ; le suivant
        à la profondeur.
      </p>
      <p>
        Cette sélection prépare la texture pour les essais internes de
        placement. Le studio expérimental reste réservé aux boutiques activées.
      </p>
      {!photo ? (
        <p>Ajoutez d’abord une photo à la fiche.</p>
      ) : (
        <>
          <label>
            Photo de texture
            <select
              value={assetId}
              disabled={busy}
              onChange={(event) => {
                const id = event.target.value;
                setAssetId(id);
                setCorners(saved?.assetId === id ? saved.corners : []);
                setError("");
              }}
            >
              {photos.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            aria-label="Choisir les quatre coins du tapis"
            disabled={busy || corners.length === 4}
            style={{
              position: "relative",
              display: "block",
              width: "100%",
              padding: 0,
              border: 0,
              lineHeight: 0,
              marginTop: 12,
            }}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setCorners((previous) =>
                [
                  ...previous,
                  {
                    x: Math.max(
                      0,
                      Math.min(1, (event.clientX - rect.left) / rect.width),
                    ),
                    y: Math.max(
                      0,
                      Math.min(1, (event.clientY - rect.top) / rect.height),
                    ),
                  },
                ].slice(0, 4),
              );
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photo.url}
              alt="Photo source du tapis"
              style={{ display: "block", width: "100%", height: "auto" }}
            />
            <svg
              viewBox="0 0 1000 1000"
              preserveAspectRatio="none"
              aria-label="Coins sélectionnés"
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                pointerEvents: "none",
              }}
            >
              {corners.length > 1 && (
                <polyline
                  points={[
                    ...corners,
                    ...(corners.length === 4 ? [corners[0]!] : []),
                  ]
                    .map((p) => `${p.x * 1000},${p.y * 1000}`)
                    .join(" ")}
                  fill="none"
                  stroke="#00b9c9"
                  strokeWidth="4"
                />
              )}
              {corners.map((p, i) => (
                <g key={i}>
                  <circle
                    cx={p.x * 1000}
                    cy={p.y * 1000}
                    r="12"
                    fill="#004b55"
                  />
                  <text
                    x={p.x * 1000 + 18}
                    y={p.y * 1000 + 12}
                    fontSize="40"
                    fill="white"
                    stroke="#004b55"
                    strokeWidth="1"
                  >
                    {i + 1}
                  </text>
                </g>
              ))}
            </svg>
          </button>
          <p role="status">
            {corners.length < 4
              ? `Coin ${corners.length + 1} sur 4 : ${["haut gauche", "haut droit", "bas droit", "bas gauche"][corners.length]}.`
              : validation.success
                ? "Les quatre coins sont définis. Confirmez la sélection pour l’enregistrer."
                : "Les côtés se croisent ou certains coins se confondent. Recommencez dans l’ordre indiqué."}
          </p>
          <button
            type="button"
            disabled={busy || !corners.length}
            onClick={() => setCorners((previous) => previous.slice(0, -1))}
          >
            Annuler le dernier point
          </button>{" "}
          <button type="button" disabled={busy} onClick={() => setCorners([])}>
            Recommencer
          </button>{" "}
          <button
            type="button"
            className="bo-button bo-button-primary"
            disabled={busy || !validation.success}
            onClick={() => void save()}
          >
            Confirmer les coins
          </button>
          {saved && (
            <>
              <p>
                {saved.assetId === assetId
                  ? "Une sélection est enregistrée pour cette photo et ces dimensions."
                  : "Une sélection est enregistrée pour une autre photo de cette fiche."}
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => void save(true)}
              >
                Supprimer la sélection enregistrée
              </button>
            </>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
