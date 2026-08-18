"use client";

import { useEffect, useState } from "react";

import { adminApi, formatDate, type AdminOverview } from "@/lib/admin-client";

export function AdminOperations() {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void adminApi<AdminOverview>("/overview")
      .then(setData)
      .catch((reason: unknown) =>
        setError(
          reason instanceof Error ? reason.message : "Chargement impossible",
        ),
      );
  }, []);

  const renders = data?.renders;

  return (
    <>
      <header className="bo-head">
        <div>
          <span className="bo-eyebrow">Observabilité</span>
          <h1>Opérations IA.</h1>
          <p>
            Chaque tentative conserve son fournisseur, son modèle, sa durée et
            son coût estimé.
          </p>
        </div>
      </header>

      {error && <div className="bo-alert bo-alert-error">{error}</div>}

      <div className="bo-stat-grid">
        <article className="bo-stat">
          <strong>{renders?.total ?? 0}</strong>
          <span className="bo-stat-label">Rendus</span>
          <small>Toutes demandes confondues</small>
        </article>
        <article className="bo-stat bo-stat-ok">
          <strong>{renders?.succeeded ?? 0}</strong>
          <span className="bo-stat-label">Réussis</span>
          <small>{Math.round((renders?.successRate ?? 0) * 100)}% de réussite</small>
        </article>
        <article className="bo-stat bo-stat-warn">
          <strong>{renders?.failed ?? 0}</strong>
          <span className="bo-stat-label">Échecs</span>
          <small>Crédits libérés automatiquement</small>
        </article>
        <article className="bo-stat">
          <strong>${(renders?.estimatedCostUsd ?? 0).toFixed(3)}</strong>
          <span className="bo-stat-label">Coût estimé</span>
          <small>25 dernières tentatives</small>
        </article>
      </div>

      <section className="bo-panel">
        <div className="bo-panel-head">
          <div>
            <h2>Tentatives récentes</h2>
            <p>Les 25 derniers appels aux fournisseurs d’images.</p>
          </div>
        </div>
        <div className="bo-table-wrapper">
          <table className="bo-table">
            <thead>
              <tr>
                <th>Fournisseur / modèle</th>
                <th>Étape</th>
                <th>Statut</th>
                <th>Latence</th>
                <th>Coût</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {data?.attempts.map((attempt) => (
                <tr key={attempt.id}>
                  <td>
                    <strong>{attempt.provider}</strong>
                    <small>{attempt.model}</small>
                  </td>
                  <td>
                    <small>{attempt.stage ?? "—"}</small>
                  </td>
                  <td>
                    <span className={`bo-status bo-status-${attempt.status}`}>
                      {attempt.status}
                    </span>
                    {attempt.error && (
                      <small className="bo-warn">{attempt.error}</small>
                    )}
                  </td>
                  <td className="bo-numeric">{attempt.latencyMs} ms</td>
                  <td className="bo-numeric">
                    ${Number(attempt.estimatedCostUsd).toFixed(4)}
                  </td>
                  <td>
                    <small>{formatDate(attempt.createdAt)}</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && data.attempts.length === 0 && (
            <div className="bo-empty">Aucune tentative enregistrée.</div>
          )}
        </div>
      </section>
    </>
  );
}
