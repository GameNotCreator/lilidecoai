# Sécurité et confidentialité

## Mesures présentes

- secrets MongoDB, OpenAI, Blob et Konnect accessibles uniquement côté serveur ;
- session signée dans un cookie `HttpOnly`, `SameSite=Lax` et `Secure` en
  production ;
- session widget partitionnée, limitée à un produit et à ses propres scènes et
  rendus ;
- mots de passe hachés avec bcrypt ;
- séparation des requêtes par `organizationId` ;
- JPEG, PNG et WebP uniquement, résolution minimale et limite de 4 Mo ;
- réencodage Sharp qui supprime les métadonnées EXIF ;
- Vercel Blob privé en production ;
- consentement requis avant l’envoi d’une photo de pièce ;
- expiration des scènes et purge des assets temporaires ;
- clés d’idempotence uniques pour rendus, crédits et paiements ;
- débit atomique empêchant un solde négatif ;
- analytics sans contenu d’image ;
- clés OpenAI et Konnect jamais exposées au navigateur.

Le mode `DEMO_MODE=true` utilise une organisation partagée et ne doit jamais
être activé sur un site public réel.

## Checklist production

1. Régler `DEMO_MODE=false`.
2. Utiliser un utilisateur MongoDB Atlas dédié avec les droits minimaux.
3. Stocker toutes les variables dans Vercel, jamais dans Git.
4. Générer des secrets d’au moins 32 caractères.
5. Connecter un Blob store privé.
6. Tester les autorisations marchand/client avec deux comptes distincts.
7. Configurer les domaines exacts autorisés à intégrer le widget.
8. Vérifier la purge `/api/cron/purge` dans les logs Vercel.
9. Ajouter une protection anti-abus distribuée avant une ouverture large.
10. Activer alertes de coût et plafonds chez OpenAI, MongoDB et Vercel.

## Conservation

Les scènes et assets temporaires reçoivent `expiresAt`. Le cron Vercel cherche
les assets expirés, supprime d’abord leur objet Blob puis la référence MongoDB.
Le job est idempotent et traite au maximum 500 objets par exécution.
