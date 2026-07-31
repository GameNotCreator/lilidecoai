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

## 3. Vercel Blob

Dans Storage, créer ou connecter un Blob store privé au projet. Les nouveaux
projets utilisent automatiquement l’authentification OIDC à durée courte. Le
code reste compatible avec `BLOB_READ_WRITE_TOKEN` pour un ancien store ou un
outil local. Les blobs sont servis via `/api/assets/:id` après les contrôles
d’accès.

## 4. Variables Vercel

Obligatoires en production :

```text
MONGODB_URI
MONGODB_DB
APP_SESSION_SECRET
CRON_SECRET
DEMO_MODE=false
```

Optionnelles :

```text
OPENAI_API_KEY
OPENAI_MODEL=gpt-image-2
OPENAI_QUALITY=medium
OPENAI_MAX_COST_USD=0.25
BLOB_READ_WRITE_TOKEN
```

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

1. ouvrir `/v1/health` et confirmer `database: mongodb` ;
2. créer un compte et se reconnecter ;
3. créer et préparer un produit ;
4. envoyer une pièce puis produire un rendu local ;
5. rejouer la même clé d’idempotence et vérifier l’absence de double débit ;
6. activer OpenAI sur Preview avant Production ;
7. appeler `/api/cron/purge` avec `Authorization: Bearer $CRON_SECRET`.
