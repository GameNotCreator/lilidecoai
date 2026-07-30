export default function TermsPage() {
  return (
    <main className="legal-page">
      <div className="container">
        <span className="eyebrow">Documentation légale</span>
        <h1>Conditions d’utilisation</h1>
        <p className="legal-date">Version MVP · 30 juillet 2026</p>
        <article>
          <h2>Objet du service</h2><p>Project Visualizer fournit une simulation visuelle d’un objet décoratif dans une photographie. Le mode rapide reste une estimation ; le mode précision dépend de la mesure fournie par l’utilisateur.</p>
          <h2>Fidélité</h2><p>La couche géométrique pilote l’échelle et le placement. Une image générée ne constitue toutefois pas une mesure contractuelle de la pièce ou du produit.</p>
          <h2>Crédits</h2><p>Un crédit est capturé uniquement après un rendu accepté. Une réservation abandonnée ou un échec définitif est libéré automatiquement.</p>
          <h2>Contenus exclus du MVP</h2><p>Miroirs, verre transparent, chrome très réfléchissant, lampes allumées, textiles déformables et mobilier volumineux ne sont pas officiellement pris en charge.</p>
        </article>
      </div>
    </main>
  );
}

