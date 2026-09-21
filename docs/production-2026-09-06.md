# Production — 6 septembre 2026

## Version livrée

- URL principale : https://lilidecoai-web.vercel.app
- Déploiement : `dpl_5L4cYT9hvd9FXpWDJab7JQ3KDBxD`.
- URL immuable : https://lilidecoai-ggff3hbv0-gamenotcreators-projects.vercel.app
- Ancien déploiement : `dpl_6SR3TnTbZpjg5QRfwf4e39AH9Aea`.
- Livraison depuis le workspace local, incluant les modifications préexistantes et le lot d'intégrité. Aucun commit ni push Git n'a été effectué : la production n'est pas présentée comme synchronisée avec HEAD `3040594f2e89ceaaed43988a086f8e7208fe7e04`.

Le périmètre fonctionnel du [lot 1](professionnalisation-lot-1.md) est déployé. Les scripts de vérification et ce compte rendu constituent aussi des outils locaux d'exploitation ; leur présence n'est pas nécessaire au runtime du site.

## Configuration et données

- `DEMO_MODE=false` : aucune attribution automatique de droits propriétaire sans session ; les sessions invitées publiques fonctionnent.
- `AI_MOCK_MODE=false`, `OPENAI_IMAGE_ENABLED=true`, `OPENAI_MODEL=gpt-image-2` validés chez Vercel.
- Accès HTTP 200 aux descriptions de `gpt-image-2` et du modèle de vision `gpt-5.6-sol`.
- Secret cron renouvelé avec 32 octets aléatoires ; distinct du secret de session. Le secret de session existant a été conservé.
- MongoDB joignable et authentification Cloudinary vérifiée.
- 8 produits et 26 rendus migrés ; les champs concernés ont été sauvegardés avant écriture dans `migration_backups_image_pipeline_v1`. Aucun champ ni document supprimé par la migration. Le contrôle après migration trouve zéro produit/rendu restant à migrer.
- Migration activée uniquement pour ce build, avec `APPLY_IMAGE_PIPELINE_MIGRATION=true` ; aucune migration automatique permanente configurée.
- `.vercelignore` exclut les secrets locaux, caches, dépendances locales et fichiers de travail privés de l'envoi.

## Vérification

Les 181 tests unitaires et les 18 parcours navigateur en simulation, le lint, TypeScript et le build ont passé avant livraison du lot. Les scripts ajoutés pour l'exploitation passent également ESLint et la vérification syntaxique Node.

La compilation de production a réussi chez Vercel après le contrôle distant. Les 25 contrôles du smoke test passent sur le déploiement protégé puis sur l'URL publique après promotion : pages, santé, refus anonyme, accès invité au catalogue, refus d'administration, upload, lecture privée, expiration enregistrée et isolation entre deux sessions.

Deux images synthétiques ont été créées pour ces contrôles, une par exécution. Elles expirent le 7 septembre vers 07:54 et 07:55 UTC. Aucun appel d'analyse ou de génération IA, aucun débit de crédit et aucune purge globale ne sont déclenchés par ces smoke tests.

La route cron refuse les requêtes non authentifiées ; la purge authentifiée des données existantes n'a pas été exécutée pour tester le déploiement.

## Retour arrière et limites

L'ancienne version est conservée chez Vercel. **Ne pas la promouvoir aveuglément** : sa configuration active au début de l'intervention autorisait le mode démo. Un retour à son code doit conserver la configuration de production corrigée et faire repasser les contrôles avant remise en service. La migration additive préserve les champs historiques ; sa sauvegarde est ciblée et ne remplace pas une sauvegarde complète de la base et des images.

Les limites du lot 1 restent applicables : finalisation non transactionnelle entre wallet/journal/rendu en cas d'arrêt brutal, reprise durable à construire, contrôle d'accès des produits privés et expiration à compléter, fidélité photographique à mesurer sur un corpus réel. Cette livraison ne clôture pas le plan de professionnalisation et ne valide pas un rendu IA réel de bout en bout.
