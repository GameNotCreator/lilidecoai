"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, LoaderCircle, Lock, ShieldAlert } from "lucide-react";

import { adminApi } from "@/lib/admin-client";

type DetectedVariables = Record<string, boolean>;

export function AdminLogin({
  configured,
  returnTo,
}: {
  configured: boolean;
  reason: string | null;
  detected?: DetectedVariables | null;
  returnTo: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(formData: FormData) {
    setBusy(true);
    setError("");
    try {
      await adminApi("/session", {
        method: "POST",
        body: JSON.stringify({
          username: String(formData.get("username") ?? ""),
          password: String(formData.get("password") ?? ""),
        }),
      });
      router.replace(returnTo);
      router.refresh();
    } catch (reason_) {
      setError(
        reason_ instanceof Error ? reason_.message : "Connexion impossible",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="bo-login">
      <section className="bo-login-card">
        <span className="bo-badge">
          <Lock size={13} /> Back office
        </span>
        <h1>Le catalogue LiliDeco.</h1>
        <p>
          Connectez-vous pour gérer les produits, leurs photos et leur publication.
        </p>

        {!configured && (
          <div className="bo-alert bo-alert-warning" role="alert">
            <ShieldAlert size={18} />
            <div>
              <strong>Connexion temporairement indisponible</strong>
              <p>La configuration de cet espace doit être terminée par son administrateur.</p>
            </div>
          </div>
        )}

        {error && (
          <div className="bo-alert bo-alert-error" role="alert">
            {error}
          </div>
        )}

        <form action={(formData) => void submit(formData)}>
          <div className="bo-field">
            <label htmlFor="username">Identifiant</label>
            <input
              id="username"
              name="username"
              autoComplete="username"
              required
              disabled={!configured || busy}
            />
          </div>
          <div className="bo-field">
            <label htmlFor="password">Mot de passe</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              disabled={!configured || busy}
            />
          </div>
          <button
            className="bo-button bo-button-primary bo-button-block"
            type="submit"
            disabled={!configured || busy}
          >
            {busy ? (
              <LoaderCircle className="spin" size={17} />
            ) : (
              <KeyRound size={17} />
            )}
            {busy ? "Vérification…" : "Entrer dans le back office"}
          </button>
        </form>
      </section>
    </main>
  );
}
