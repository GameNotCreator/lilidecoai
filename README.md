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
- administration : <http://localhost:3000/admin>
- santé API : <http://localhost:3000/v1/health>

Avec `DEMO_MODE=true`, un vase et un portefeuille de 12 crédits sont créés
automatiquement dans MongoDB. Avec `AI_MOCK_MODE=true`, le pipeline complet
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

## Parcours MVP

1. Le marchand crée un produit, téléverse sa photo et ses dimensions.
2. Le serveur produit un cutout normalisé.
3. Le client téléverse sa pièce avec consentement.
4. Il place un point rouge à l’endroit exact où le produit doit toucher le
   meuble, puis choisit le type de support : table, étagère, niche, mur ou sol.
5. Le modèle de vision conserve ce point et adapte l’échelle, la perspective et
   la lumière ; un placement local conserve le point si l’API est indisponible.
6. Next.js crée une composition unique et un masque qui protège le produit.
7. Gemini Flash produit l’aperçu et Gemini Pro le rendu final ; OpenAI reste un
   secours explicitement désactivé par défaut.
8. Un crédit est débité uniquement après un rendu réussi.

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
4. Ajouter `GOOGLE_AI_API_KEY`, puis mettre `AI_MOCK_MODE=false`. Garder
   `OPENAI_IMAGE_ENABLED=false` tant que le secours OpenAI n’est pas souhaité.
5. Déployer, puis vérifier `/v1/health`.

Les détails sont dans [docs/deployment.md](docs/deployment.md).

## Documentation

- [Architecture](docs/architecture.md)
- [Provider OpenAI](docs/providers.md)
- [Installation du widget](docs/widget.md)
- [Sécurité et confidentialité](docs/security.md)
- [Déploiement](docs/deployment.md)
