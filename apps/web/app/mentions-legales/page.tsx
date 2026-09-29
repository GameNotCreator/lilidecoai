import type { Metadata } from "next";
import Link from "next/link";
import { LegalContact, LegalDocument } from "@/components/legal/legal-document";

export const metadata: Metadata = {
  title: "Mentions légales",
  description:
    "Informations disponibles sur ByLiliDeco, l’hébergement du site et les droits attachés aux contenus de la boutique.",
  alternates: { canonical: "/mentions-legales" },
  robots: { index: false, follow: true },
};

export default function LegalNoticePage() {
  return (
    <LegalDocument
      current="/mentions-legales"
      title="Mentions légales"
      intro="Les informations relatives à la boutique, à ce site et à ses contenus."
    >
      <h2>La marque et le site</h2>
      <p>
        Le site présente le concept store ByLiliDeco. Il propose un catalogue,
        un panier de sélection, des demandes de commande à confirmer avec la
        boutique et un service de visualisation d’objets. Aucun paiement en
        ligne n’est demandé sur ce site.
      </p>
      <h2>Identification de l’éditeur</h2>
      <p>
        La raison sociale ou l’identité juridique de l’exploitant, son adresse
        légale, son immatriculation, le responsable de publication et un contact
        direct dédié à la confidentialité ne sont pas encore confirmés dans
        cette version. Ces mentions doivent être complétées avant l’ouverture
        publique.
      </p>
      <LegalContact />
      <h2>Hébergement</h2>
      <p>
        Le site utilise l’hébergement Vercel. Les informations et coordonnées du
        prestataire sont disponibles dans les{" "}
        <a href="https://vercel.com/legal" rel="noreferrer">
          informations légales de Vercel
        </a>
        . Les autres prestataires techniques intervenant dans une visualisation
        sont présentés dans la{" "}
        <Link href="/privacy">politique de confidentialité</Link>.
      </p>
      <h2>Photographies, logos et textes</h2>
      <p>
        Les signes de la marque et les contenus du catalogue restent la
        propriété de leurs titulaires. Leur présence sur ce site n’accorde pas
        une autorisation générale de reproduction ou d’exploitation commerciale.
        Les photos d’intérieur envoyées par les visiteurs restent leurs
        contenus.
      </p>
      <h2>Liens et informations externes</h2>
      <p>
        Les réseaux sociaux et plateformes marchandes accessibles par un lien
        sont des services distincts. Leurs conditions s’appliquent lorsque vous
        les utilisez. Une information reprise dans une fiche produit peut
        évoluer sur le site d’origine ; la boutique peut vous la confirmer avant
        un achat.
      </p>
      <p>
        Retrouvez les règles de ce service dans les{" "}
        <Link href="/terms">conditions d’utilisation</Link>.
      </p>
    </LegalDocument>
  );
}
