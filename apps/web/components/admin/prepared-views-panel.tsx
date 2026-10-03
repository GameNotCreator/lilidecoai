"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import type { PreparedProductView, PreparedViewReview } from "@lili/types";
import { reviewPreparedViewRequestSchema } from "@lili/types";
import {
  adminApi,
  formatDate,
  viewLabels,
  type AdminProduct,
} from "@/lib/admin-client";

type Criterion = keyof PreparedViewReview["criteria"];
type Verdict = PreparedViewReview["criteria"][Criterion];
const criteriaLabels: Record<Criterion, string> = {
  identity: "Identité du produit",
  silhouette: "Forme et parties fines",
  color: "Couleurs",
  pattern: "Motifs et détails",
  alpha: "Qualité du détourage",
  contact: "Point de contact",
};
const states: Record<PreparedProductView["state"], string> = {
  queued: "En attente",
  preparing: "Préparation en cours",
  needs_review: "À examiner",
  approved: "Approuvée pour aperçu interne",
  rejected: "Refusée",
  revoked: "Révoquée",
  stale: "À revalider",
  failed: "Préparation interrompue",
};
interface TaskSummary {
  id: string;
  viewId: string;
  state: string;
  providerOutcome: string;
  failure?: string;
  costUsd: number;
  matteRetry?: {
    eligible: boolean;
    reason: string | null;
  };
}
interface Library {
  views: PreparedProductView[];
  tasks?: TaskSummary[];
}
const assetUrl = (id: string) => `/api/assets/${encodeURIComponent(id)}`;
const lines = (value: string) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
const errorText = (reason: unknown) =>
  reason instanceof Error
    ? reason.message
    : "L’action n’a pas pu être enregistrée.";

export function PreparedViewsPanel({
  product,
  disabled = false,
}: {
  product: AdminProduct;
  disabled?: boolean;
}) {
  const [library, setLibrary] = useState<Library>({ views: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [retryingViewId, setRetryingViewId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [preset, setPreset] = useState<"front" | "three_quarter" | "top">(
    "top",
  );
  const [variantId, setVariantId] = useState("");
  const inFlight = useRef(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const path = `/products/${encodeURIComponent(product.id)}/prepared-views`;
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const next = await adminApi<Library>(path, { signal });
      setLibrary(next);
    },
    [path],
  );

  useEffect(() => {
    const abort = new AbortController();
    void adminApi<Library>(path, { signal: abort.signal })
      .then((next) => {
        if (!abort.signal.aborted) setLibrary(next);
      })
      .catch((reason) => {
        if (!abort.signal.aborted) setError(errorText(reason));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [path, product.updatedAt]);

  const pending = library.views.some((view) =>
    ["queued", "preparing"].includes(view.state),
  );
  useEffect(() => {
    if (!pending) return;
    const abort = new AbortController();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible")
        void refresh(abort.signal).catch(() => {});
    }, 4_000);
    return () => {
      window.clearInterval(timer);
      abort.abort();
    };
  }, [pending, refresh]);

  async function prepare() {
    if (inFlight.current || disabled) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      // Retain the same key after a lost response or page refresh.
      const storageKey = `prepared-view:${product.id}:${product.updatedAt}:${variantId}:${preset}`;
      const idempotencyKey =
        sessionStorage.getItem(storageKey) ?? crypto.randomUUID();
      sessionStorage.setItem(storageKey, idempotencyKey);
      const result = await adminApi<{
        reused: boolean;
        providerOutcome: string;
      }>(path, {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey,
          variantId: variantId || null,
          expectedProductRevision: product.updatedAt,
          preset,
        }),
      });
      setNotice(
        result.providerOutcome === "unknown"
          ? "La réponse du fournisseur est inconnue. La préparation est conservée sans nouvelle génération."
          : result.reused
            ? "La préparation existante a été retrouvée."
            : "Préparation enregistrée. Son état sera actualisé automatiquement.",
      );
      await refresh();
    } catch (reason) {
      setError(errorText(reason));
      requestAnimationFrame(() => errorRef.current?.focus());
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }

  async function retryMatte(view: PreparedProductView, task: TaskSummary) {
    if (inFlight.current || disabled || !task.matteRetry?.eligible) return;
    inFlight.current = true;
    setBusy(true);
    setRetryingViewId(view.id);
    setError("");
    setNotice("");
    try {
      // A lost response must reuse this exact retry, including after a refresh.
      const storageKey = `prepared-matte-retry:${product.id}:${product.updatedAt}:${view.id}:${view.revision}:${task.id}`;
      const idempotencyKey =
        sessionStorage.getItem(storageKey) ?? crypto.randomUUID();
      sessionStorage.setItem(storageKey, idempotencyKey);
      const result = await adminApi<{ reused: boolean }>(
        `${path}/${encodeURIComponent(view.id)}/retry-matte`,
        {
          method: "POST",
          body: JSON.stringify({
            idempotencyKey,
            expectedRevision: view.revision,
            expectedProductRevision: product.updatedAt,
          }),
        },
      );
      setNotice(
        result.reused
          ? "La demande de reprise existante a été retrouvée. Son état sera actualisé automatiquement."
          : "Reprise du détourage enregistrée à partir de l’image existante. La vue devra ensuite être examinée avant toute approbation.",
      );
      await refresh();
    } catch (reason) {
      setError(errorText(reason));
      requestAnimationFrame(() => errorRef.current?.focus());
    } finally {
      setBusy(false);
      setRetryingViewId(null);
      inFlight.current = false;
    }
  }

  const filtered = library.views.filter(
    (view) => view.variantId === (variantId || null),
  );
  return (
    <section
      className="card card-border mt-6 bg-base-100"
      aria-labelledby="prepared-views-title"
    >
      <div className="card-body gap-5">
        <div>
          <h2 className="card-title" id="prepared-views-title">
            Vues préparées · aperçu interne
          </h2>
          <p className="mt-2 text-sm">
            Préparez un angle réutilisable, comparez-le aux photos d’origine,
            puis consignez votre revue. Les candidats restent privés.
          </p>
        </div>
        {product.visualizationBlockedReason && (
          <p className="alert" role="status">
            Visualisation désactivée : {product.visualizationBlockedReason}. Une
            approbation de vue ne lève pas ce blocage.
          </p>
        )}
        {disabled && (
          <p className="text-sm">
            Enregistrez les modifications de la fiche avant de préparer ou
            revoir une vue.
          </p>
        )}
        {error && (
          <div
            ref={errorRef}
            tabIndex={-1}
            role="alert"
            className="alert alert-error"
          >
            {error}
          </div>
        )}
        {notice && (
          <p className="alert" role="status">
            {notice}
          </p>
        )}
        <div className="grid gap-4 md:grid-cols-[1fr_1fr_auto] md:items-end">
          <label className="fieldset">
            <span className="fieldset-legend">Variante</span>
            <select
              className="select w-full"
              value={variantId}
              onChange={(event) => setVariantId(event.target.value)}
              disabled={busy}
            >
              <option value="">Produit principal</option>
              {product.variants.map((variant) => (
                <option key={variant.id} value={variant.id}>
                  {variant.label}
                  {variant.available ? "" : " · indisponible"}
                </option>
              ))}
            </select>
          </label>
          <label className="fieldset">
            <span className="fieldset-legend">Angle à préparer</span>
            <select
              className="select w-full"
              value={preset}
              onChange={(event) =>
                setPreset(event.target.value as typeof preset)
              }
              disabled={busy}
            >
              <option value="front">Face</option>
              <option value="three_quarter">Trois-quarts</option>
              <option value="top">Vue plongeante</option>
            </select>
          </label>
          <button
            type="button"
            className="btn min-h-11"
            disabled={
              busy ||
              disabled ||
              !product.sourceAssetId ||
              Boolean(product.visualizationBlockedReason)
            }
            onClick={() => void prepare()}
          >
            {busy && !retryingViewId && (
              <span
                className="loading loading-spinner loading-sm"
                aria-hidden="true"
              />
            )}
            {busy && !retryingViewId ? "Enregistrement…" : "Préparer cette vue"}
          </button>
        </div>
        <p className="text-sm">
          Une photo catalogue compatible est réutilisée en priorité. Les faces
          non photographiées restent estimées, même après une revue humaine.
        </p>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm" aria-live="polite">
            {loading
              ? "Chargement des vues…"
              : `${filtered.length} vue${filtered.length > 1 ? "s" : ""} pour cette variante`}
          </p>
          <button
            type="button"
            className="btn btn-ghost min-h-11"
            disabled={busy || loading}
            onClick={() => {
              setError("");
              void refresh().catch((reason) => setError(errorText(reason)));
            }}
          >
            Actualiser
          </button>
        </div>
        {!loading && filtered.length === 0 && (
          <p className="rounded-box border border-base-300 p-5 text-sm">
            Aucune vue préparée. L’angle demandé ne sera disponible pour le
            rendu interne qu’après préparation et approbation.
          </p>
        )}
        <div className="grid gap-5">
          {filtered.map((view) => (
            <PreparedViewCard
              key={`${view.id}:${view.revision}`}
              view={view}
              task={library.tasks?.find(
                (task) => task.id === view.preparation.taskId,
              )}
              productName={product.name}
              path={path}
              disabled={disabled || busy}
              retrying={retryingViewId === view.id}
              onRetryMatte={retryMatte}
              onSaved={refresh}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function PreparedViewCard({
  view,
  task,
  productName,
  path,
  disabled,
  retrying,
  onRetryMatte,
  onSaved,
}: {
  view: PreparedProductView;
  task?: TaskSummary;
  productName: string;
  path: string;
  disabled: boolean;
  retrying: boolean;
  onRetryMatte: (view: PreparedProductView, task: TaskSummary) => Promise<void>;
  onSaved: () => Promise<void>;
}) {
  return (
    <article className="rounded-box border border-base-300 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-semibold">
          {view.origin === "photographed"
            ? "Vue photographique"
            : "Vue générée"}{" "}
          · version {view.revision}
        </h3>
        <span className="badge h-auto min-h-6 whitespace-normal">
          {states[view.state]}
        </span>
      </div>
      <p className="mt-2 text-sm">
        Demandé : azimut {view.orientation.requested.azimuthDeg}°, plongée{" "}
        {view.orientation.requested.elevationDeg}°. Coût de préparation :{" "}
        {view.preparation.costUsd.toFixed(3)} USD.
      </p>
      {task?.providerOutcome === "unknown" && (
        <p className="alert mt-3" role="status">
          Réponse fournisseur inconnue. Une nouvelle génération automatique est
          bloquée.
        </p>
      )}
      {task?.failure && (
        <p className="alert mt-3" role="status">
          {task.failure}
        </p>
      )}
      {view.state === "failed" && (
        <div className="mt-4 space-y-3">
          {task?.matteRetry?.eligible ? (
            <>
              <p className="text-sm" id={`matte-retry-help-${view.id}`}>
                Reprend uniquement le détourage de l’image déjà enregistrée,
                sans nouvelle génération. La vue restera à examiner avant
                approbation.
              </p>
              <button
                type="button"
                className="btn min-h-11"
                disabled={disabled || retrying}
                aria-busy={retrying}
                aria-describedby={`matte-retry-help-${view.id}`}
                onClick={() => void onRetryMatte(view, task)}
              >
                {retrying && (
                  <span
                    className="loading loading-spinner loading-sm motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                )}
                {retrying
                  ? "Enregistrement de la reprise…"
                  : "Reprendre le détourage"}
              </button>
            </>
          ) : (
            <p className="text-sm">
              Reprise du détourage indisponible :{" "}
              {task?.matteRetry?.reason ??
                "le serveur n’a pas confirmé qu’une image enregistrée peut être réutilisée."}
            </p>
          )}
        </div>
      )}
      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <div>
          <h4 className="mb-2 text-sm font-semibold">Photos d’origine</h4>
          <div className="grid grid-cols-2 gap-2">
            {view.sources.map((source) => (
              <PrivateImage
                key={source.assetId}
                id={source.assetId}
                label={`${viewLabels[source.role] ?? source.role} · ${productName}`}
              />
            ))}
          </div>
        </div>
        <div>
          <h4 className="mb-2 text-sm font-semibold">Vue candidate</h4>
          {view.image ? (
            <PrivateImage
              id={view.image.assetId}
              label={`Vue candidate de ${productName}`}
            />
          ) : (
            <p className="text-sm">Image en attente</p>
          )}
        </div>
        <div>
          <h4 className="mb-2 text-sm font-semibold">Masque de détourage</h4>
          {view.alpha ? (
            <PrivateImage
              id={view.alpha.assetId}
              label={`Masque de détourage de ${productName}`}
            />
          ) : (
            <p className="text-sm">Masque non disponible</p>
          )}
        </div>
      </div>
      {view.review && (
        <div className="mt-4 text-sm">
          <p>
            Revue{" "}
            {view.review.kind === "human"
              ? "humaine"
              : view.review.kind === "agent"
                ? "par agent"
                : "automatique"}{" "}
            · {formatDate(view.review.reviewedAt)} · {view.review.actorId}
          </p>
          {view.review.limits.length > 0 && (
            <p>Limites : {view.review.limits.join(" ; ")}</p>
          )}
          {view.review.unknownFaces.length > 0 && (
            <p>Faces inconnues : {view.review.unknownFaces.join(" ; ")}</p>
          )}
        </div>
      )}
      {view.revocation && (
        <p className="mt-3 text-sm">Révocation : {view.revocation.reason}</p>
      )}
      {["needs_review", "approved", "rejected", "stale"].includes(view.state) &&
        view.image && (
          <details className="collapse collapse-arrow mt-4 border border-base-300">
            <summary className="collapse-title font-semibold">
              Examiner et consigner une revue humaine
            </summary>
            <div className="collapse-content">
              <ReviewForm
                view={view}
                path={path}
                disabled={disabled}
                onSaved={onSaved}
              />
            </div>
          </details>
        )}
      {view.state === "approved" && (
        <details className="collapse collapse-arrow mt-3 border border-base-300">
          <summary className="collapse-title font-semibold">
            Révoquer cette vue
          </summary>
          <div className="collapse-content">
            <RevokeForm
              view={view}
              path={path}
              disabled={disabled}
              onSaved={onSaved}
            />
          </div>
        </details>
      )}
    </article>
  );
}

function PrivateImage({ id, label }: { id: string; label: string }) {
  return (
    <a
      href={assetUrl(id)}
      target="_blank"
      rel="noreferrer"
      className="block rounded-box border border-base-300 p-2 focus-visible:outline-2 focus-visible:outline-offset-2"
      aria-label={`${label}, ouvrir en grand`}
    >
      {/* Private assets require the current administrator session. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={assetUrl(id)}
        alt={label}
        loading="lazy"
        width={360}
        height={280}
        className="aspect-[4/3] w-full object-contain"
      />
    </a>
  );
}

function ReviewForm({
  view,
  path,
  disabled,
  onSaved,
}: {
  view: PreparedProductView;
  path: string;
  disabled: boolean;
  onSaved: () => Promise<void>;
}) {
  const [criteria, setCriteria] = useState<PreparedViewReview["criteria"]>({
    identity: "indeterminate",
    silhouette: "indeterminate",
    color: "indeterminate",
    pattern: "indeterminate",
    alpha: "indeterminate",
    contact: "indeterminate",
  });
  const [decision, setDecision] =
    useState<PreparedViewReview["decision"]>("needs_review");
  const [orientation, setOrientation] = useState({
    azimuthDeg: "",
    elevationDeg: "",
    rollDeg: "",
  });
  const [coverage, setCoverage] = useState({
    azimuthMinDeg: "",
    azimuthMaxDeg: "",
    elevationMinDeg: "",
    elevationMaxDeg: "",
  });
  const [segment, setSegment] = useState({
    bottomX: "",
    bottomY: "",
    topX: "",
    topY: "",
  });
  const [activePoint, setActivePoint] = useState<"bottom" | "top">("bottom");
  const [limits, setLimits] = useState("");
  const [unknownFaces, setUnknownFaces] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const complete = (record: Record<string, string>) =>
    Object.values(record).every(
      (value) => value.trim() !== "" && Number.isFinite(Number(value)),
    );
  const numeric = (record: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(record).map(([key, value]) => [key, Number(value)]),
    );
  const approvalReady =
    Object.values(criteria).every((value) => value === "pass") &&
    complete(orientation) &&
    complete(coverage) &&
    complete(segment) &&
    Boolean(view.alpha) &&
    (view.anchor?.confidence ?? 0) >= 0.8;

  function markPoint(event: MouseEvent<HTMLButtonElement>) {
    // Keyboard users have the equivalent percentage fields below.
    if (event.detail === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.max(
      0,
      Math.min(100, ((event.clientX - rect.left) / rect.width) * 100),
    ).toFixed(1);
    const y = Math.max(
      0,
      Math.min(100, ((event.clientY - rect.top) / rect.height) * 100),
    ).toFixed(1);
    setSegment((value) => ({
      ...value,
      [`${activePoint}X`]: x,
      [`${activePoint}Y`]: y,
    }));
    if (activePoint === "bottom") setActivePoint("top");
  }

  async function save() {
    if (lock.current || disabled || !confirmed) return;
    setError("");
    const hasPartial = [orientation, coverage, segment].some(
      (record) =>
        Object.values(record).some((value) => value.trim() !== "") &&
        !complete(record),
    );
    if (hasPartial) {
      setError(
        "Complétez chaque groupe de mesures commencé, ou videz-le pour le laisser indéterminé.",
      );
      return;
    }
    const payload = {
      expectedRevision: view.revision,
      decision,
      criteria,
      estimatedOrientation: complete(orientation) ? numeric(orientation) : null,
      coverage: complete(coverage) ? numeric(coverage) : null,
      physicalHeightSegment: complete(segment)
        ? {
            bottom: {
              x: Number(segment.bottomX) / 100,
              y: Number(segment.bottomY) / 100,
            },
            top: {
              x: Number(segment.topX) / 100,
              y: Number(segment.topY) / 100,
            },
          }
        : null,
      limits: lines(limits),
      unknownFaces: lines(unknownFaces),
    };
    const validated = reviewPreparedViewRequestSchema.safeParse(payload);
    if (!validated.success) {
      setError(
        "Vérifiez les angles, l’ordre des bornes et les points : le sommet doit être au-dessus de la base, dans l’image.",
      );
      return;
    }
    lock.current = true;
    setBusy(true);
    try {
      await adminApi(`${path}/${encodeURIComponent(view.id)}/review`, {
        method: "POST",
        body: JSON.stringify(validated.data),
      });
      await onSaved();
    } catch (reason) {
      setError(errorText(reason));
      requestAnimationFrame(() => errorRef.current?.focus());
    } finally {
      setBusy(false);
      lock.current = false;
    }
  }

  return (
    <div className="space-y-5 pt-2">
      <p className="text-sm">
        Comparez les sources, la silhouette et les détails. Une vue agréable ne
        suffit pas à confirmer l’identité. L’approbation concerne uniquement un
        aperçu interne.
      </p>
      {error && (
        <div
          className="alert alert-error"
          role="alert"
          tabIndex={-1}
          ref={errorRef}
        >
          {error}
        </div>
      )}
      <fieldset className="fieldset" disabled={disabled || busy}>
        <legend className="fieldset-legend">Critères indépendants</legend>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(Object.keys(criteriaLabels) as Criterion[]).map((key) => (
            <label key={key} className="fieldset">
              <span>{criteriaLabels[key]}</span>
              <select
                className="select w-full"
                value={criteria[key]}
                onChange={(event) =>
                  setCriteria((value) => ({
                    ...value,
                    [key]: event.target.value as Verdict,
                  }))
                }
              >
                <option value="indeterminate">Indéterminé</option>
                <option value="pass">Conforme</option>
                <option value="fail">Non conforme</option>
              </select>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="fieldset" disabled={disabled || busy}>
        <legend className="fieldset-legend">
          Orientation observée dans le résultat
        </legend>
        <p className="mb-2 text-sm">
          Renseignez votre estimation après examen. L’angle demandé à la
          génération n’est pas une mesure du résultat.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <NumberField
            label="Azimut (−180° à 180°)"
            value={orientation.azimuthDeg}
            onChange={(value) =>
              setOrientation((old) => ({ ...old, azimuthDeg: value }))
            }
            min={-180}
            max={180}
          />
          <NumberField
            label="Plongée (0° à 90°)"
            value={orientation.elevationDeg}
            onChange={(value) =>
              setOrientation((old) => ({ ...old, elevationDeg: value }))
            }
            min={0}
            max={90}
          />
          <NumberField
            label="Inclinaison (−180° à 180°)"
            value={orientation.rollDeg}
            onChange={(value) =>
              setOrientation((old) => ({ ...old, rollDeg: value }))
            }
            min={-180}
            max={180}
          />
        </div>
      </fieldset>
      <fieldset className="fieldset" disabled={disabled || busy}>
        <legend className="fieldset-legend">
          Plage d’utilisation que vous approuvez
        </legend>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <NumberField
            label="Azimut minimum (°)"
            value={coverage.azimuthMinDeg}
            onChange={(value) =>
              setCoverage((old) => ({ ...old, azimuthMinDeg: value }))
            }
            min={-180}
            max={180}
          />
          <NumberField
            label="Azimut maximum (°)"
            value={coverage.azimuthMaxDeg}
            onChange={(value) =>
              setCoverage((old) => ({ ...old, azimuthMaxDeg: value }))
            }
            min={-180}
            max={180}
          />
          <NumberField
            label="Plongée minimum (°)"
            value={coverage.elevationMinDeg}
            onChange={(value) =>
              setCoverage((old) => ({ ...old, elevationMinDeg: value }))
            }
            min={0}
            max={90}
          />
          <NumberField
            label="Plongée maximum (°)"
            value={coverage.elevationMaxDeg}
            onChange={(value) =>
              setCoverage((old) => ({ ...old, elevationMaxDeg: value }))
            }
            min={0}
            max={90}
          />
        </div>
      </fieldset>
      <fieldset className="fieldset" disabled={disabled || busy}>
        <legend className="fieldset-legend">Repère de hauteur physique</legend>
        <p className="mb-3 text-sm">
          Repérez la base et le sommet correspondant à la hauteur catalogue.
          N’utilisez pas automatiquement les bords du fichier, ni la profondeur
          visible comme hauteur.
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <div className="mb-3 flex flex-wrap gap-2">
              <button
                type="button"
                className="btn min-h-11"
                aria-pressed={activePoint === "bottom"}
                onClick={() => setActivePoint("bottom")}
              >
                1. Base
              </button>
              <button
                type="button"
                className="btn min-h-11"
                aria-pressed={activePoint === "top"}
                onClick={() => setActivePoint("top")}
              >
                2. Sommet
              </button>
            </div>
            <button
              type="button"
              className="relative block w-full overflow-hidden rounded-box border border-base-300 focus-visible:outline-2 focus-visible:outline-offset-2"
              onClick={markPoint}
              aria-label={`Placer le point ${activePoint === "bottom" ? "de base" : "du sommet"} dans la vue. Les champs adjacents permettent aussi une saisie au clavier.`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={assetUrl(view.image!.assetId)}
                alt="Vue à annoter pour la hauteur physique"
                width={view.image!.widthPx}
                height={view.image!.heightPx}
                className="block h-auto w-full"
              />
              {complete(segment) && (
                <svg
                  className="pointer-events-none absolute inset-0 h-full w-full text-primary"
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  <line
                    x1={segment.bottomX}
                    y1={segment.bottomY}
                    x2={segment.topX}
                    y2={segment.topY}
                    stroke="currentColor"
                    strokeWidth="0.7"
                  />
                  <circle
                    cx={segment.bottomX}
                    cy={segment.bottomY}
                    r="1.5"
                    fill="currentColor"
                  />
                  <circle
                    cx={segment.topX}
                    cy={segment.topY}
                    r="1.5"
                    fill="currentColor"
                  />
                </svg>
              )}
            </button>
          </div>
          <div className="grid content-start gap-3 sm:grid-cols-2">
            <NumberField
              label="Base · position horizontale (%)"
              value={segment.bottomX}
              onChange={(value) =>
                setSegment((old) => ({ ...old, bottomX: value }))
              }
              min={0}
              max={100}
            />
            <NumberField
              label="Base · position verticale (%)"
              value={segment.bottomY}
              onChange={(value) =>
                setSegment((old) => ({ ...old, bottomY: value }))
              }
              min={0}
              max={100}
            />
            <NumberField
              label="Sommet · position horizontale (%)"
              value={segment.topX}
              onChange={(value) =>
                setSegment((old) => ({ ...old, topX: value }))
              }
              min={0}
              max={100}
            />
            <NumberField
              label="Sommet · position verticale (%)"
              value={segment.topY}
              onChange={(value) =>
                setSegment((old) => ({ ...old, topY: value }))
              }
              min={0}
              max={100}
            />
            <p className="text-sm sm:col-span-2">
              Les pourcentages partent du coin supérieur gauche de l’image. Vous
              pouvez cliquer sur la vue ou saisir ces valeurs.
            </p>
          </div>
        </div>
      </fieldset>
      <div className="grid gap-4 md:grid-cols-2">
        <label className="fieldset">
          <span className="fieldset-legend">
            Limites observées (une par ligne)
          </span>
          <textarea
            className="textarea w-full"
            rows={3}
            value={limits}
            onChange={(event) => setLimits(event.target.value)}
            disabled={busy || disabled}
            placeholder="Ex. détail du motif difficile à vérifier"
          />
        </label>
        <label className="fieldset">
          <span className="fieldset-legend">
            Faces inconnues (une par ligne)
          </span>
          <textarea
            className="textarea w-full"
            rows={3}
            value={unknownFaces}
            onChange={(event) => setUnknownFaces(event.target.value)}
            disabled={busy || disabled}
            placeholder="Ex. arrière sans photographie de référence"
          />
        </label>
      </div>
      <label className="fieldset">
        <span className="fieldset-legend">Décision</span>
        <select
          className="select w-full"
          value={decision}
          onChange={(event) =>
            setDecision(event.target.value as typeof decision)
          }
          disabled={disabled || busy}
        >
          <option value="needs_review">Conserver à examiner</option>
          <option value="rejected">Refuser cette vue</option>
          <option value="approved" disabled={!approvalReady}>
            Approuver pour aperçu interne
          </option>
        </select>
      </label>
      {!approvalReady && (
        <p className="text-sm">
          Pour approuver : tous les critères doivent être conformes, le masque
          et le contact disponibles, l’orientation et sa plage renseignées, et
          la hauteur physique annotée.
        </p>
      )}
      <label className="flex min-h-11 items-start gap-3 text-sm">
        <input
          type="checkbox"
          className="checkbox mt-0.5 shrink-0"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          disabled={disabled || busy}
        />
        <span>
          J’ai personnellement examiné les photos d’origine, la vue et son
          masque. Cette décision sera enregistrée comme revue humaine sous mon
          compte.
        </span>
      </label>
      <button
        type="button"
        className="btn min-h-11"
        onClick={() => void save()}
        disabled={
          disabled ||
          busy ||
          !confirmed ||
          (decision === "approved" && !approvalReady)
        }
      >
        {busy ? "Enregistrement…" : "Enregistrer ma revue"}
      </button>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  min: number;
  max: number;
}) {
  return (
    <label className="fieldset">
      <span>{label}</span>
      <input
        className="input w-full"
        type="number"
        step="any"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        inputMode="decimal"
      />
    </label>
  );
}

function RevokeForm({
  view,
  path,
  disabled,
  onSaved,
}: {
  view: PreparedProductView;
  path: string;
  disabled: boolean;
  onSaved: () => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [kind, setKind] = useState<"identity_incident" | "superseded">(
    "identity_incident",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  async function revoke() {
    if (lock.current || !reason.trim() || disabled) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await adminApi(`${path}/${encodeURIComponent(view.id)}/revoke`, {
        method: "POST",
        body: JSON.stringify({
          expectedRevision: view.revision,
          reason: reason.trim(),
          kind,
        }),
      });
      await onSaved();
    } catch (error) {
      setError(errorText(error));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3">
      {error && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}
      <label className="fieldset">
        <span className="fieldset-legend">Motif</span>
        <textarea
          className="textarea w-full"
          rows={2}
          maxLength={1000}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          disabled={busy || disabled}
        />
      </label>
      <label className="fieldset">
        <span className="fieldset-legend">Traitement des rendus en cours</span>
        <select
          className="select w-full"
          value={kind}
          onChange={(event) => setKind(event.target.value as typeof kind)}
          disabled={busy || disabled}
        >
          <option value="identity_incident">
            Incident d’identité : bloquer aussi la livraison
          </option>
          <option value="superseded">
            Remplacement : conserver les rendus déjà admis
          </option>
        </select>
      </label>
      <button
        type="button"
        className="btn min-h-11"
        disabled={busy || disabled || !reason.trim()}
        onClick={() => void revoke()}
      >
        {busy ? "Révocation…" : "Révoquer cette vue"}
      </button>
    </div>
  );
}
