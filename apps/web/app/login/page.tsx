import Link from "next/link";

export default function LoginPage() {
  return (
    <main className="auth-page">
      <div className="auth-card">
        <span className="brand-mark">V</span>
        <span className="eyebrow">Espace marchand</span>
        <h1>Ravi de vous revoir.</h1>
        <p>En mode démonstration, l’accès local ne demande aucun compte distant.</p>
        <div className="field"><label htmlFor="email">E-mail</label><input id="email" type="email" placeholder="vous@atelier.com" /></div>
        <div className="field"><label htmlFor="password">Mot de passe</label><input id="password" type="password" placeholder="••••••••••••" /></div>
        <Link className="button" href="/app">Entrer dans l’espace démo</Link>
        <small>Pas encore de compte ? <Link href="/signup">Créer un atelier</Link></small>
      </div>
    </main>
  );
}

