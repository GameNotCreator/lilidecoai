"use client";

import { Check, Clock3, RefreshCw } from "lucide-react";
import { type Ref, useEffect, useRef, useState } from "react";
import type { Render } from "@lili/types";

import { elapsedRenderTime, renderProgress } from "@/lib/render-progress";
import type { RenderTrackingIssue } from "@/lib/render-tracking";

const REQUEST_LIMIT_MS = 180_000;

export function RenderProgressPanel({
  render,
  sceneUrl,
  trackingIssue,
  onRefresh,
  panelRef,
}: {
  render: Render;
  sceneUrl: string;
  trackingIssue: RenderTrackingIssue | null;
  onRefresh: () => void;
  panelRef: Ref<HTMLDivElement>;
}) {
  const [now, setNow] = useState<number | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const deadlineRefresh = useRef<string | null>(null);
  const acceptedAt = Date.parse(render.createdAt);
  const deadlineAt = Date.parse(render.execution?.deadlineAt ?? "");
  const boundedRequest =
    Number.isFinite(acceptedAt) &&
    Number.isFinite(deadlineAt) &&
    deadlineAt > acceptedAt &&
    deadlineAt <= acceptedAt + REQUEST_LIMIT_MS;
  const limitReached =
    now !== null &&
    Number.isFinite(acceptedAt) &&
    now >= acceptedAt + REQUEST_LIMIT_MS;
  useEffect(() => {
    const tick = () => {
      const current = Date.now();
      setNow(current);
      if (
        Number.isFinite(acceptedAt) &&
        current >= acceptedAt + REQUEST_LIMIT_MS
      )
        window.clearInterval(timer);
    };
    const timer = window.setInterval(tick, 5000);
    const firstTick = window.setTimeout(tick, 0);
    const limitTick = Number.isFinite(acceptedAt)
      ? window.setTimeout(
          tick,
          Math.max(0, acceptedAt + REQUEST_LIMIT_MS - Date.now()),
        )
      : undefined;
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(firstTick);
      window.clearTimeout(limitTick);
    };
  }, [acceptedAt]);
  useEffect(() => {
    if (!limitReached || deadlineRefresh.current === render.id) return;
    deadlineRefresh.current = render.id;
    onRefresh();
  }, [limitReached, onRefresh, render.id]);
  const progress = renderProgress(render);
  const elapsed = elapsedRenderTime(render.createdAt, now);
  const previewReady = Boolean(render.compositeUrl);
  const preview = previewReady && !showOriginal;
  const imageUrl = preview ? render.compositeUrl! : sceneUrl;
  const imageFailed = failedUrl === imageUrl;
  const reconnecting = trackingIssue?.automaticRetry === true;
  const waitLabel = limitReached
    ? "Vérification de la demande"
    : trackingIssue
      ? reconnecting
        ? "Reconnexion au suivi"
        : "Dernier aperçu conservé"
      : progress.queued
        ? "Demande enregistrée"
        : "Visualisation en préparation";

  return (
    <div className="render-progress-panel" ref={panelRef}>
      <div
        className="render-progress-heading"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <span className="render-progress-icon" aria-hidden="true">
          {progress.queued || trackingIssue || limitReached ? (
            <Clock3 size={24} />
          ) : (
            <span className="loading loading-ring loading-md" />
          )}
        </span>
        {(trackingIssue || limitReached) && (
          <small className="render-progress-last-confirmed">
            Dernière étape confirmée
          </small>
        )}
        <h3>{progress.title}</h3>
        <p>
          {trackingIssue || limitReached
            ? `Dernière étape connue : ${progress.title}.`
            : progress.detail}
        </p>
      </div>
      <figure
        className="render-progress-preview"
        aria-busy={!trackingIssue && !limitReached}
      >
        <div
          className="render-progress-image"
          data-loaded={loadedUrl === imageUrl}
          data-paused={Boolean(trackingIssue) || limitReached}
          data-failed={imageFailed}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageUrl}
            onLoad={() => {
              setLoadedUrl(imageUrl);
              setFailedUrl(null);
            }}
            onError={() => setFailedUrl(imageUrl)}
            alt={
              preview
                ? progress.sourcePixelPlacement
                  ? "Aperçu provisoire du placement de vos objets"
                  : "Aperçu du placement de vos objets, avant le rendu réaliste"
                : "Photo d’origine de votre intérieur"
            }
          />
          <div
            className="skeleton render-progress-image-skeleton h-full w-full"
            aria-hidden="true"
          />
          <span className="render-progress-image-label">
            {!trackingIssue && !imageFailed && !limitReached && (
              <span
                className="loading loading-dots loading-sm"
                aria-hidden="true"
              />
            )}
            {imageFailed ? "Aperçu momentanément indisponible" : waitLabel}
          </span>
        </div>
        <figcaption>
          <strong>
            {preview ? "Aperçu du placement" : "Votre photo d’origine"}
          </strong>
          <span>
            {imageFailed
              ? "Votre photo reste enregistrée. Vous pouvez consulter les étapes et vérifier le suivi depuis cette page."
              : trackingIssue || limitReached
                ? preview
                  ? "Image provisoire conservée ; la prochaine étape reste à confirmer."
                  : "Votre photo est conservée pendant la récupération du suivi."
                : preview
                  ? progress.sourcePixelPlacement
                    ? "Image provisoire, avant la vérification finale du placement."
                    : "Image provisoire : la lumière et les ombres du rendu final sont en préparation."
                  : previewReady
                    ? "Comparez votre pièce avec le placement préparé."
                    : "L’aperçu de vos objets apparaîtra ici dès que le placement sera prêt."}
          </span>
        </figcaption>
        {previewReady && (
          <div className="render-progress-compare" aria-label="Image affichée">
            <button
              type="button"
              aria-pressed={!showOriginal}
              onClick={() => setShowOriginal(false)}
            >
              Aperçu du placement
            </button>
            <button
              type="button"
              aria-pressed={showOriginal}
              onClick={() => setShowOriginal(true)}
            >
              Photo d’origine
            </button>
          </div>
        )}
      </figure>
      <div className="render-progress-information">
        <ol
          className="render-progress-steps"
          aria-label="Progression de votre visualisation"
        >
          {progress.steps.map((step, index) => (
            <li
              key={step.label}
              data-state={step.state}
              aria-current={
                step.state === "active" || step.state === "waiting"
                  ? "step"
                  : undefined
              }
            >
              <span className="render-progress-step-icon" aria-hidden="true">
                {step.state === "complete" ? <Check size={15} /> : index + 1}
              </span>
              <span>
                {step.label}
                <small>
                  {step.state === "complete"
                    ? "Terminée"
                    : step.state === "active"
                      ? trackingIssue || limitReached
                        ? "État à confirmer"
                        : "En cours"
                      : step.state === "waiting"
                        ? "Reprise en attente"
                        : "À venir"}
                </small>
              </span>
            </li>
          ))}
        </ol>
        {limitReached && (
          <div
            className="render-progress-connection"
            role="status"
            data-kind="deadline"
          >
            <strong>Le délai de 3 minutes est atteint.</strong>
            <p>
              Vérification du résultat de votre demande. Vous pouvez consulter
              son état sans créer une nouvelle visualisation.
            </p>
            {!trackingIssue && (
              <button type="button" onClick={onRefresh}>
                <RefreshCw size={15} aria-hidden="true" /> Vérifier maintenant
              </button>
            )}
          </div>
        )}
        {trackingIssue ? (
          <div
            className="render-progress-connection"
            role="status"
            data-kind={trackingIssue.kind}
          >
            <strong>
              {reconnecting
                ? "Reconnexion au suivi…"
                : "Le suivi doit être vérifié"}
            </strong>
            <p>{trackingIssue.message}</p>
            <button type="button" onClick={onRefresh}>
              <RefreshCw size={15} aria-hidden="true" /> Vérifier maintenant
            </button>
          </div>
        ) : (
          !limitReached && (
            <p className="render-progress-note">
              {boundedRequest
                ? "Jusqu’à 3 minutes pour créer et vérifier votre image."
                : "La création de l’image et sa vérification peuvent prendre quelques minutes."}{" "}
              Gardez cette page ouverte : le résultat s’affichera ici dès qu’il
              sera prêt.
            </p>
          )
        )}
        <details className="render-progress-request-details">
          <summary>Détails de la demande</summary>
          <p className="render-progress-elapsed" aria-live="off">
            <Clock3 size={15} aria-hidden="true" />
            {limitReached ? (
              "Limite atteinte · 3 min"
            ) : elapsed ? (
              <>
                Temps écoulé · <span>{elapsed}</span>
              </>
            ) : (
              "Demande enregistrée"
            )}
          </p>
          <p>
            Les étapes indiquent l’état reçu du traitement. La durée écoulée ne
            prédit pas le temps restant.
          </p>
        </details>
      </div>
    </div>
  );
}
