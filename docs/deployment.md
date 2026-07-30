# Déploiement

## Environnements

### Développement sans Docker

SQLite, disque, provider image mock et paiement mock. C’est le chemin couvert
par les tests locaux.

### Staging

PostgreSQL, Redis, bucket S3/R2 privé, Supabase Auth et clés de test Konnect.
Garder `DEMO_MODE=true` tant qu’aucun appel OpenAI n’est souhaité, puis le
désactiver pour un smoke test manuel plafonné.

### Production

- `DEMO_MODE=false`
- PostgreSQL managé avec sauvegardes
- Redis partagé pour rate limit et jobs
- R2 privé, lifecycle de suppression et URLs signées
- worker séparé
- web et API sur origines explicitement autorisées
- secrets dans le gestionnaire de la plateforme

## Procédure

```powershell
npm.cmd ci
python -m pip install -r services/api/requirements.txt
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run db:migrate
```

Déployer l’API avant le web, vérifier `/health`, puis injecter
`NEXT_PUBLIC_API_URL` au build. Démarrer ensuite le worker avec
`PYTHONPATH=services/api python services/worker/worker.py`.

## Smoke tests

1. Créer un produit dans une organisation de staging.
2. Vérifier le cutout et l’ancrage.
3. Créer une scène et confirmer l’URL privée.
4. Produire un rendu mock.
5. Avec un plafond faible, produire exactement un rendu OpenAI manuel.
6. Vérifier `render_attempts`, score qualité, coût, durée et débit unique.
7. Rejouer le même idempotency key.
8. Simuler un échec final et confirmer le solde inchangé.
9. Tester un webhook Konnect deux fois.
10. Exécuter et contrôler la purge.

