import type { Metadata } from "next";
import Link from "next/link";
import { LegalContact, LegalDocument } from "@/components/legal/legal-document";
import { serverConfig } from "@/lib/server/config";
import { orderRequestRetentionDays } from "@/lib/server/order-requests";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Politique de confidentialité",
  description:
    "Comment ByLiliDeco traite votre photo, votre panier et votre session lorsque vous utilisez la visualisation d’objets.",
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
  return (
    <LegalDocument
      current="/privacy"
      title="Politique de confidentialité"
      intro="Votre photo sert à préparer la visualisation que vous demandez. Le catalogue reste consultable sans envoyer de photo."
    >
      <h2>1. Qui contacter ?</h2>
      <p>
        Ce service accompagne la boutique ByLiliDeco. Les informations
        disponibles sur l’éditeur sont regroupées dans les{" "}
        <Link href="/mentions-legales">mentions légales</Link>.
      </p>
      <LegalContact />
      <h2>2. Les informations utilisées</h2>
      <ul>
        <li>
          <strong>Votre sélection :</strong> les références des articles et
          leurs quantités sont conservées dans le panier de votre navigateur.
          Aucune coordonnée bancaire n’est demandée par ce parcours.
        </li>
        <li>
          <strong>Votre demande de commande :</strong> votre nom, votre téléphone,
          votre ville et les articles sélectionnés permettent à la boutique de
          vous recontacter. L’email, l’adresse détaillée et le commentaire sont
          facultatifs. Ces informations sont envoyées lorsque vous soumettez le
          formulaire ; vos photos de visualisation ne sont pas jointes.
        </li>
        <li>
          <strong>Votre visualisation :</strong> la photo choisie, les
          emplacements, les références des produits, l’image générée et les
          images techniques intermédiaires permettent de produire et de suivre
          votre résultat.
        </li>
        <li>
          <strong>Votre session :</strong> un identifiant aléatoire relie vos
          demandes à votre navigateur et protège l’accès à vos images. Aucun
          compte client nominatif n’est nécessaire pour ce parcours.
        </li>
        <li>
          <strong>Le fonctionnement du service :</strong> les dates, états de
          traitement, erreurs, consommations et identifiants de demandes sont
          enregistrés pour le suivi des générations et la prévention des abus.
          L’hébergement traite aussi les données techniques de connexion
          nécessaires à la livraison et à la protection du site.
        </li>
      </ul>
      <h2>3. Votre choix avant l’envoi</h2>
      <p>
        La photo est envoyée après votre autorisation dans le visualiseur. Sans
        cette autorisation, vous pouvez continuer à consulter les produits et à
        composer votre panier. Ne photographiez pas de personnes identifiables,
        de documents privés ou d’autres informations sensibles. Les fichiers
        reçus sont réencodés afin de retirer leurs métadonnées EXIF, notamment
        les coordonnées GPS éventuellement contenues dans le fichier.
      </p>
      <p>
        Les photos d’intérieur ne sont pas publiées dans le catalogue. Le
        parcours boutique n’intègre pas de pixels publicitaires ni d’outil de
        mesure d’audience tiers. Il ne transmet pas vos photos à un outil
        d’analytics.
      </p>
      <h2>4. Les services qui interviennent</h2>
      <p>
        Le site est hébergé sur Vercel. Les informations de fonctionnement sont
        enregistrées dans une base MongoDB et les images peuvent être stockées
        chez Cloudinary selon la configuration du service. L’accès aux photos et
        résultats de votre session est contrôlé par le serveur.
      </p>
      <p>
        Les demandes de commande sont enregistrées dans MongoDB. Resend assure
        l’envoi d’un email récapitulatif à ByLiliDeco, qui le reçoit dans sa
        messagerie Gmail. Ce message contient vos coordonnées et les articles
        demandés afin que la boutique puisse vous répondre.
      </p>
      <p>
        Pour une visualisation réelle, les images nécessaires, les références
        des objets et les instructions de placement sont transmises au
        fournisseur d’intelligence artificielle configuré : OpenAI pour le
        parcours boutique, et éventuellement Google pour certaines étapes
        d’analyse. Le traitement ne s’effectue donc pas exclusivement sur votre
        appareil.
      </p>
      <p>
        Ces prestataires peuvent traiter des données hors de Tunisie. Les pays
        de traitement, les conditions contractuelles de conservation des
        prestataires et les formalités de transfert doivent encore être
        confirmés par l’exploitant avant l’ouverture publique du service de
        photos. La durée d’accès sur ce site ne constitue pas une promesse de
        suppression simultanée de toutes les copies chez les prestataires.
      </p>
      <h2>5. Conservation de vos images</h2>
      <p>
        Les demandes de commande restent disponibles dans l’espace privé de la
        boutique pendant {orderRequestRetentionDays()} jours après leur envoi.
        Elles deviennent ensuite inaccessibles et sont supprimées de la base
        par un nettoyage automatique, dont l’exécution peut être différée.
        Cette durée ne supprime pas les emails déjà reçus dans la messagerie de
        la boutique ni les éventuelles pièces d’une commande confirmée. Pour
        demander leur suppression, contactez ByLiliDeco.
      </p>
      <p>
        Dans la configuration actuelle, votre photo et les images qui en sont
        dérivées deviennent inaccessibles sur le site{" "}
        {serverConfig.roomRetentionHours} heures après l’envoi de la photo. La
        date d’expiration est attribuée lors de cet envoi. Les fichiers expirés
        sont ensuite effacés par les opérations de nettoyage du service ; leur
        suppression physique peut être différée.
      </p>
      <p>
        Les données de suivi des demandes et de consommation sont distinctes des
        fichiers image. Elles ne sont pas toutes effacées à l’expiration de la
        photo. Leurs durées de conservation et celles des sauvegardes doivent
        être précisées par l’exploitant avant la mise en production de cette
        version.
      </p>
      <h2>6. Cookies et stockage sur votre appareil</h2>
      <dl>
        <dt>Session de visualisation</dt>
        <dd>
          Un cookie nécessaire maintient votre session pendant 24 heures après
          son émission ou son renouvellement. Il sert à reconnaître vos demandes
          et à protéger vos images. Il ne sert pas à vous suivre sur d’autres
          sites.
        </dd>
        <dt>Panier</dt>
        <dd>
          Votre sélection est enregistrée dans le stockage local du navigateur,
          sans expiration automatique. Vous pouvez retirer les articles du
          panier ou effacer les données de ce site dans votre navigateur. Le
          panier n’est pas synchronisé entre vos appareils.
        </dd>
        <dt>Connexion à l’espace boutique</dt>
        <dd>
          Les personnes autorisées qui se connectent au backoffice reçoivent un
          cookie de connexion distinct. Sa durée configurée est de{" "}
          {serverConfig.adminSessionHours} heures, sauf déconnexion anticipée.
        </dd>
      </dl>
      <p>
        Bloquer le stockage ou les cookies nécessaires peut empêcher la reprise
        d’une sélection ou l’accès à une visualisation. Les liens vers
        Instagram ou Facebook ouvrent des services
        tiers, avec leurs propres règles de confidentialité.
      </p>
      <h2>7. Accès, rectification et suppression</h2>
      <p>
        Vous pouvez contacter la boutique pour demander l’accès aux données vous
        concernant, leur correction, leur suppression ou le retrait de votre
        autorisation de traitement, selon les règles applicables. Une
        vérification de votre lien avec la demande peut être nécessaire pour
        protéger les données d’autres personnes. Effacer les cookies du
        navigateur ne supprime pas à lui seul les données déjà envoyées au
        serveur.
      </p>
      <p>
        Pour connaître les démarches de protection des données en Tunisie, vous
        pouvez consulter l’
        <a href="https://www.inpdp.tn/" rel="noreferrer">
          Instance nationale de protection des données personnelles (INPDP)
        </a>
        .
      </p>
    </LegalDocument>
  );
}
