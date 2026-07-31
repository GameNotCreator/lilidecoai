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

`apps/web/vercel.json` déclare le cron de purge et la configuration Next.js.

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
```

Optionnelles :

```text
OPENAI_API_KEY
OPENAI_MODEL=gpt-image-2
OPENAI_QUALITY=medium
OPENAI_MAX_COST_USD=0.25
CLOUDINARY_UPLOAD_FOLDER=lilidecoai
MAX_UPLOAD_BYTES=4000000
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
6. activer OpenAI sur Preview avant Production ;
7. appeler `/api/cron/purge` avec `Authorization: Bearer $CRON_SECRET`.
