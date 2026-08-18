"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, LoaderCircle, Lock, ShieldAlert } from "lucide-react";

import { adminApi } from "@/lib/admin-client";

export function AdminLogin({
  configured,
  reason,
  returnTo,
}: {
  configured: boolean;
  reason: string | null;
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
        <h1>Banque de produits.</h1>
        <p>
          Espace réservé à l’équipe. Les identifiants proviennent des variables
          d’environnement du serveur.
        </p>

        {!configured && (
          <div className="bo-alert bo-alert-warning" role="alert">
            <ShieldAlert size={18} />
            <div>
              <strong>Back office verrouillé</strong>
              <p>{reason}</p>
              <pre className="bo-code">
                {`ADMIN_USERNAME=votre-identifiant
ADMIN_PASSWORD=un-mot-de-passe-long
APP_SESSION_SECRET=32-caracteres-aleatoires-minimum`}
              </pre>
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
