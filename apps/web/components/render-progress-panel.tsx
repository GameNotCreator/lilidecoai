"use client";

import { Check, Clock3, LoaderCircle, RefreshCw } from "lucide-react";
import { type Ref, useEffect, useState } from "react";
import type { Render } from "@lili/types";

import { elapsedRenderTime, renderProgress } from "@/lib/render-progress";
import type { RenderTrackingIssue } from "@/lib/render-tracking";

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
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []);
  const progress = renderProgress(render);
  const elapsed = elapsedRenderTime(render.createdAt, now);
  const previewReady = Boolean(render.compositeUrl);
  const preview = previewReady && !showOriginal;

  return (
    <div className="render-progress-panel" ref={panelRef}>
      <figure className="render-progress-preview">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={preview ? render.compositeUrl! : sceneUrl}
          alt={
            preview
              ? "Aperçu du placement de vos objets, avant le rendu réaliste"
              : "Photo d’origine de votre intérieur"
          }
        />
        <figcaption>
          <strong>
            {preview ? "Aperçu du placement" : "Votre photo d’origine"}
          </strong>
          <span>
            {preview
              ? "Image provisoire : la lumière et les ombres du rendu final sont en préparation."
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
        <div
          className="render-progress-heading"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <span className="render-progress-icon" aria-hidden="true">
            {progress.queued || trackingIssue ? (
              <Clock3 size={24} />
            ) : (
              <LoaderCircle className="spin" size={24} />
            )}
          </span>
          <h3>
            {trackingIssue
              ? "Suivi momentanément indisponible"
              : progress.title}
          </h3>
          <p>
            {trackingIssue
              ? `Dernière étape connue : ${progress.title}.`
              : progress.detail}
          </p>
        </div>
        <p className="render-progress-elapsed" aria-live="off">
          <Clock3 size={15} aria-hidden="true" />
          {elapsed ? (
            <>
              Temps écoulé · <span>{elapsed}</span>
            </>
          ) : (
            "Demande enregistrée"
          )}
        </p>
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
                      ? trackingIssue
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
        {trackingIssue ? (
          <div
            className="render-progress-connection"
            role="status"
            data-kind={trackingIssue.kind}
          >
            <p>{trackingIssue.message}</p>
            <button type="button" onClick={onRefresh}>
              <RefreshCw size={15} aria-hidden="true" /> Vérifier maintenant
            </button>
          </div>
        ) : (
          <p className="render-progress-note">
            Le rendu détaillé peut prendre plusieurs minutes. Le résultat
            s’affichera automatiquement ici.
          </p>
        )}
      </div>
    </div>
  );
}
