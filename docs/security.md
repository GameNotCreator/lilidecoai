# Sécurité et confidentialité

## Mesures présentes

- secrets MongoDB, Google, OpenAI et Cloudinary accessibles uniquement côté serveur ;
- session signée dans un cookie `HttpOnly`, `SameSite=Lax` et `Secure` en
  production ;
- session widget partitionnée, limitée à un produit et à ses propres scènes et
  rendus ;
- mots de passe hachés avec bcrypt ;
- séparation des requêtes par `organizationId` ;
- JPEG, PNG et WebP uniquement, résolution minimale, source limitée à 20 Mo et
  charge serveur limitée à 4 Mo après optimisation locale ;
- réencodage Sharp qui supprime les métadonnées EXIF ;
- originaux Cloudinary `private` en production et servis via l’API applicative ;
- consentement requis avant l’envoi d’une photo de pièce ;
- expiration des scènes et purge des assets temporaires ;
- clés d’idempotence uniques pour rendus et crédits ;
- débit atomique empêchant un solde négatif ;
- analytics sans contenu d’image ;
- clés Google et OpenAI jamais exposées au navigateur ;
- détection du type réel, réencodage et limites strictes sur les images ;
- limitation de débit MongoDB sur analyse, segmentation et rendu ;
- aucune URL distante fournie par le client n’est récupérée par le pipeline.

Le mode `DEMO_MODE=true` utilise une organisation partagée et ne doit jamais
être activé sur un site public réel.

## Checklist production

1. Régler `DEMO_MODE=false`.
2. Utiliser un utilisateur MongoDB Atlas dédié avec les droits minimaux.
3. Stocker toutes les variables dans Vercel, jamais dans Git.
4. Générer des secrets d’au moins 32 caractères.
5. Configurer Cloudinary avec une variable serveur `CLOUDINARY_URL`.
6. Tester les autorisations marchand/client avec deux comptes distincts.
7. Configurer les domaines exacts autorisés à intégrer le widget.
8. Vérifier la purge `/api/cron/purge` dans les logs Vercel.
9. Ajouter une protection anti-abus distribuée avant une ouverture large.
10. Activer alertes de coût et plafonds chez OpenAI, MongoDB et Vercel.

## Conservation

Les scènes et assets temporaires reçoivent `expiresAt`. Le cron Vercel cherche
les assets expirés, supprime d’abord leur objet Cloudinary puis la référence MongoDB.
Le job est idempotent et traite au maximum 500 objets par exécution.
