# Worker de rendu durable sur Vercel

Le worker `render-durable-v2` exécute les parcours `simple_point` et `standard`,
y compris le remplacement avec masque confirmé. L'activation est explicite :
le défaut demeure `RENDER_EXECUTION_MODE=web`.

## Préconditions

- MongoDB Atlas ou replica set : la finalisation, le journal et le crédit
  nécessitent les transactions. Un MongoDB standalone est refusé au démarrage.
- Même base, stockage privé, modèles, qualité et révision sur le web et le
  worker. `RENDER_WORKER_REVISION`, lorsqu'elle est fournie, est prioritaire :
  le paquet CLI emploie l'identité `sha256:...` de son manifeste vérifié.
  À défaut, `VERCEL_GIT_COMMIT_SHA` doit contenir une révision Git complète.
  Une valeur explicite invalide est refusée en production même si Git est valide.
- Vercel Pro avec Fluid Compute pour le cron chaque minute et la fonction
  de 800 secondes. Aucun hébergement supplémentaire du worker n'est nécessaire.
- Le dimensionnement mémoire, les quotas fournisseurs et la charge restent à
  mesurer avec des générations réelles.

## Exécution Vercel

Configurer `RENDER_EXECUTION_MODE=durable` en production. Après l'enregistrement
du rendu, la route web envoie un réveil au worker dédié
`POST /api/cron/render-worker`, authentifié avec `CRON_SECRET`. Ce dernier répond
202 puis lance le traitement dans sa propre fonction de 800 secondes. Aucun
appel image ne s'exécute dans le callback de la route web limitée à 300 secondes.

La destination vient de `VERCEL_URL`, automatiquement disponible sur Vercel,
ou de `RENDER_WORKER_ORIGIN` : une origine HTTPS explicite du même déploiement,
sans chemin, identifiants ni paramètres. Aucun en-tête client ne la détermine.
Si Deployment Protection protège le domaine `*.vercel.app`, configurer
`VERCEL_AUTOMATION_BYPASS_SECRET` côté serveur pour le réveil. Un domaine
personnalisé explicitement configuré doit permettre l'accès à cette route ;
le secret de protection Vercel n'est jamais envoyé à un autre domaine.
Le délai du réveil est limité à cinq secondes, sans redirection ni nouvelle
tentative automatique. Un échec n'annule jamais la demande enregistrée.

Le cron `GET /api/cron/render-worker`, toujours authentifié avec `CRON_SECRET`,
reste le secours chaque minute. Chaque invocation réserve au plus deux rendus
(`RENDER_WORKER_CONCURRENCY`, borné à quatre). Les baux et les limites atomiques
MongoDB restent communs aux réveils et aux crons : une seule exécution possède
un rendu. Le journal `render_worker_tick` indique les traitements et erreurs de
chaque invocation. `render_worker_dispatch` distingue un réveil accepté,
refusé, indisponible ou non configuré, sans écrire de secret ni de photo.

Après cinq minutes, le worker termine l'étape en cours puis remet le rendu en
file avant la suivante. Cette interruption volontaire conserve les checkpoints
et le crédit réservé, sans consommer une tentative d'échec. Le prochain cron
reprend le même rendu. Un arrêt brutal reste couvert par les baux et les règles
`provider_unknown` décrites ci-dessous. Le délai métier maximal est de trente
minutes par défaut. Un réveil fonctionnel évite l'attente du premier cron quand
une place de traitement est disponible. La saturation, une reprise ou un réveil
indisponible peuvent encore attendre le cron ; aucun délai de démarrage garanti
n'est annoncé.

Sources : [fréquence des crons](https://vercel.com/docs/cron-jobs/usage-and-pricing),
[durée des fonctions](https://vercel.com/docs/functions/configuring-functions/duration).

## Alternative : processus Node indépendant

```powershell
npm ci --include=dev
$env:RENDER_EXECUTION_MODE = 'durable'
$env:RENDER_WORKER_REVISION = (Get-Content release-candidate.json -Raw | ConvertFrom-Json).workerRevision
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
2. Sur Vercel, livrer le web et sa route cron ensemble avec `durable` activé.
   Pour le processus indépendant, démarrer le worker avec la révision du web.
3. Surveiller erreurs, `provider_unknown`, rendus en attente, âge de file,
   échéances expirées, consommation et quotas. Aucune alerte externe n'est
   configurée par ce lot.
4. Avant de changer de révision sur Vercel, attendre la fin des rendus actifs ou
   les annuler explicitement : le cron vise la production courante. Un ancien
   déploiement sans cron actif ne draine pas sa file automatiquement.
5. Revenir à `web` désactive aussi le cron durable. Les rendus restants ne doivent
   donc pas être abandonnés lors de la bascule. Avec des processus indépendants,
   maintenir les anciens workers jusqu'à terminaison de leurs jobs. Ne pas
   réécrire la version d'un job en cours ; un job sans worker compatible expire
   explicitement.

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
