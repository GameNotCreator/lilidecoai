# Demandes de commande ByLiliDeco

Le parcours `/panier` → `/checkout` reprend le principe vérifié de FocusGym : coordonnées, sélection enregistrée dans MongoDB, notification Resend à la boutique, puis confirmation avec le client. Il ne réalise ni paiement ni réservation de stock. Le montant des articles est indicatif ; disponibilité, livraison, frais éventuels et paiement doivent être confirmés avant accord du client.

## Référence étudiée

Le checkout local `C:/Users/Hedi/Documents/Dev/Focus` correspond au dépôt `thehnh-tech/web-focus`, commit `39b5b893e5180f0e52bd6d3ec4a12e784cc4f7ae`, identique à `main` distant lors de la lecture du 29 septembre 2026. Les fichiers étudiés sont `components/commerce/CheckoutForm.tsx`, `app/api/orders/route.ts` et `lib/email.ts`. Aucun secret ni fichier d’environnement privé de FocusGym n’a été repris. Les frais et le paiement à la livraison propres à FocusGym n’ont pas été transposés à ByLiliDeco.

## Comportement livré

- Formulaire avec nom, téléphone et ville obligatoires ; email, adresse et commentaire facultatifs ; consultation des conditions et de la confidentialité.
- Les prix et les produits sont relus depuis le catalogue public côté serveur. Seul le dinar tunisien est accepté. Un stock inconnu reste à confirmer ; un stock connu insuffisant bloque la demande. La visualisation n’est pas un préalable à une demande commerciale.
- La réponse publique ne contient que la référence et le résultat de l’enregistrement. Les coordonnées ne figurent dans aucune URL et ne sont pas enregistrées dans le stockage du navigateur par l’application.
- Les demandes sont visibles dans `/admin/commandes`, sous authentification du backoffice et limitées à son organisation. Statuts « À traiter », « Client contacté » et « Clôturée ».
- Les emails partent uniquement vers `ORDER_EMAIL_TO`. L’email client facultatif sert de `Reply-To`. Aucun email client automatique.
- Si Resend échoue, la demande reste enregistrée et accessible dans le backoffice. La reprise explicite « Réessayer la notification » conserve la même clé d’idempotence. Après 23 heures depuis le premier essai, le renvoi automatique est refusé : l’état fournisseur doit être vérifié avant un éventuel message manuel. Un statut accepté par Resend ne prouve pas la livraison dans la boîte de réception.
- Les soumissions répétées avec la même clé et le même contenu retournent la même référence ; un contenu différent est refusé. L’envoi concurrent est protégé par une acquisition atomique en base.

## Configuration

| Variable | Rôle |
| --- | --- |
| `STOREFRONT_ORDERS_ENABLED` | Activation explicite par `true` ; fermée par défaut. |
| `RESEND_API_KEY` | Clé serveur privée propre à ce déploiement. |
| `RESEND_FROM_EMAIL` | Expéditeur autorisé par un domaine vérifié Resend. |
| `ORDER_EMAIL_TO` | Adresse boutique destinataire des demandes. |
| `ORDER_REQUEST_RETENTION_DAYS` | 90 jours par défaut, entier de 1 à 365. |
| `APP_SESSION_SECRET` | Secret existant pour hacher les identifiants utilisés par les limites de demandes. |

L’activation nécessite un expéditeur et un destinataire valides, une clé Resend et un secret privé configurés. L’aperçu local doit rester sans clé Resend et sans activation des demandes. Une prévisualisation du formulaire ne doit pas envoyer de vrais emails.

## Données et protection

Collection dédiée `storefront_order_requests`. Expiration logique appliquée aux lectures et actions ; suppression physique par l’index TTL MongoDB, avec le délai technique normal de son passage. Les copies reçues par email et la rétention du fournisseur de messagerie ne sont pas supprimées par ce TTL et doivent être gérées séparément.

Corps JSON limité à 16 Kio, 20 références distinctes maximum et 99 unités par référence. Champs supplémentaires et prix client refusés. Origine exacte obligatoire, piège antispam et quotas par IP hachée, téléphone haché et boutique. Les erreurs fournisseur ou base ne sont pas exposées au visiteur, ni inscrites dans les logs par ce module. Les adresses client ne contrôlent jamais le destinataire ni l’expéditeur de l’email.

Documentation Resend vérifiée : [Send Email](https://resend.com/docs/api-reference/emails/send-email), [Idempotency Keys](https://resend.com/docs/dashboard/emails/idempotency-keys) — durée fournisseur de 24 heures, d’où la borne locale de 23 heures.

## Validation

Tests dédiés : `apps/web/tests/order-requests.test.ts` (MongoDB locale réelle, Resend simulé) et `apps/web/tests/order-routes.test.ts` (routes et confidentialité). Ils couvrent persistance, concurrence, idempotence, échec/reprise email, isolation des organisations, expiration, limites, champs inconnus, tarifs et stocks, consentement, origine, taille du corps et absence de fuite de détails internes. Aucun email réel n’est envoyé par ces tests.
