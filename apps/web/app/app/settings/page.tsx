import { SimpleAppPage } from "@/components/app-data-pages";
export default function Page() {
  return <SimpleAppPage eyebrow="Paramètres" title="Atelier Lili." text="Les frontières de l’organisation restent appliquées à chaque requête et chaque asset." cards={[
    { title: "Organisation", text: "Slug public : atelier-lili. Rôle actuel : propriétaire." },
    { title: "Confidentialité", text: "Photos de pièce supprimées après 24 heures par défaut." },
    { title: "Origines du widget", text: "localhost autorisé en démonstration. Liste restrictive en production." },
  ]} />;
}

