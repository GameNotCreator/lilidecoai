import { SimpleAppPage } from "@/components/app-data-pages";
export default function Page() {
  return <SimpleAppPage eyebrow="Facturation" title="Plan Studio." text="Konnect prend le relais en production ; le mock ne confirme que dans l’environnement local." cards={[
    { title: "Abonnement", text: "Plan gratuit actif. Aucun renouvellement programmé.", value: "Free" },
    { title: "Paiements", text: "Webhooks signés, idempotence et attribution unique des crédits.", value: "TND" },
    { title: "Prochaine échéance", text: "Aucune carte ni coordonnée de paiement enregistrée.", value: "—" },
  ]} />;
}

