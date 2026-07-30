# Project Visualizer

SaaS de visualisation d’objets décoratifs dans une photo d’intérieur. Le produit
est placé par une couche géométrique déterministe ; l’IA ne travaille que
l’ombre, le contact, les contours et la lumière. Le mode démonstration couvre le
parcours complet sans clé, GPU, Docker ou service payant.

## Démarrage en quatre commandes

Prérequis : Node.js 24+, npm 11+, Python 3.12+.

```powershell
Copy-Item .env.example .env
npm.cmd install
python -m pip install -r services/api/requirements.txt
npm.cmd run dev
```

Ouvrir :

- web : <http://localhost:3000>
- studio : <http://localhost:3000/demo>
- marchand : <http://localhost:3000/app>
- administration : <http://localhost:3000/admin>
- API OpenAPI : <http://127.0.0.1:8000/docs>

Au premier démarrage, SQLite et les seeds de démonstration sont créés
automatiquement. Le compte démo contient un vase prêt à placer et 12 crédits.
L’absence de `OPENAI_API_KEY` ne bloque jamais le démarrage.

## Parcours MVP vérifié

1. Le marchand crée un produit, téléverse sa photo, renseigne ses dimensions,
   le prépare et confirme l’ancrage.
2. Le client téléverse une pièce avec consentement.
3. Il choisit une surface et le mode `estimé` ou `calibré`.
4. Il déplace et redimensionne le cutout dans l’éditeur Konva.
5. L’API compose l’image, l’ombre et le masque de protection.
6. `MockImageProvider` produit le rendu local ou `OpenAIImageProvider` appelle
   GPT Image 2 côté serveur.
7. Le cutout catalogue est reposé sur le résultat, puis le contrôle qualité
   accepte, retente ou rejette la sortie.
8. Un crédit est capturé uniquement après succès ; un échec final libère la
   réservation.

## Commandes utiles

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run test:e2e
npm.cmd run db:migrate
npm.cmd run db:seed
python services/api/scripts/purge.py
```

Docker Compose est optionnel et démarre PostgreSQL, Redis, MinIO, l’API et le
web :

```powershell
docker compose up --build
```

Docker n’était pas installé sur la machine de développement lors de la création
du MVP ; le chemin local SQLite a donc été validé directement.

## Arborescence

```text
apps/web                 Next.js : public, marchand, client, admin, widget
services/api             FastAPI, SQLAlchemy, paiement, rendu et sécurité
services/worker          frontière Redis du traitement asynchrone
packages/geometry        calibrations, homographie, projections et tests
packages/ai-router       contrat ImageGenerationProvider partagé
packages/types           schémas Zod et types métier
packages/ui              composants UI partagés
packages/analytics       événements métier sans photo
infra/docker             images de déploiement
docs                     architecture, sécurité, providers, widget, déploiement
tests/e2e                parcours Playwright
```

## Documentation

- [Architecture](docs/architecture.md)
- [Provider OpenAI et ajout d’un provider](docs/providers.md)
- [Installation du widget](docs/widget.md)
- [Sécurité et confidentialité](docs/security.md)
- [Déploiement](docs/deployment.md)

## État des connexions externes

Le connecteur OpenAI est implémenté mais n’a volontairement pas été appelé
sans credential. Supabase, R2, Konnect, PostHog et Sentry sont préparés par
contrats/configuration mais demandent des comptes réels et une validation de
staging avant activation. En local, leurs équivalents sont SQLite, stockage
disque, paiement mock et analytics SQL.

