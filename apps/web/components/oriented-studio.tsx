"use client";
/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from "react";
import type { Product } from "@lili/types";
import { getProducts, merchantApi } from "@/lib/api";
import { orientedStudioDraftSchema } from "@/lib/oriented-studio-draft";

type Scene = { id: string; imageUrl: string; expiresAt: string };
type Preview = {
  previewUrl: string;
  planFingerprint: string;
  reconstructed: boolean;
  limitations: string[];
  unknownFaces: string[];
};
type Job = {
  id: string;
  status: string;
  pipelineState?: string;
  resultUrl?: string | null;
  compositeUrl?: string | null;
  error?: string | null;
  qualityDecision?: { feedback: string } | null;
  execution?: { errorCode?: string };
};
type Draft = {
  productId: string;
  variantId: string;
  scene: Scene | null;
  point: { x: number; y: number };
  surfaceType: "floor" | "tabletop" | "shelf";
  preview: Preview | null;
  requestKey: string;
  job: Job | null;
};
const initial: Draft = {
  productId: "",
  variantId: "",
  scene: null,
  point: { x: 0.5, y: 0.7 },
  surfaceType: "tabletop",
  preview: null,
  requestKey: "",
  job: null,
};
const stages: Record<string, string> = {
  uploaded: "En attente du traitement",
  analyzing_scene: "Analyse de la pièce",
  computing_geometry: "Choix de la vue et du placement",
  generating_final: "Ajustement de la lumière",
  quality_check: "Contrôle du produit et du décor",
  completed: "Rendu contrôlé",
  failed: "Rendu interrompu",
};
export function OrientedStudio({
  scope,
  allowedProductIds,
}: {
  scope: string;
  allowedProductIds: string[];
}) {
  const [products, setProducts] = useState<Product[]>([]),
    [draft, setDraft] = useState<Draft>(initial);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [ready, setReady] = useState(false);
  const [consent, setConsent] = useState(false);
  const [pollTick, setPollTick] = useState(0);
  const inflight = useRef(false),
    storageKey = `lili-oriented-v1:${scope}`;
  const update = (next: Draft) => {
    setDraft(next);
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* Draft remains usable without browser storage. */
    }
  };
  useEffect(() => {
    let active = true;
    getProducts(merchantApi)
      .then((items) => {
        if (!active) return;
        setProducts(items.filter((p) => allowedProductIds.includes(p.id)));
        try {
          const parsed = orientedStudioDraftSchema.safeParse(
            JSON.parse(sessionStorage.getItem(storageKey) ?? "null"),
          );
          const saved = parsed.success ? parsed.data : null;
          if (saved) {
            setDraft(
              saved.scene &&
                new Date(saved.scene.expiresAt).getTime() <= Date.now() && !saved.requestKey
                ? {
                    ...initial,
                    productId: saved.productId,
                    variantId: saved.variantId,
                  }
                : saved,
            );
          }
        } catch {
          /* Invalid or absent draft starts empty. */
        }
        setReady(true);
      })
      .catch((reason) => {
        if (active)
          setError(
            reason instanceof Error
              ? reason.message
              : "Catalogue indisponible.",
          );
      });
    return () => {
      active = false;
    };
  }, [storageKey, allowedProductIds]);
  useEffect(() => {
    if (
      (!draft.job && !draft.requestKey) ||
      (draft.job && !["queued", "processing"].includes(draft.job.status))
    )
      return;
    let active = true;
    const timer = setTimeout(() => {
      const path = draft.job
        ? `/v1/renders/${draft.job.id}`
        : `/v1/renders/by-request/${encodeURIComponent(draft.requestKey)}`;
      merchantApi<Job>(path, { cache: "no-store" })
        .then((job) => {
          if (!active) return;
          setDraft((current) => {
            const next = { ...current, job };
            try {
              sessionStorage.setItem(storageKey, JSON.stringify(next));
            } catch {
              /* Readonly browser storage. */
            }
            return next;
          });
          setError("");
        })
        .catch((reason) => {
          if (active)
            setError(
              reason instanceof Error
                ? reason.message
                : "Suivi indisponible. La demande reste conservée.",
            );
        })
        .finally(() => {
          if (active) setPollTick((t) => t + 1);
        });
    }, 2500);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [draft.job, draft.requestKey, storageKey, pollTick]);
  const product = products.find((p) => p.id === draft.productId);
  const unconfirmed = !!draft.requestKey && !draft.job;
  const running =
    unconfirmed ||
    (!!draft.job && ["queued", "processing"].includes(draft.job.status));
  function adjust(fields: Partial<Draft>) {
    update({ ...draft, ...fields, preview: null, requestKey: "", job: null });
    setError("");
  }
  async function act(work: () => Promise<void>) {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Cette étape est indisponible.",
      );
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }
  async function preview() {
    if (!draft.scene || !product) return;
    const result = await merchantApi<Preview>(
      `/v1/scenes/${draft.scene.id}/oriented-preview`,
      {
        method: "POST",
        body: JSON.stringify({
          productId: product.id,
          variantId: draft.variantId || null,
          point: draft.point,
          surfaceType: draft.surfaceType,
        }),
      },
    );
    update({ ...draft, preview: result, requestKey: "", job: null });
  }
  async function render() {
    if (!draft.scene || !product || !draft.preview) return;
    const requestKey = draft.requestKey || crypto.randomUUID();
    update({ ...draft, requestKey });
    const job = await merchantApi<Job>("/v1/renders", {
      method: "POST",
      body: JSON.stringify({
        engine: "oriented",
        workflow: "standard",
        mode: "insert",
        idempotencyKey: requestKey,
        placement: { sceneId: draft.scene.id, productId: product.id },
        placementPoint: draft.point,
        surfaceType: draft.surfaceType,
        orientedVariantId: draft.variantId || null,
        orientedPlanFingerprint: draft.preview.planFingerprint,
      }),
    });
    update({ ...draft, requestKey, job });
  }
  return (
    <section className="mx-auto max-w-5xl space-y-6 p-4 sm:p-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Essai de rendu orienté</h1>
        <p>
          Placez un article dans votre pièce, vérifiez l’aperçu puis demandez
          son rendu. Cet espace est réservé aux essais internes.
        </p>
      </header>
      {error && (
        <div role="alert" className="alert alert-error">
          {error}
        </div>
      )}
      <fieldset
        disabled={busy || running || !ready}
        className="grid gap-4 sm:grid-cols-2"
      >
        <label className="space-y-2">
          <span>Article</span>
          <select
            className="select w-full"
            value={draft.productId}
            onChange={(e) =>
              adjust({ productId: e.target.value, variantId: "" })
            }
          >
            <option value="">Choisir un article</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {!!product?.variants?.length && (
          <label className="space-y-2">
            <span>Variante</span>
            <select
              className="select w-full"
              value={draft.variantId}
              onChange={(e) => adjust({ variantId: e.target.value })}
            >
              <option value="">Choisir une variante</option>
              {product.variants
                .filter((v) => v.available)
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label className="space-y-2">
          <span>Support</span>
          <select
            className="select w-full"
            value={draft.surfaceType}
            onChange={(e) =>
              adjust({ surfaceType: e.target.value as Draft["surfaceType"] })
            }
          >
            <option value="tabletop">Table ou meuble bas</option>
            <option value="floor">Sol</option>
            <option value="shelf">Étagère</option>
          </select>
        </label>
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            className="checkbox mt-1"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
          />
          <span>
            J’autorise l’utilisation de cette photo pour cet essai privé.
          </span>
        </label>
        <label className="space-y-2 sm:col-span-2">
          <span>Photo de la pièce</span>
          <input
            className="file-input w-full"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={!consent}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file)
                void act(async () => {
                  const form = new FormData();
                  form.set("file", file);
                  form.set("consent", "true");
                  const scene = await merchantApi<Scene>("/v1/scenes", {
                    method: "POST",
                    body: form,
                  });
                  adjust({ scene });
                });
            }}
          />
        </label>
      </fieldset>
      {draft.scene && (
        <div className="space-y-3">
          <p id="oriented-placement-help">
            Touchez le point d’appui de l’objet. Vous pouvez aussi le déplacer
            avec les flèches du clavier.
          </p>
          <button
            type="button"
            disabled={busy || running}
            aria-label="Choisir le point d’appui dans la pièce"
            aria-describedby="oriented-placement-help"
            className="relative block w-full overflow-hidden rounded-box border border-base-300 focus-visible:outline-2 focus-visible:outline-offset-4"
            onClick={(event) => {
              if (event.detail === 0) return;
              const box = event.currentTarget.getBoundingClientRect();
              adjust({
                point: {
                  x: Math.max(
                    0,
                    Math.min(1, (event.clientX - box.left) / box.width),
                  ),
                  y: Math.max(
                    0,
                    Math.min(1, (event.clientY - box.top) / box.height),
                  ),
                },
              });
            }}
            onKeyDown={(event) => {
              const moves: Record<string, [number, number]> = {
                ArrowLeft: [-0.01, 0],
                ArrowRight: [0.01, 0],
                ArrowUp: [0, -0.01],
                ArrowDown: [0, 0.01],
              };
              const move = moves[event.key];
              if (move) {
                event.preventDefault();
                adjust({
                  point: {
                    x: Math.min(1, Math.max(0, draft.point.x + move[0])),
                    y: Math.min(1, Math.max(0, draft.point.y + move[1])),
                  },
                });
              }
            }}
          >
            <img
              className="block h-auto w-full"
              src={draft.scene.imageUrl}
              alt="Votre pièce"
            />
            <span
              aria-hidden="true"
              className="pointer-events-none absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-4 border-base-100 bg-primary shadow"
              style={{
                left: `${draft.point.x * 100}%`,
                top: `${draft.point.y * 100}%`,
              }}
            />
          </button>
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        <button
          className="btn"
          disabled={
            busy ||
            running ||
            !product ||
            !draft.scene ||
            (!!product.variants?.length && !draft.variantId)
          }
          onClick={() => void act(preview)}
        >
          {busy ? "Traitement en cours…" : "Calculer l’aperçu"}
        </button>
        <button
          className="btn btn-primary"
          disabled={
            busy ||
            (running && !unconfirmed) ||
            !ready ||
            !product ||
            !draft.scene ||
            !draft.preview ||
            draft.job?.execution?.errorCode === "provider_unknown"
          }
          onClick={() => void act(render)}
        >
          {unconfirmed ? "Retrouver la même demande" : "Demander le rendu"}
        </button>
      </div>
      {unconfirmed && (
        <p role="status">
          La confirmation de la demande est attendue. Vos réglages restent
          conservés pendant sa récupération.
        </p>
      )}
      {draft.preview && (
        <article className="card card-border">
          <div className="card-body">
            <h2 className="card-title">Aperçu du placement</h2>
            <p>
              Échelle estimée. L’éclairage final n’a pas encore été validé.
              {draft.preview.reconstructed
                ? " Certaines parties de la vue ont été reconstruites."
                : ""}
            </p>
            {[...draft.preview.limitations, ...draft.preview.unknownFaces].map(
              (text, i) => (
                <p key={i}>{text}</p>
              ),
            )}
          </div>
          <figure>
            <img
              className="w-full"
              src={draft.preview.previewUrl}
              alt="Aperçu calculé avec la vue sélectionnée"
            />
          </figure>
        </article>
      )}
      {draft.job && (
        <article className="card card-border" aria-live="polite">
          <div className="card-body">
            <h2 className="card-title">
              {draft.job.status === "succeeded"
                ? "Rendu contrôlé"
                : draft.job.status === "failed"
                  ? "Rendu refusé"
                  : (stages[draft.job.pipelineState ?? "uploaded"] ??
                    "Traitement en cours")}
            </h2>
            <p>{draft.job.error ?? draft.job.qualityDecision?.feedback}</p>
            {draft.job.status === "failed" && (
              <p>Votre photo et votre point d’appui sont conservés.</p>
            )}
          </div>
          {draft.job.status === "succeeded" && draft.job.resultUrl && (
            <figure>
              <img
                className="w-full"
                src={draft.job.resultUrl}
                alt="Rendu final contrôlé"
              />
            </figure>
          )}
        </article>
      )}
    </section>
  );
}
