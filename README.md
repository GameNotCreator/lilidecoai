# LiliDecoAI

SaaS Next.js de visualisation d’objets décoratifs dans une photo d’intérieur.
Le frontend et toutes les API sont hébergés ensemble sur Vercel. MongoDB est
l’unique base de données et Vercel Blob conserve les images privées.

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
automatiquement dans MongoDB. Sans clé OpenAI, le pipeline de rendu local reste
entièrement utilisable. Sans token Vercel Blob en local, les images sont
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
tentatives de rendu, paiements, analytics et audits.

## Parcours MVP

1. Le marchand crée un produit, téléverse sa photo et ses dimensions.
2. Le serveur produit un cutout normalisé.
3. Le client téléverse sa pièce avec consentement.
4. Il choisit une surface et ajuste le produit dans l’éditeur Konva.
5. Next.js crée la composition et le masque avec Sharp.
6. Le mode local finalise le rendu sans coût, ou GPT Image 2 harmonise lumière,
   ombre et contact.
7. Le cutout catalogue est reposé sur la sortie pour préserver le produit.
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
3. Connecter un store Vercel Blob privé ; Vercel fournit automatiquement
   l’authentification OIDC.
4. Ajouter `MONGODB_URI`, `MONGODB_DB`, `APP_SESSION_SECRET`, `CRON_SECRET` et
   `NEXT_PUBLIC_APP_URL`.
5. Ajouter `OPENAI_API_KEY` et les variables Konnect uniquement pour activer ces
   services.
6. Déployer, puis vérifier `/v1/health`.

Les détails sont dans [docs/deployment.md](docs/deployment.md).

## Documentation

- [Architecture](docs/architecture.md)
- [Provider OpenAI](docs/providers.md)
- [Installation du widget](docs/widget.md)
- [Sécurité et confidentialité](docs/security.md)
- [Déploiement](docs/deployment.md)
