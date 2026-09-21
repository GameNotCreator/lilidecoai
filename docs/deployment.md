# Déploiement Vercel + MongoDB

## 1. MongoDB Atlas

Créer un cluster Atlas, un utilisateur de base et récupérer la chaîne
`mongodb+srv://...`. Autoriser les connexions nécessaires au projet Vercel et
utiliser un mot de passe dédié à l’application.

Variables :

```text
MONGODB_URI=mongodb+srv://...
MONGODB_DB=lilidecoai
```

## 2. Projet Vercel

Importer le dépôt GitHub `GameNotCreator/lilidecoai`, puis configurer :

- Framework Preset : Next.js ;
- Root Directory : `apps/web` ;
- accès aux fichiers situés hors de la Root Directory, car les packages
  partagés sont dans `packages/*` ;
- commandes d’installation et de build automatiques.

`apps/web/vercel.json` déclare la purge quotidienne et le worker image chaque
minute. Le worker utilise Vercel Pro avec Fluid Compute, MongoDB et Cloudinary
déjà configurés ; aucun autre hébergeur n'est requis.

## 3. Cloudinary

Dans Cloudinary, ouvrir **Settings → API Keys** et copier l’API environment
variable complète dans `CLOUDINARY_URL`. Les images sont téléversées avec le
type `private` et restent servies par `/api/assets/:id` après les contrôles
d’accès de l’application. En cas d’indisponibilité Cloudinary, l’envoi est
conservé temporairement dans MongoDB afin de ne pas bloquer le parcours.

## 4. Variables Vercel

Obligatoires en production :

```text
MONGODB_URI
MONGODB_DB
APP_SESSION_SECRET
CRON_SECRET
DEMO_MODE=false
CLOUDINARY_URL
OPENAI_API_KEY
OPENAI_MODEL=gpt-image-2
OPENAI_IMAGE_ENABLED=true
AI_MOCK_MODE=false
RENDER_EXECUTION_MODE=durable
```

Optionnelles :

```text
OPENAI_VISION_MODEL=gpt-5.6-sol
OPENAI_SERVICE_TIER=fast
OPENAI_QUALITY=high
OPENAI_MAX_COST_USD=0.25
CLOUDINARY_UPLOAD_FOLDER=lilidecoai
MAX_UPLOAD_BYTES=4000000
GOOGLE_IMAGE_TIMEOUT_MS=240000
GOOGLE_IMAGE_MAX_RETRIES=1
GOOGLE_IMAGE_MAX_COST_USD=0.45
```

Vercel limite les requêtes de Functions à 4,5 Mo. L’interface accepte des
photos source jusqu’à 20 Mo, les redimensionne à 2 048 px maximum et les
compresse sous 3,5 Mo avant l’envoi. Ne pas augmenter `MAX_UPLOAD_BYTES` au-delà
de 4 000 000 : la surcharge multipart doit également rester sous la limite
Vercel.

`APP_SESSION_SECRET` et `CRON_SECRET` doivent être deux valeurs aléatoires
différentes. Ne jamais préfixer une clé secrète par `NEXT_PUBLIC_`.

## 5. Vérification avant et après déploiement

```powershell
npm.cmd ci
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run test:e2e
```

Smoke tests :

1. ouvrir `/v1/health` et confirmer `database: mongodb` et
   `storage: cloudinary` ;
2. créer un compte et se reconnecter ;
3. créer et préparer un produit, puis confirmer sa présence dans Cloudinary ;
4. envoyer une pièce puis produire un rendu local ;
5. rejouer la même clé d’idempotence et vérifier l’absence de double débit ;
6. valider l’ajout sur une zone libre et sur une zone occupée avec GPT Image 2 en Preview Vercel,
   puis en Production ;
7. appeler `/api/cron/purge` avec `Authorization: Bearer $CRON_SECRET`.

Avant le premier déploiement de cette version, inspecter la migration avec
`npm.cmd run migrate:image-pipeline`, puis l’appliquer explicitement avec
`npm.cmd run migrate:image-pipeline -- --apply`. Le script ne supprime aucun
champ et ne journalise jamais l’URI MongoDB.

### Migration obligatoire du lot 2 : propriété des images

Le contrôle d’accès aux images ne se déduit plus de leur type ; il lit la
`visibility` portée par l’image, et une valeur absente est lue comme **privée**
([lot 2](professionnalisation-lot-2.md)). Sur une base existante, tant que la
migration n’a pas tourné, une image catalogue répond donc **403** au lieu qu’un
upload de visiteur fuie. Le sens fermant est délibéré, mais la migration n’est
pas optionnelle :

```powershell
npm.cmd run migrate:asset-visibility
npm.cmd run migrate:asset-visibility -- --apply
```

Le premier appel s’exécute à blanc et affiche son plan. Si `private_session`
vaut zéro, vérifier les types d'assets, l'origine des créateurs et les images
privées déjà migrées : un lot composé uniquement d'images catalogue peut être
légitime. Une photo de visiteur sans rattachement correct bloque l'application.
Les images qu’aucun document ne référence restent privées et sont dénombrées
séparément. L'application sauvegarde les métadonnées originales dans
`migration_backups_asset_visibility_v1` et évite d'écraser une modification
concurrente. Sur Vercel, le drapeau ponctuel de build
`APPLY_ASSET_VISIBILITY_MIGRATION=true` applique le plan préalablement vérifié.

Après application, vérifier qu’une image du catalogue démo se lit sans session
et qu’une image importée par un visiteur répond 403 depuis une autre session.

## Livraison contrôlée du lot 1

La configuration `apps/web/vercel.json` exécute maintenant le contrôle de production avant le build. Il vérifie la configuration, l'accès aux modèles via GET (sans génération), MongoDB, la migration et l'authentification Cloudinary. Un échec bloque la construction.

Les variables Vercel sensibles ne sont pas relisibles après stockage ; un export vide ne prouve donc pas leur absence à l'exécution ([documentation Vercel](https://vercel.com/docs/environment-variables/sensitive-environment-variables)). Le contrôle tourne chez Vercel avec `--runtime`. Avec un fichier local contenant de vraies valeurs, il peut aussi être exécuté ainsi, sans afficher les secrets :

```powershell
node apps/web/scripts/production-preflight.mjs .vercel/production.env
```

Construire sans basculer le domaine principal, puis inspecter le déploiement et vérifier ses parcours avant promotion :

```powershell
vercel deploy --prod --skip-domain --yes
vercel inspect <deployment-id> --logs
node apps/web/scripts/production-smoke.mjs https://<deployment-url> <fichier-local-du-jeton-de-protection>
vercel promote <deployment-id> --yes
node apps/web/scripts/production-smoke.mjs https://lilidecoai-web.vercel.app
```

Pour une migration explicitement préparée, ajouter uniquement à ce déploiement `--build-env APPLY_IMAGE_PIPELINE_MIGRATION=true`. Ne pas enregistrer ce drapeau dans les variables permanentes du projet. La migration sauvegarde les champs concernés dans `migration_backups_image_pipeline_v1`, ne remplit que les champs manquants et peut être relancée sans réécrire les valeurs existantes.

Le smoke test crée deux sessions invitées et une image synthétique expirant selon la rétention configurée. Il vérifie 25 points, dont l'isolation des scènes entre sessions. Il ne lance ni analyse IA ni génération et ne purge pas les données existantes. Le GET de [description d'un modèle OpenAI](https://developers.openai.com/api/reference/resources/models/methods/retrieve) ne valide pas une génération complète, son coût ou sa qualité.

L'état livré et les limites restantes sont consignés dans [le compte rendu du 6 septembre](production-2026-09-06.md).

## Worker image durable sur Vercel

Les parcours `simple_point` et `standard` utilisent `render-durable-v2`.
`RENDER_EXECUTION_MODE=durable` active l'admission en file et le cron authentifié
par `CRON_SECRET`. La fonction dispose de 800 secondes et cède la main entre
étapes après cinq minutes, en conservant les points de reprise dans MongoDB.
Le contrôle de production vérifie les transactions et la révision immutable.
`VERCEL_GIT_COMMIT_SHA` prime ; pour une livraison CLI sans métadonnées Git,
fournir `RENDER_WORKER_REVISION` au build et à l'exécution avec le SHA livré.

Avant une nouvelle révision, drainer ou annuler les rendus actifs de l'ancienne.
Surveiller `render_worker_tick` dans les logs Vercel. `/v1/health` expose le mode
d'exécution. Voir [le guide du worker](../infra/render-worker.md) pour les limites
de reprise, la bascule et l'alternative facultative Node/Docker.
