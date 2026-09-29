import type { Metadata } from "next";
import Link from "next/link";
import { LegalContact, LegalDocument } from "@/components/legal/legal-document";

export const metadata: Metadata = {
  title: "Conditions d’utilisation",
  description:
    "Les conditions d’accès au catalogue ByLiliDeco, au panier de sélection et aux visualisations dans votre intérieur.",
  alternates: { canonical: "/terms" },
};

export default function TermsPage() {
  return (
    <LegalDocument
      current="/terms"
      title="Conditions d’utilisation"
      intro="Découvrez les objets de la boutique, préparez votre sélection et imaginez-les chez vous. Voici les règles de fonctionnement de ce service."
    >
      <h2>1. Le catalogue et votre panier</h2>
      <p>
        Le site présente une sélection d’objets ByLiliDeco. Vous pouvez
        consulter leurs informations, les ajouter à votre panier et visualiser
        les articles compatibles dans une photo de votre intérieur.
      </p>
      <p>
        Le panier est une liste de sélection enregistrée sur votre appareil. Il
        ne constitue ni une commande, ni une réservation de stock. Aucun
        paiement n’est encaissé sur ce site. Vous pouvez transmettre votre
        sélection et vos coordonnées à ByLiliDeco. La boutique vous recontactera
        pour confirmer la disponibilité, le montant final, la livraison et le
        mode de paiement. L’envoi de cette demande ne réserve pas les articles
        et ne constitue pas une acceptation de commande par la boutique.
      </p>
      <h2>2. Les informations sur les produits</h2>
      <p>
        Chaque fiche présente les caractéristiques disponibles de l’objet. Le
        prix est exprimé dans la devise affichée. Un prix indiqué « sur demande
        » doit être confirmé auprès de la boutique. Les disponibilités et les
        informations du catalogue peuvent évoluer : faites
        confirmer le prix, les dimensions utiles et les modalités d’achat avant
        tout engagement.
      </p>
      <p>
        Les éventuelles ventes, livraisons, garanties et conditions de retour
        doivent être précisées au moment de l’achat. Ces conditions
        d’utilisation ne remplacent pas les conditions de vente applicables à
        cet achat.
      </p>
      <h2>3. Imaginer les objets chez vous</h2>
      <p>
        La visualisation accepte de un à trois objets compatibles par image,
        quantités comprises. Elle utilise votre photo, les références des
        produits et les emplacements que vous choisissez. Elle peut être
        indisponible pour certains objets ou lorsque la capacité de génération
        est atteinte.
      </p>
      <p>
        Le résultat est une image d’inspiration générée par intelligence
        artificielle. Les proportions, couleurs, matières, ombres et détails
        peuvent différer du produit réel. Il ne constitue pas une mesure de
        votre pièce ni une garantie qu’un objet s’y adapte. Vérifiez les
        dimensions de la fiche et mesurez votre espace avant l’achat.
      </p>
      <h2>4. Les photos que vous partagez</h2>
      <p>
        Envoyez uniquement une photo que vous êtes autorisé à utiliser.
        Privilégiez une pièce sans personne identifiable, sans document
        personnel et sans information sensible visible. L’accès à la caméra
        reste votre choix : vous pouvez sélectionner une photo existante.
      </p>
      <p>
        Votre autorisation permet de traiter la photo et d’en créer les versions
        techniques nécessaires à la visualisation demandée. Elle ne transfère
        pas la propriété de votre photo à la boutique et n’autorise pas sa
        publication publicitaire. La{" "}
        <Link href="/privacy">politique de confidentialité</Link> décrit ce
        traitement, sa durée et les prestataires concernés.
      </p>
      <h2>5. Un usage respectueux du service</h2>
      <p>
        N’essayez pas d’accéder aux photos d’une autre personne, de contourner
        les limites de génération ou de perturber le fonctionnement du site.
        L’accès au backoffice est réservé aux personnes autorisées par la
        boutique. Les logos, photographies de produits et textes restent soumis
        aux droits de leurs titulaires.
      </p>
      <h2>6. Disponibilité et assistance</h2>
      <p>
        Une interruption, une maintenance ou une erreur de génération peut
        empêcher temporairement la visualisation. En cas de problème, consultez
        l’état de la demande avant d’en lancer une nouvelle. Ces conditions ne
        limitent pas les droits impératifs dont vous bénéficiez.
      </p>
      <LegalContact />
      <p>
        La date en haut de cette page identifie la version de ces conditions.
        Les informations sur l’éditeur figurent dans les{" "}
        <Link href="/mentions-legales">mentions légales</Link>.
      </p>
    </LegalDocument>
  );
}
