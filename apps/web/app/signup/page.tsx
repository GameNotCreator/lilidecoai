import Link from "next/link";

export default function SignupPage() {
  return (
    <main className="auth-page">
      <div className="auth-card">
        <span className="brand-mark">V</span>
        <span className="eyebrow">Créer un espace</span>
        <h1>Votre catalogue, mieux imaginé.</h1>
        <p>Le branchement Supabase Auth est prévu par variables serveur. Le MVP local ouvre l’organisation de démonstration.</p>
        <div className="field"><label htmlFor="studio">Nom de l’atelier</label><input id="studio" placeholder="Atelier Lili" /></div>
        <div className="field"><label htmlFor="email">E-mail</label><input id="email" type="email" placeholder="vous@atelier.com" /></div>
        <Link className="button" href="/app">Créer l’espace démo</Link>
        <small>Déjà inscrit ? <Link href="/login">Se connecter</Link></small>
      </div>
    </main>
  );
}

