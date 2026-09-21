# Professionnalisation — lot 2 : propriété des images, crédits et mesure des coûts

Date : 6 septembre 2026. Implémentation locale, sans déploiement ni appel IA payant de validation.

Ce lot poursuit la phase 1 du [plan audité](audit-plan-professionnalisation-2026-09-05.md) après le
[lot 1](professionnalisation-lot-1.md), dont la « suite prioritaire » listait exactement ces travaux :
PRO-005 (uploads privés et expiration), PRO-004 (réservation des crédits), PRO-006 (traces par étape).
Il traite en plus A15, découvert lors de la reconnaissance. Il ne clôture ni la phase 1 ni la
professionnalisation.

## Ce qui est corrigé

| Constat | Ticket | État |
|---|---|---|
| A16 — images `product`/`cutout` publiques par leur *type*, `DEMO_MODE` court-circuitant l'autorisation | PRO-005 | Corrigé |
| A17 — expiration seulement effective à la purge quotidienne, dérivés orphelins | PRO-005 | Corrigé |
| A11 — débit après coup, sans réservation ni libération | PRO-004 | Corrigé pour le document portefeuille |
| A13 — coût limité à l'édition finale, réponse perdue comptée à zéro | PRO-006 | Partiellement corrigé |
| A15 — cache d'échelle non versionné | — | Corrigé |

## PRO-005 — catalogue publié contre upload privé

### Le défaut

`app/api/assets/[id]/route.ts` déduisait le droit de lecture du **type** de l'image : tout asset
`product` ou `cutout` était servi à quiconque connaissait l'URL. Or la photo d'objet qu'un visiteur
importe dans la démo est stockée avec exactement le même type que la photo catalogue d'un marchand.
Une URL devinée ou partagée suffisait. En `DEMO_MODE`, le contrôle des autres types était entièrement
désactivé. `readAsset` ne regardait pas `expiresAt` : une photo restait lisible jusqu'à ce que la
purge quotidienne la rencontre, soit jusqu'à 24 h après la rétention promise.

### Le correctif

La publication devient une propriété portée par l'image, jamais une déduction :

- `AssetDocument.visibility` : `"published" | "private"`, et `ownerSessionId` quand une session de
  visiteur possède l'upload.
- `storeAsset` **exige** `visibility`. Les 15 sites d'appel déclarent leur choix ; un nouveau site qui
  l'oublierait ne compile pas.
- `asset-access.ts` décide en un seul endroit : publié → lisible sans session ; `ownerSessionId` →
  cette session seule ; sinon → un membre connecté de l'organisation, jamais une session de visiteur.
- `readAsset` refuse une image expirée, et `assetAccess` le revérifie.

Deux pièges ont été trouvés par la revue et corrigés avant livraison :

1. **L'identité de la démo.** `tenantForRequest` rend, en `DEMO_MODE`, une identité de propriétaire
   d'organisation à une requête sans session. Retirer le court-circuit du contrôle ne suffisait donc
   pas : cette identité aurait continué à tout lire. `Tenant.synthetic` la marque — elle n'est jamais
   signée dans un jeton, donc une vraie session ne peut pas la revendiquer — et elle ne lit que le
   catalogue publié.
2. **Deux formes d'identifiant de session.** Une session invitée porte `guest:<uuid>`, une session du
   widget public porte un **UUID nu**. Le script de migration testait un préfixe : toute photo de
   pièce d'un visiteur du widget aurait été classée « organisation », c'est-à-dire lisible par
   l'identité partagée de la démo. Les deux champs porteurs (`publicSessionId` sur les scènes, rendus
   et segmentations ; `createdByUserId` sur les produits) sont désormais lus par deux fonctions
   distinctes.

### Rétention

- Une image expirée est refusée en lecture, quel que soit le demandeur (404).
- La purge **revérifie** l'expiration au moment de la destruction : une expiration levée entre la
  sélection du lot et la suppression ne détruit plus l'image.
- L'archivage d'un produit pose enfin une expiration sur ses images. Elles restaient sinon
  indéfiniment, la purge ne lisant que `expiresAt`. C'était la seule famille de dérivés réellement
  orphelins : composites, masques et résultats héritent déjà de `scene.expiresAt` à leur création.
- La purge annonce son reliquat et distingue supprimé, échoué et ignoré. Un lot tronqué à 500 se
  lisait auparavant comme « tout est supprimé ».

Une première version de ce lot ajoutait une passe dédiée aux dérivés, retrouvés par la scène
expirée. La revue adversariale l'a montrée inerte : la collection `scenes` porte un index TTL sur
`expiresAt`, donc MongoDB supprime ces documents avant qu'une telle requête puisse les joindre. La
passe a été retirée plutôt que conservée en apparence de garantie.

### Migration obligatoire

`asset-access.ts` lit une `visibility` absente comme **privée**. Le choix est délibérément fermant :
sur une base non migrée une image catalogue répond 403 au lieu qu'un upload fuie. Le script
reconstruit la propriété depuis les documents qui référencent chaque image, jamais depuis son type.

```bash
npm run migrate:asset-visibility
```

Il s'exécute à blanc et affiche son plan. Sur une base ayant servi du trafic widget ou démo, un
compte `private_session` à zéro est la signature du bug de rattachement décrit plus haut : le script
le signale et il faut vérifier avant `--apply`. Les images qu'aucun document ne référence restent
privées et sont dénombrées ; leur inventer un propriétaire serait pire.

**Le back-office** s'authentifie par un cookie qui lui est propre (`admin-auth.ts`), inconnu de
`tenantsForRequest` : sans rien de plus, il aurait affiché une vignette cassée pour chaque image
privée de son organisation. La route d'images lui accorde donc l'identité de l'organisation qu'il
administre — **là et nulle part ailleurs** : la placer dans `tenantsForRequest` ferait agir un jeton
de back-office comme un marchand sur toute l'API, ce pour quoi il n'a jamais été émis.

Le **catalogue de démonstration** est la seule exception, et il n'a pas besoin du script : `seed.ts`
sort tôt quand un produit existe déjà, donc une base seedée avant ce lot n'aurait jamais reçu de
`visibility` et tout le catalogue aurait répondu 403 — c'est ainsi que le test E2E d'isolation a
échoué à sa première exécution. `publishCatalogImages` répare cela à chaque amorçage : ces
identifiants sont fixes et connus pour être du catalogue, il n'y a rien à reconstruire. Le script de
migration reste réservé aux images importées par des marchands et des visiteurs.

## PRO-004 — réservation, capture et libération des crédits

### Le défaut

`createRender` ne vérifiait aucun solde. Le portefeuille n'était débité qu'à la toute fin d'un rendu
réussi. Dix requêtes simultanées atteignaient donc le fournisseur payant avec un seul crédit entre
elles, et une interruption laissait portefeuille, journal et rendu incohérents.

### Le correctif

    réserver → (pipeline payant) → capturer à la livraison
                                └→ libérer en cas d'échec, d'annulation ou de rejet qualité

- `reserveCredit` sort le crédit du solde dépensable et le place dans `holds`, **avant** le premier
  appel payant. Sans crédit disponible, le rendu échoue avant toute dépense.
- `captureCredit` consomme la réservation ; `releaseCredit` la rend.
- Les trois opérations sont idempotentes sur la clé `render:<id>` et sont chacune **une seule mise à
  jour atomique du document portefeuille**.
- `stopRender` (annulation et suppression) et `recordRenderFailure` libèrent.
- Un rendu commencé avant ce lot n'a pas de réservation : `captureCredit` retombe sur un débit direct
  plutôt que d'échouer à la livraison.

### Ce que ce correctif ne prouve pas

Ce déploiement n'a pas de transactions multi-documents : MongoDB ne les offre pas hors *replica set*,
et le développement local comme la CI utilisent un serveur autonome. L'atomicité obtenue est donc
celle du **document portefeuille**, ce qui suffit pour la concurrence — le point de A11 — mais pas
pour lier le portefeuille, son journal et le rendu. C'est écrit dans le module plutôt que sous-entendu :
le portefeuille fait foi, et le journal `credit_transactions` peut retarder d'un crash.

### Reprise après la mort d'un processus

Un rendu tué en vol n'exécute aucun des chemins qui rendent son crédit, et une finalisation
interrompue laissait un rendu que **personne ne pouvait plus annuler, supprimer ni rembourser** : les
deux branches de `stopRender` refusent exactement « en traitement, avec un jeton ». Les deux trous
sont fermés avec ce qui était déjà persisté, sans nouvel état ni nouveau travail planifié :

- une revendication de finalisation n'est crue que pendant trois fois la durée maximale de la route ;
  au-delà, elle appartient à un processus mort et l'arrêt passe (`finalizationStartedAt`) ;
- la purge quotidienne rend les crédits retenus par des exécutions du même âge (`reservedAt`), via le
  même `releaseCredit` idempotent — une exécution qui aurait finalement abouti ne change rien.

Ce n'est pas encore l'exécution durable de la phase 5 : rien ne **reprend** un rendu interrompu, il
est seulement rendu arrêtable et son crédit récupérable. A12 reste entier.

`processedKeys` reste un tableau append-only sur le portefeuille : il grandit à chaque rendu et n'est
jamais élagué. Une organisation très active finira par approcher la limite de 16 Mo d'un document
BSON. Le défaut préexiste à ce lot ; il est signalé, pas corrigé.

## PRO-006 — journal des appels payants et budget

### Le défaut

Un rendu déclarait le coût de son édition finale et rien d'autre. Le détourage génératif, l'estimation
d'échelle, l'inspection et le nettoyage d'obstacle étaient payés et invisibles. Une réponse perdue
était enregistrée à **zéro**, alors que le fournisseur l'a probablement exécutée.

### Le correctif

`provider-usage.ts` pose trois règles :

1. Chaque appel payant est journalisé, échecs compris. Un appel dont l'issue est réellement inconnue —
   délai dépassé, réponse perdue — est marqué `unknown` **avec son coût compté**.
2. Le rendu porte le cumul (`usageTotals`), lisible sans jointure et exposé par le sérialiseur.
3. `assertRenderBudget` refuse l'étape payante suivante quand le plafond du rendu est atteint. Le
   contrôle est fait **avant** l'appel : le but n'est pas de constater le dépassement.

Sites instrumentés dans le parcours simple : inspection d'obstacle, suppression d'obstacle, édition
finale et contrôle qualité, plus le passage de `recordProviderAttempt` par le même journal.

La revue a ensuite trouvé deux appels payants que ces règles ne couvraient toujours pas, l'un et
l'autre dans les parcours que je prétendais instrumenter :

- `openAIEdit` — l'appel le plus cher du parcours standard — poste directement sur `/images/edits`
  sans passer par l'adaptateur, et n'atteignait donc **aucun** journal ; un délai de 150 s y était
  compté gratuit. Ses trois issues sont maintenant enregistrées, sur la même règle que l'adaptateur ;
- l'estimation d'échelle était le dernier appel payant du parcours simple à n'être journalisé nulle
  part. Elle rapporte désormais ce qu'elle a réellement fait — rien sur un succès de cache ou en mode
  simulé — et le rendu l'enregistre. Une réponse HTTP 200 tronquée y était traitée comme un repli
  gratuit ; elle est facturée, et comptée comme telle ;
- le parcours standard exécutait son inspection et son nettoyage d'obstacle sans journal ni plafond,
  alors que le parcours simple mesurait **les mêmes fonctions**. Les deux passent maintenant par le
  même enregistreur ;
- la suppression d'un obstacle par Google écrivait sa ligne de journal à la main : elle atteignait
  `render_attempts` mais ni le cumul ni le budget ;
- je tarifais la suppression d'obstacle au niveau de qualité configuré alors qu'elle envoie
  `quality: "medium"` — quatre fois trop cher.

### Ce qui reste non mesuré

Honnêtement délimité, car le mesurer à moitié serait pire que de le dire :

- **`/v1/products/:id/prepare`** (isolation générative du détourage) et **`/v1/scenes/:id/scale`**
  (estimation d'échelle appelée hors rendu) sont des appels payants **hors rendu**, atteignables
  depuis une session invitée gratuite, sans crédit réservé ni plafond en dollars — seulement une
  limite en nombre de requêtes, qui n'est pas une limite de dépense. C'est le trou de dépense le plus
  large qui subsiste.
- `measureProviderCall` ne facture un échec au tarif plein que s'il **peut** avoir atteint le modèle.
  Un refus que le fournisseur a lui-même répondu — un 4xx, un blocage — est marqué par le code qui a
  lu la réponse (`markProviderRefusal`) et enregistré comme un échec connu, à coût nul. Le marqueur
  est posé par l'appelant, jamais deviné ici : seul le code qui a lu la réponse sait si le
  fournisseur a répondu. Tous les appelants ne le posent pas encore ; ceux qui l'omettent restent
  comptés au tarif plein, ce qui **sur-estime** le coût et déclenche le plafond trop tôt — l'inverse
  d'A13, donc le sens sûr.
- Les montants viennent de constantes locales. Ils bornent un rendu emballé ; ils ne rapprochent
  aucune facture.
- L'ancien champ `estimatedCostUsd` continue de porter le seul coût de l'édition finale, pour les
  lecteurs existants. Le total réel est dans `usageTotals`, et l'interface marchande ne l'affiche pas
  encore.

Le plafond par rendu ne borne pas la concurrence ; c'est la réservation de crédit de PRO-004 qui joue
ce rôle, un crédit par rendu.

## A15 — versionnage du cache d'échelle

La clé de cache ne contenait que les points arrondis et le type de pose. Un changement de modèle, de
prompt ou d'algorithme n'invalidait rien : une scène pouvait resservir une estimation que le code
courant ne produirait plus. La clé porte désormais `SCALE_ESTIMATION_VERSION` et le modèle de vision.

L'arrondi à deux décimales reste une tolérance de 1 % sur la position du doigt, pas une affirmation
que deux points proches partagent le même support : un point de part et d'autre d'un rebord peut
encore entrer en collision. Les distinguer demanderait le support que l'estimateur lui-même retourne,
inconnu avant l'appel. Le commentaire du code le dit plutôt que de le laisser croire.

## Méthode

La reconnaissance et le design ont été menés par 32 agents : 14 lecteurs cartographiant chacun une
zone (propriété des images, autorisations, rétention, crédits, cycle de vie, appels fournisseurs,
journal, cache d'échelle, contrat de réponse, tests, E2E, mode démo, surface HTTP), puis trois
conceptions indépendantes par ticket — angle minimal, angle contractuel, angle « partir des pannes » —
notées par trois juges chacune sous des angles distincts.

Deux défauts critiques de ma propre implémentation viennent de ce jury : le rattachement des sessions
du widget dans la migration, et la fermeture structurelle de l'identité `DEMO_MODE`. Ils étaient
présents dans le code avant que le jury ne rende, et corrigés après.

Une revue adversariale distincte a ensuite cherché des défauts dans le code livré : dix chercheurs par
dimension, puis trois réfutateurs indépendants par constat, un constat n'étant retenu que si la
majorité échoue à le réfuter. Elle a produit vingt-et-une corrections supplémentaires, dont quatre critiques :

- **la restauration d'un produit archivé ne levait pas l'expiration posée par l'archivage** : la purge
  aurait détruit les images d'un produit redevenu vivant. Défaut introduit par ce lot ;
- **des appels facturés journalisés comme des échecs gratuits.** Le constat le plus profond de la
  revue, et celui que j'avais cru corriger deux fois. Le contrôle qualité OpenAI n'alimentait aucun
  journal et l'échec du contrôle Google était enregistré à coût nul — corrigé. Mais A13 survivait
  encore **dans les adaptateurs eux-mêmes** : `failure()` et `failedResult()` fixaient
  `estimatedCostUsd: 0` sur *tout* échec, y compris un délai de 180 s dépassé sur une requête que le
  modèle a très probablement exécutée et facturée, et un HTTP 200 sans image. Trois conséquences :
  le coût par rendu accepté était sous-estimé précisément par les appels ratés qui le dominent,
  `unknownOutcomeCalls` valait zéro dans le cas même pour lequel il avait été ajouté, et un travail
  qui expirait en boucle n'accumulait **rien** contre son budget — `RenderBudgetError` ne pouvait
  jamais se déclencher. Désormais un adaptateur facture ce que l'appel a pu coûter, zéro étant
  réservé à ce que le fournisseur a refusé avant de l'exécuter (4xx, blocage de sécurité, connexion
  jamais établie), et un échec au coût non nul est enregistré comme `unknown`.

  Une revue ciblée de ce correctif a trouvé quatre défauts **dans le correctif lui-même**, tous
  corrigés : je facturais un délai Google par nombre total de tentatives alors que `callGoogleModel`
  ne conserve que la **dernière** erreur — un délai suivi d'un 429 devenait gratuit, un 429 suivi d'un
  délai était facturé double ; le compteur porte maintenant les tentatives réellement expirées. Le
  contrôle qualité Google était facturé au tarif OpenAI, dix fois trop cher. `renderBudgetUsd()`
  devenait `NaN` sur une variable d'environnement malformée, ce qui désactivait silencieusement tout
  plafond — un plafond qui échoue en ouvert n'est pas un plafond. Et deux barèmes distincts
  tarifaient le même appel `/images/edits` : la garde de budget évaluait à 0,115 $ ce que le journal
  enregistrait ensuite à 0,165 $. Il n'y a plus qu'un barème, exporté par l'adaptateur ;
- la passe de purge des dérivés, inerte à cause de l'index TTL, retirée ;
- le robinet à crédits de la démo, qui distribuait douze crédits dès qu'une **réservation** faisait
  tomber le solde à zéro, alors qu'un rendu était simplement en cours ;
- la page Portefeuille, qui affirmait « une réservation n'altère pas le solde » — l'inverse du modèle
  livré — et n'affichait pas les crédits retenus ;
- `publishCatalogImages`, après l'échec du test E2E d'isolation sur une base seedée avant ce lot ;
- **`POST /v1/auth/guest` acceptait un identifiant de session fourni par le client** : puisque la
  session de visiteur est exactement ce qui protège ses photos, une identité que n'importe qui peut
  revendiquer en la nommant n'est pas une identité. Le paramètre est ignoré ; la continuité après un
  rechargement vient du cookie, que le navigateur ne peut pas forger. Défaut antérieur à ce lot, mais
  que ce lot rend déterminant ;
- **la visibilité du détourage suivait l'appelant et non le produit** : en mode démo, l'identité
  synthétique atteint n'importe quel produit de l'organisation partagée, donc appeler `/prepare` sur
  l'objet d'un visiteur aurait publié un détourage lisible par tous de sa photo privée. Elle suit
  désormais `product.createdByUserId`, dans l'API publique comme dans le back-office ;
- `persistProduct`, qui adopte un objet de visiteur dans le catalogue, ne republiait pas ses images :
  le produit s'y serait retrouvé avec des images que seule la session d'origine pouvait lire ;
- le cookie `lili_session` masquait la session invitée sur les requêtes `<img>`, un marchand connecté
  visitant la démo recevant 403 sur toutes ses images. La route d'images considère maintenant **toutes**
  les identités que la requête porte et sert si l'une d'elles y a droit ;
- l'historique de rendus du marchand affichait des vignettes en 403 pour tout rendu venu du widget. Un
  membre connecté de l'organisation lit désormais les images des sessions faites chez lui — jamais
  l'identité synthétique, jamais un autre visiteur ;
- le back-office ne recevait aucune identité sur la route d'images ;
- ma revérification d'expiration dans la purge annonçait fermer une fenêtre qu'elle ne fermait pas :
  lire puis supprimer n'est pas atomique. La suppression est désormais **revendiquée** par une seule
  écriture atomique. Ce qui reste ouvert est écrit dans le code : l'objet de stockage est détruit
  après la revendication, et le fermer demanderait stockage et métadonnées sous un même commit, dont
  ce déploiement ne dispose pas ;
- **un rendu terminé après l'expiration de sa scène produisait une image déjà illisible — et le crédit
  était capturé quand même.** Toute image d'un rendu hérite de l'expiration de la scène ; le rendu est
  désormais refusé à l'admission si la scène a moins que la durée maximale de la route devant elle.
  Une seule garde couvre tous les parcours et toutes les images dérivées ;
- les deux routes du back-office stockaient leurs images sans hériter de l'expiration du produit, à la
  différence des routes publiques : celles d'un produit temporaire lui survivaient ;
- une revendication de finalisation ne périmait jamais, et les crédits retenus par un processus mort
  n'étaient jamais rendus : les deux sont désormais bornés dans le temps (voir plus haut) ;
- un rendu tué en vol restait `processing` indéfiniment : la porte d'exploitation de l'audit veut
  qu'aucun travail ne reste sans état terminal. La purge le marque en échec, sans prétendre le
  reprendre ;
- `processedKeys` grandissait d'une entrée par rendu, sans fin, dans un document plafonné à 16 Mo.
  C'est maintenant un cache borné : la réponse durable est `credit_transactions` et son index unique,
  ce qui rend l'élagage sans risque de double débit ;
- les documents produit expirés n'étaient supprimés par rien — seules les images l'étaient. La purge en
  fait maintenant une passe, sans index TTL : celui-ci retirerait aussi la ligne qu'un marchand a le
  droit de restaurer avant la fin de sa rétention.

## Vérification

- `npm test` : 246 tests réussis (37 géométrie, 17 routeur IA, 6 schémas, 186 application), contre 181
  avant le lot.
- `npm run typecheck` : réussi sur les workspaces.
- `npm run lint` : réussi.
- `npm run test:e2e` : 20 parcours réussis, 10 desktop et 10 mobile, avec MongoDB local et
  fournisseurs simulés — dont le nouveau cas d'isolation inter-session.
- `npm run build` : compilation de production réussie.

Nouveaux tests : `asset-access.test.ts` (13 cas : héritage fermant, isolation inter-session, identité
synthétique, session widget à UUID nu, expiration), `credits.test.ts` (12 cas dont dix réservations
concurrentes pour un seul crédit, idempotence des trois opérations, portefeuille hérité),
`provider-usage.test.ts` (9 cas dont le coût inconnu et le budget contrôlé avant l'appel),
`product-retention.test.ts` (5 cas : expiration posée à l'archivage et **levée à la restauration**),
`provider-cost.test.ts` (5 cas : ce qu'un appel raté a pu coûter, branche par branche),
plus le cas E2E inter-session et, dans le test d'intégrité, les assertions de portée sur les images de
rendu et de présence du contrôle qualité au journal.

Aucun résultat de génération réelle, aucune mesure de qualité photographique et aucun comportement en
production ne sont revendiqués. La réservation de crédits n'a été éprouvée que contre un magasin en
mémoire aux sémantiques MongoDB reproduites, pas contre un serveur réel sous charge.

## Suite prioritaire

1. **Exécution durable** : reprendre un rendu interrompu au lieu de seulement le rendre arrêtable —
   étapes persistées, bail et échéance. A12 reste entier.
2. **Plafonner les entrées payantes hors rendu** : `prepare` et `scale` doivent réserver ou plafonner
   en dollars, pas seulement en nombre de requêtes.
3. **PRO-007** : premiers cas photographiques autorisés, mesures et références — rien de ce qui
   précède ne mesure le réalisme.
4. **PRO-008 et phases 2–4** : détourage fidèle depuis l'original, calibration des plans, occultations
   et intégration lumineuse.
