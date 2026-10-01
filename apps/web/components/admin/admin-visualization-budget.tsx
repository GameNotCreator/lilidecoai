"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import { z } from "zod";

import { adminApi } from "@/lib/admin-client";

const budgetSchema = z.object({
  balance: z.number().int().nonnegative(),
  reserved: z.number().int().nonnegative(),
  maxCostPerRenderUsd: z.number().positive(),
});
type VisualizationBudget = z.infer<typeof budgetSchema>;

function readBudget(response: unknown): VisualizationBudget {
  const result = budgetSchema.safeParse(response);
  if (!result.success)
    throw new Error("Le quota reçu n’a pas pu être lu. Actualisez le quota.");
  return result.data;
}

export function AdminVisualizationBudget() {
  const [budget, setBudget] = useState<VisualizationBudget | null>(null);
  const [credits, setCredits] = useState("1");
  const [busy, setBusy] = useState<"loading" | "authorizing" | "">("loading");
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const pending = useRef<{ credits: number; idempotencyKey: string } | null>(
    null,
  );
  const requestLock = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    void adminApi<unknown>("/visualization-budget", {
      signal: controller.signal,
    })
      .then((response) => {
        if (!controller.signal.aborted) setBudget(readBudget(response));
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error ? reason.message : "Quota indisponible.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy("");
      });
    return () => controller.abort();
  }, []);

  async function refresh() {
    if (busy || requestLock.current) return;
    requestLock.current = true;
    setBusy("loading");
    setError("");
    try {
      setBudget(readBudget(await adminApi<unknown>("/visualization-budget")));
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Quota indisponible.",
      );
    } finally {
      requestLock.current = false;
      setBusy("");
    }
  }

  async function authorize(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || requestLock.current || !budget) return;
    const amount = Number(credits);
    if (!Number.isInteger(amount) || amount < 1 || amount > 3) {
      setError("Choisissez de 1 à 3 visualisations.");
      return;
    }
    requestLock.current = true;
    setBusy("authorizing");
    setError("");
    setConfirmation("");
    try {
      // Keep this key after an uncertain response: a manual retry cannot add
      // the same allowance twice. No automatic POST retry is performed.
      pending.current ??= {
        credits: amount,
        idempotencyKey: crypto.randomUUID(),
      };
      const response = await adminApi<unknown>("/visualization-budget", {
        method: "POST",
        body: JSON.stringify(pending.current),
      });
      setBudget(readBudget(response));
      pending.current = null;
      setConfirmation(
        `${amount} ${amount === 1 ? "visualisation autorisée" : "visualisations autorisées"}.`,
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Autorisation non confirmée. Vous pouvez réessayer.",
      );
    } finally {
      requestLock.current = false;
      setBusy("");
    }
  }

  return (
    <section className="bo-panel" aria-labelledby="visualization-budget-title">
      <div className="bo-panel-head flex-col sm:flex-row">
        <div>
          <h2 id="visualization-budget-title">Visualisations autorisées</h2>
          <p>
            Ce quota autorise les demandes de la boutique. Il ne recharge pas le
            compte IA.
          </p>
        </div>
        <button
          className="btn bo-button bo-button-ghost min-h-11! shrink-0"
          type="button"
          disabled={Boolean(busy)}
          onClick={() => void refresh()}
        >
          Actualiser le quota
        </button>
      </div>

      {budget ? (
        <>
          <dl className="mb-4 grid grid-cols-2 gap-4 text-base-content">
            <div>
              <dt className="text-sm">Disponibles</dt>
              <dd className="m-0 text-2xl font-semibold">{budget.balance}</dd>
            </div>
            <div>
              <dt className="text-sm">Réservées aux demandes en cours</dt>
              <dd className="m-0 text-2xl font-semibold">{budget.reserved}</dd>
            </div>
          </dl>
          <p className="mb-4 text-sm text-base-content/75">
            Plafond estimé par visualisation :{" "}
            {budget.maxCostPerRenderUsd.toFixed(2)} $.
          </p>
        </>
      ) : busy === "loading" ? (
        <p role="status">Chargement du quota…</p>
      ) : null}

      <form onSubmit={(event) => void authorize(event)}>
        <fieldset className="fieldset" disabled={Boolean(busy) || !budget}>
          <legend className="fieldset-legend">
            Autoriser de nouvelles visualisations
          </legend>
          <label
            htmlFor="visualization-credits"
            className="label whitespace-normal"
          >
            Nombre de visualisations (1 à 3)
          </label>
          <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
            <input
              className="input min-h-11! w-full min-w-0 text-base! sm:w-24"
              id="visualization-credits"
              name="credits"
              type="number"
              inputMode="numeric"
              min={1}
              max={3}
              step={1}
              required
              value={credits}
              onChange={(event) => {
                if (event.target.value !== credits) pending.current = null;
                setCredits(event.target.value);
                setError("");
                setConfirmation("");
              }}
            />
            <button
              className="btn bo-button bo-button-secondary min-h-11! w-full sm:w-auto"
              type="submit"
            >
              {busy === "authorizing" ? "Autorisation…" : "Autoriser"}
            </button>
          </div>
        </fieldset>
      </form>
      {error && (
        <p className="bo-alert bo-alert-error mt-3" role="alert">
          {error}
        </p>
      )}
      {confirmation && (
        <p className="mt-3 text-sm" role="status" aria-live="polite">
          {confirmation}
        </p>
      )}
    </section>
  );
}
