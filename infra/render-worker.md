# Worker de rendu séparé

Le worker `render-durable-v2` exécute les parcours `simple_point` et `standard`,
y compris le remplacement avec masque confirmé. L'activation est explicite :
le défaut demeure `RENDER_EXECUTION_MODE=web`.

## Préconditions

- MongoDB Atlas ou replica set : la finalisation, le journal et le crédit
  nécessitent les transactions. Un MongoDB standalone est refusé au démarrage.
- Même base, stockage privé, modèles, qualité, mode simulé et
  `RENDER_WORKER_REVISION` sur le web et le worker. En production, utiliser une
  révision de livraison immutable (par exemple le SHA du commit).
- Un processus Node 24 persistant, avec accès réseau aux fournisseurs et au
  stockage. Ne pas lancer ce processus dans une fonction Vercel.
- Superviser le processus et son redémarrage. Le dimensionnement mémoire,
  les quotas fournisseurs et la charge restent à mesurer avant production.

## Exécution

```powershell
npm ci --include=dev
$env:RENDER_EXECUTION_MODE = 'durable'
$env:RENDER_WORKER_REVISION = 'revision-de-la-preproduction'
npm run worker:render
```

La commande charge `.env` si présent. Les variables injectées par l'hébergeur
priment. `--once` traite au plus un rendu et s'arrête, pour les diagnostics.
Ne jamais démarrer de worker de test contre la base de production.

Image Docker, depuis la racine du dépôt :

```text
docker build -f infra/Dockerfile.render-worker -t lilideco-render-worker .
docker run --env-file /chemin/protege/worker.env lilideco-render-worker
```

Le Dockerfile ne copie aucun fichier `.env`. Il constitue un livrable de
déploiement ; cette image n'a pas été construite ni hébergée lors de ce lot.

## Contrat et reprise

L'admission insère un unique document de rendu, contenant la requête normalisée,
les métadonnées produit/pièce figées et les références des sources. Pas d'image
encodée dans la file. L'image catalogue peut changer ensuite sans changer le
contrat du rendu ; une source supprimée/expirée provoque un échec explicite.
Pour un remplacement standard, le masque doit correspondre à une segmentation
confirmée de la même pièce, boutique et session. Son identité et ses métadonnées
sont figées à l'admission ; son asset est vérifié avant toute dépense.
Ajouter sur un point occupé ne déclenche jamais une suppression automatique.

La réservation atomique attribue un jeton et un bail de 90 secondes, renouvelé
toutes les 20 secondes. Le contrôle de concurrence utilise une décision
transactionnelle commune : quatre rendus globalement et deux par boutique par
défaut. Les opérations coûteuses s'exécutent hors transaction. Chaque écriture
du worker exige le jeton courant, un bail valide et l'échéance métier.

Le worker persiste l'analyse d'échelle, les inspections, la composition sans
perte, le précontrôle, les sorties d'image et les décisions qualité. Les buffers
deviennent des assets privés ; le masque RGBA est conservé en PNG sans perte.
La reprise relit ces points de reprise. Les autres calculs déterministes et
certains assets de diagnostic peuvent être recalculés.

Une panne du juge réessaie le contrôle du même candidat. Une réponse d'image
perdue, ou un processus mort entre l'appel payant et la persistance, produit
`provider_unknown` : aucun nouvel appel image automatique. Les fournisseurs
actuels ne proposent pas de rapprochement utilisé ici. Un opérateur doit
examiner l'historique avant de décider un nouveau rendu. Les analyses peuvent
être répétées et facturées ; trois tentatives par étape et douze acquisitions
par rendu bornent les reprises. Les 429 confirmés utilisent un délai progressif.
Les reprises internes de l'adaptateur Google sont désactivées dans le worker :
la file décide de chaque nouvelle tentative. Le nettoyage, la première image,
la réparation et leurs contrôles ont des checkpoints distincts. Une réparation
déjà générée reste contrôlable même si le temps restant ne permet plus de lancer
une nouvelle génération.

Une réussite publie la référence du résultat, capture le crédit et écrit le
journal dans une transaction. L'annulation concurrente gagne ou perd cette
transaction, sans résurrection ni second débit. Une suppression d'un résultat
déjà livré n'est pas un remboursement. Le balayage ancien des réservations
ignore les rendus durables actifs ; le worker et le cron terminent les rendus
hors délai. Les checkpoints héritent de la rétention de la pièce ; leurs
références sont incluses dans la suppression du rendu. Un asset stocké juste
avant un crash mais non référencé sera purgé à son expiration.

## Déploiement progressif et retour arrière

1. Exécuter les contrôles logiciels et le pilote réel en préproduction.
2. Démarrer le worker avec la révision du web, puis activer `durable` sur le web.
3. Surveiller erreurs, `provider_unknown`, rendus en attente, âge de file,
   échéances expirées, consommation et quotas. Aucune alerte externe n'est
   configurée par ce lot.
4. Pour arrêter les nouvelles admissions durables, remettre le web en `web`.
   Garder les anciens workers jusqu'à terminaison ou annulation de leurs jobs.
5. Lors d'un changement de révision, maintenir les deux workers : chacun ne
   réserve que les documents portant son empreinte. Ne pas réécrire la version
   d'un job en cours. Un job sans worker compatible expire explicitement.

La version v2 ne réserve pas les anciens jobs `simple-durable-v1`. Si des jobs
v1 existent, conserver leur binaire/configuration pour les drainer. Aucun document
en cours n'est converti automatiquement. L'empreinte v2 inclut les modèles,
endpoints, disponibilité et paramètres OpenAI/Google, sans contenir les clés.

## Vérifier localement

```text
npm run test:durable
npm run test:durable:integration
npm run test:e2e:isolated
```

Les tests d'intégration créent un replica set temporaire et détruisent seulement
leur base aléatoire. Ils n'utilisent aucun fournisseur réel. L'ancienneté de
six minutes est injectée dans un cas de test ; il ne s'agit pas d'une génération
réelle mesurée pendant six minutes. Les tests de charge et l'arrêt brutal d'un
processus pendant un appel fournisseur réel restent à exécuter en préproduction.
