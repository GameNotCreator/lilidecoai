import Link from "next/link";
import { Check } from "lucide-react";

const plans = [
  {
    name: "Découverte",
    price: "0",
    description: "Pour valider le visualiseur avec votre premier objet.",
    features: [
      "1 produit actif",
      "12 crédits de démonstration",
      "Widget local",
      "Mock rendering",
    ],
  },
  {
    name: "Studio",
    price: "79",
    description:
      "Pour les ateliers et boutiques qui veulent convertir avec confiance.",
    features: [
      "Catalogue complet",
      "75 rendus par pack",
      "Widget personnalisable",
      "Historique & analytics",
    ],
    featured: true,
  },
  {
    name: "Maison",
    price: "Sur devis",
    description: "Pour les catalogues, équipes et volumes plus importants.",
    features: [
      "Multi-utilisateurs",
      "Volumes adaptés",
      "Support d’intégration",
      "SLA & coûts suivis",
    ],
  },
];

export default function PricingPage() {
  return (
    <main className="section">
      <div className="container">
        <div className="section-heading">
          <span className="eyebrow">Tarifs simples</span>
          <h2>Payez les rendus qui réussissent.</h2>
          <p>
            Le crédit est capturé après contrôle qualité. Une tentative
            définitivement échouée ne réduit pas votre solde.
          </p>
        </div>
        <div className="pricing-grid">
          {plans.map((plan) => (
            <article
              className={`price-card ${plan.featured ? "featured" : ""}`}
              key={plan.name}
            >
              {plan.featured && (
                <span className="badge badge-positive">Recommandé</span>
              )}
              <h2>{plan.name}</h2>
              <p>{plan.description}</p>
              <div className="price">
                <strong>{plan.price}</strong>
                {plan.price !== "Sur devis" && <span>TND / pack</span>}
              </div>
              <ul>
                {plan.features.map((feature) => (
                  <li key={feature}>
                    <Check size={16} /> {feature}
                  </li>
                ))}
              </ul>
              <Link
                className={`button ${plan.featured ? "" : "secondary"}`}
                href={plan.name === "Maison" ? "/signup" : "/demo"}
              >
                {plan.name === "Maison" ? "Nous contacter" : "Commencer"}
              </Link>
            </article>
          ))}
        </div>
      </div>
    </main>
  );
}
