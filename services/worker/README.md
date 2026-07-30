# Worker

Le worker réutilise `services/api/app/rendering/pipeline.py`. En mode démonstration,
l'API exécute le job immédiatement pour garder l'installation locale sans Redis.
En production, `worker.py` consomme la file Redis `renders` avec les mêmes clés
d'idempotence.

