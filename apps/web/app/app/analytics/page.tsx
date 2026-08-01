import { SimpleAppPage } from "@/components/app-data-pages";
export default function Page() {
  return (
    <SimpleAppPage
      eyebrow="Statistiques"
      title="De l’ouverture à l’achat."
      text="Seuls les événements métier sont suivis. Aucune photo n’entre dans l’analytics."
      cards={[
        {
          title: "Visualiseur ouvert",
          text: "Événement visualizer_opened, segmentable par produit.",
          value: "0",
        },
        {
          title: "Rendus réussis",
          text: "Le funnel mesure la réussite après le contrôle qualité.",
          value: "0",
        },
        {
          title: "Clics d’achat",
          text: "add_to_cart_clicked ferme la boucle de conversion.",
          value: "0",
        },
      ]}
    />
  );
}
