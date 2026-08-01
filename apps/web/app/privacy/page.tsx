export default function PrivacyPage() {
  return (
    <LegalPage title="Politique de confidentialité">
      <h2>Photos d’intérieur</h2>
      <p>
        Les photos sont utilisées exclusivement pour produire la visualisation
        demandée. Elles ne sont jamais envoyées à PostHog ni à un autre outil
        analytics. Elles expirent sous 24 heures par défaut et peuvent être
        supprimées immédiatement.
      </p>
      <h2>Métadonnées</h2>
      <p>
        Les images sont décodées puis réencodées côté serveur, ce qui retire les
        données EXIF. Les journaux applicatifs n’incluent ni photo, ni clé API,
        ni charge utile sensible.
      </p>
      <h2>Fournisseurs</h2>
      <p>
        En mode démonstration, aucun fournisseur distant n’est appelé. En
        production, OpenAI GPT Image 2 reçoit uniquement les images et le masque
        nécessaires au rendu demandé.
      </p>
      <h2>Vos droits</h2>
      <p>
        Le propriétaire d’une photo peut demander sa suppression immédiate via
        l’API ou l’organisation marchande responsable du visualiseur.
      </p>
    </LegalPage>
  );
}

function LegalPage({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <main className="legal-page">
      <div className="container">
        <span className="eyebrow">Documentation légale</span>
        <h1>{title}</h1>
        <p className="legal-date">Version MVP · 30 juillet 2026</p>
        <article>{children}</article>
      </div>
    </main>
  );
}
