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
5. Le serveur construit une composition déterministe, la vérifie avec un modèle
   de vision, puis l’harmonise avec `gpt-image-2.5-sunburst` en qualité `max`.
6. Un contrôle compare chaque objet au placement prévu et à sa photo originale.
   Une correction ciblée est possible ; le crédit n’est débité qu’après validation.

## Vérification

Le parcours boutique hybride utilise `SIMPLE_POINT_IMAGE_PROVIDER=myarchitectai`,
`MYARCHITECTAI_API_KEY` et `OPENAI_API_KEY`. Pour une insertion libre, OpenAI
analyse la scène puis génère une nouvelle vue complète du produit sur fond transparent
via Responses (Astra, raisonnement faible, et le modèle image figé à l’admission),
suivant la caméra estimée de la pièce. Le serveur place et dimensionne cette vue ;
MyArchitectAI apporte une intégration RGB limitée au produit et à son contact.
Le serveur restaure ensuite sa texture native intérieure en conservant la lumière
locale, la silhouette alpha et le contact intégrés.
OpenAI contrôle ensuite l’identité, la perspective, l’échelle et l’intégration.
Avant toute génération, les petites projections (largeur et hauteur projetées
inférieures à 64 pixels) et les remplacements confirmés sont dirigés vers un autre
parcours : MyArchitectAI compose la pièce, puis une unique édition locale opaque
OpenAI reprend ce résultat avec le catalogue et la pièce entière comme références.
Cette édition conserve la résolution native du premier résultat et emploie un
masque ainsi que des coordonnées exprimés dans le même cadre.
Un guide distinct indique le contact et la largeur attendus, sans dessiner de
silhouette ; l’image de base reste sans annotation.
L’objet et son appui sont générés ensemble dans une région bornée ; le fond extérieur
est restauré à l’identique. Un seul contrôle final applique les mêmes exigences,
sans nouvelle tentative après un refus. Les sélections de plusieurs produits utilisent OpenAI.
Pour les appels réels, définir `AI_MOCK_MODE=false`, `OPENAI_IMAGE_ENABLED=true`
et `RENDER_EXECUTION_MODE=durable` avec MongoDB Atlas ou un replica set et le
[worker configuré](infra/render-worker.md). Le délai boutique inclut l’attente
et s’arrête à 180 secondes ; cela borne l’exécution, sans garantir la latence
d’un fournisseur ou une reconstruction 3D exacte. Un échec ne consomme pas de
crédit boutique. Le contrôle de coût inclut le raisonnement Astra et l’image.
La capacité boutique se gère dans le back office et reste distincte des crédits
des fournisseurs. Conserver `RENDER_STAGE_CAPTURE=false` en production.

Références API : [MyArchitectAI](https://portal.myarchitectai.com/docs) et
[génération d’images OpenAI](https://developers.openai.com/api/docs/guides/tools-image-generation).

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
4. Ajouter `OPENAI_API_KEY`, définir `OPENAI_MODEL=gpt-image-2.5-sunburst`,
   `OPENAI_VISION_MODEL=gpt-6-astra`, `OPENAI_QUALITY=max`, puis mettre
   `AI_MOCK_MODE=false`. Aucune clé ne doit être préfixée par `NEXT_PUBLIC_`.
5. Ajouter `ADMIN_USERNAME` et `ADMIN_PASSWORD_HASH` pour ouvrir `/admin`.
6. Déployer, puis vérifier `/v1/health`.

Les détails sont dans [docs/deployment.md](docs/deployment.md).

## Documentation

- [Architecture](docs/architecture.md)
- [Back office et banque de produits](docs/back-office.md)
- [Provider OpenAI](docs/providers.md)
- [Audit image et améliorations du 20 septembre 2026](docs/audit-image-2026-09-20.md)
- [Exécution du plan image — état et validations](docs/execution-systeme-image-2026-09-21.md)
- [Worker de rendu durable et procédure de retour arrière](infra/render-worker.md)
- [Installation du widget](docs/widget.md)
- [Sécurité et confidentialité](docs/security.md)
- [Déploiement](docs/deployment.md)
