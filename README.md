# LiliDecoAI

SaaS Next.js de visualisation d’objets décoratifs dans une photo d’intérieur.
Le frontend et toutes les API sont hébergés ensemble sur Vercel. MongoDB est
l’unique base de données et Cloudinary conserve les images privées.

## Démarrage local

Prérequis : Node.js 24+, npm 11+ et MongoDB local ou un cluster Atlas.

```powershell
Copy-Item .env.example .env
npm.cmd install
npm.cmd run dev
```

Ouvrir :

- site : <http://localhost:3000>
- studio : <http://localhost:3000/demo>
- espace marchand : <http://localhost:3000/app>
- back office : <http://localhost:3000/admin>
- santé API : <http://localhost:3000/v1/health>

Le back office reste verrouillé tant que `ADMIN_USERNAME` et `ADMIN_PASSWORD`
(ou `ADMIN_PASSWORD_HASH`) ne sont pas définis, y compris en mode démo. Voir
[docs/back-office.md](docs/back-office.md).

Avec `DEMO_MODE=true`, un portefeuille de crédits de démonstration est créé
automatiquement dans MongoDB. La démo ne présélectionne aucun produit : chaque
visiteur envoie son propre objet. Avec `AI_MOCK_MODE=true`, le pipeline complet
reste testable sans appel payant. Sans configuration Cloudinary en local, les images sont
stockées en binaire dans MongoDB.

## Architecture

```text
apps/web                 Next.js : pages, Route Handlers, auth et rendu
packages/geometry        calibrations, homographie et projections
packages/ai-router       contrat TypeScript des providers d’image
packages/types           schémas Zod et types métier
packages/ui              composants UI partagés
packages/analytics       événements métier sans photo
docs                     architecture, sécurité, providers et déploiement
tests/e2e                parcours Playwright desktop et mobile
```

Il n’y a ni FastAPI, ni Supabase, ni serveur API séparé. Le navigateur appelle
les routes Next.js de même origine sous `/v1/*`. Les collections MongoDB
contiennent produits, scènes, rendus, utilisateurs, crédits, transactions,
tentatives de rendu, analytics et audits.

## Parcours de la démo

1. Le visiteur téléverse les photos de un à trois objets à placer.
2. Pour chaque objet, il choisit `Hauteur + longueur` ou
   `Longueur + largeur`, puis indique les deux dimensions en centimètres.
3. Il téléverse la photo du lieu, prise à au moins 1,5 mètre.
4. Il place dans l’ordre jusqu’à trois points rouges numérotés ; chaque point
   reste associé à l’objet portant le même numéro et peut être repositionné.
5. Next.js transmet la photo du lieu en image 1, puis les objets en images 2 à
   4, avec le prompt multi-points à `gpt-image-2` via l’API d’édition OpenAI.
6. Un crédit est débité uniquement après un rendu réussi.

## Vérification

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run test:e2e
```

## Déploiement Vercel

1. Importer `GameNotCreator/lilidecoai` dans Vercel.
2. Choisir `apps/web` comme Root Directory et autoriser les fichiers du monorepo
   situés hors de ce dossier.
3. Ajouter `MONGODB_URI`, `MONGODB_DB`, `APP_SESSION_SECRET`, `CRON_SECRET` et
   la variable `CLOUDINARY_URL` copiée depuis Cloudinary.
4. Ajouter `OPENAI_API_KEY`, définir `OPENAI_MODEL=gpt-image-2`, puis mettre
   `AI_MOCK_MODE=false`. Aucune clé ne doit être préfixée par `NEXT_PUBLIC_`.
5. Ajouter `ADMIN_USERNAME` et `ADMIN_PASSWORD_HASH` pour ouvrir `/admin`.
6. Déployer, puis vérifier `/v1/health`.

Les détails sont dans [docs/deployment.md](docs/deployment.md).

## Documentation

- [Architecture](docs/architecture.md)
- [Back office et banque de produits](docs/back-office.md)
- [Provider OpenAI](docs/providers.md)
- [Installation du widget](docs/widget.md)
- [Sécurité et confidentialité](docs/security.md)
- [Déploiement](docs/deployment.md)
