"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function AuthForm({
  mode,
  returnTo = "/app",
}: {
  mode: "login" | "signup";
  returnTo?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(formData: FormData) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        mode === "login" ? "/v1/auth/login" : "/v1/auth/signup",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            mode === "login"
              ? {
                  email: formData.get("email"),
                  password: formData.get("password"),
                }
              : {
                  name: formData.get("name"),
                  studio: formData.get("studio"),
                  email: formData.get("email"),
                  password: formData.get("password"),
                },
          ),
        },
      );
      if (!response.ok) {
        const payload = (await response.json()) as { detail?: string };
        throw new Error(payload.detail ?? "Connexion impossible");
      }
      router.push(returnTo);
      router.refresh();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Opération impossible",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <form action={(data) => void submit(data)} className="auth-card">
        <span className="brand-mark">V</span>
        <span className="eyebrow">Espace marchand</span>
        <h1>
          {mode === "login" ? "Ravi de vous revoir." : "Créez votre atelier."}
        </h1>
        <p>Compte sécurisé et données hébergées dans MongoDB.</p>
        {error && <div className="studio-error">{error}</div>}
        {mode === "signup" && (
          <>
            <div className="field">
              <label htmlFor="name">Votre nom</label>
              <input id="name" name="name" required />
            </div>
            <div className="field">
              <label htmlFor="studio">Nom de l’atelier</label>
              <input id="studio" name="studio" required />
            </div>
          </>
        )}
        <div className="field">
          <label htmlFor="email">E-mail</label>
          <input id="email" name="email" type="email" required />
        </div>
        <div className="field">
          <label htmlFor="password">Mot de passe</label>
          <input
            id="password"
            name="password"
            type="password"
            minLength={10}
            required
          />
        </div>
        <button className="button" type="submit" disabled={busy}>
          {busy
            ? "Connexion…"
            : mode === "login"
              ? "Se connecter"
              : "Créer l’espace"}
        </button>
        <small>
          {mode === "login" ? (
            <>
              Pas encore de compte ?{" "}
              <Link href="/signup">Créer un atelier</Link>
            </>
          ) : (
            <>
              Déjà inscrit ? <Link href="/login">Se connecter</Link>
            </>
          )}
        </small>
      </form>
    </main>
  );
}
