# PRO-007 — corpus de référence, première étape

Date : 7 septembre 2026. Implémentation locale. Aucun rendu réel mesuré à ce
jour : le corpus est vide.

Ce document couvre la phase 0 du [plan audité](audit-plan-professionnalisation-2026-09-05.md),
« Référence ». Il fait suite au [lot 2](professionnalisation-lot-2.md), qui a
traité l'intégrité et la dépense mais n'a rien dit de la qualité des images.

## Ce que le ticket demandait, et ce qui est livré

Le ticket demande « 20 cas initiaux, taxonomie d'échecs, captures des étapes,
baseline des versions et métriques ». Sur ces quatre éléments, trois sont
livrés. **Les 20 cas ne le sont pas et ne pouvaient pas l'être** : un cas exige
de vraies photos de pièce et de produit, des dimensions physiquement mesurées et
une autorisation d'usage. Rien de tout cela ne se fabrique en écrivant du code.

Ce qui est livré est le harnais, la fiche à remplir et la taxonomie. Le corpus
reste à constituer, et tant qu'il l'est, **aucun chiffre de ce système ne dit si
les rendus sont bons**.

## Ce qu'il a fallu corriger avant

La reconnaissance a montré que le pipeline n'était pas mesurable. Trois
obstacles, corrigés ici :

### Deux étapes sur six survivaient à un rendu

Le ticket veut que « chaque échec se localise entre source, détourage,
placement, nettoyage, harmonisation et export ». Or seuls le composite
déterministe et l'image livrée étaient conservés. La scène nettoyée après
suppression d'un obstacle, l'entrée exacte remise au modèle, son masque et sa
réponse brute avant recollage étaient des variables locales, écrasées.

Sans elles, on ne peut pas distinguer une mauvaise génération d'une mauvaise
recomposition — c'est-à-dire qu'on ne peut pas savoir quoi corriger.

`render-capture.ts` conserve ces quatre étapes, **éteint par défaut**. Il
multiplie les copies stockées des photos du client ; l'activer
(`RENDER_STAGE_CAPTURE=true`) est un acte délibéré, pour un run de corpus ou une
enquête support, jamais un défaut de production. Les captures héritent de la
rétention de la scène comme toute image de rendu, donc un run doit copier sur
disque ce qu'il veut garder.

L'**image rejetée** est conservée sous le même drapeau. L'audit demande de
garder les rejets — « un système qui refuse presque tout n'est pas
professionnel » — mais `requireAcceptedQuality` lève avant tout stockage, donc
personne ne pouvait regarder ce qui avait été refusé.

### Aucune version pour les modules qui décident le résultat

Cinq constantes de version existaient, aucune pour la géométrie de placement, le
compositing ni le détourage — les trois modules qui décident où va l'objet, à
quelle taille, et ce qui est considéré comme étant l'objet. Comparer deux runs à
travers un changement silencieux de ces règles, c'est comparer deux moteurs
différents en croyant mesurer un progrès.

`SIMPLE_PLACEMENT_VERSION`, `SIMPLE_COMPOSITE_VERSION` et `CUTOUT_VERSION`
comblent le trou.

### La baseline se lisait dans la configuration

Chaque rendu porte maintenant `engineVersions` : les versions, le modèle
d'édition et de vision **résolus à l'exécution**, la qualité d'image, et
`mockMode`. Ce dernier point n'est pas cosmétique : `aiMockMode` est dérivé et
échoue vers le mode simulé, donc une clé absente rend un run synthétique en
silence. Un corpus qui lirait un tel run comme une mesure se mentirait.

Le runner relit d'ailleurs le mode **depuis le serveur**, jamais depuis son
propre environnement, et l'inscrit en premier champ du rapport.

## Le harnais

`apps/web/scripts/corpus-run.mjs`, invoqué par `npm run corpus:run`. Il pilote
l'application en HTTP — même choix que `production-smoke.mjs`, qui évite les
imports `server-only` et exerce le vrai chemin, authentification comprise.

Par cas : session invitée, création du produit, envoi de la photo, détourage,
ancrage, envoi de la pièce, rendu, puis **téléchargement immédiat sur disque** de
toutes les images conservées. Immédiat parce que tout hérite de la rétention de
la scène, 24 h par défaut.

Un cas dont la provenance n'est pas renseignée est **refusé avant exécution**,
pas exécuté puis signalé : « sources autorisées » est la première exigence du
ticket, et un cas sans autorisation ne devrait jamais atteindre un fournisseur.

### Le budget

Le plafond par rendu du lot 2 ne borne pas un corpus : vingt cas chacun sous leur
plafond dépensent vingt fois celui-ci. Le runner porte donc son propre plafond
pour tout le run, petit par défaut (1 USD), et s'arrête entre deux cas dès qu'il
est atteint plutôt qu'au milieu d'un rendu.

Ce plafond s'appuie sur `usageTotals`, qui est une estimation par constantes
locales et non une facture. Il borne un run emballé ; il ne clôt pas les
comptes.

### Les signaux extraits

Aucun ne juge si l'image est bonne. Chacun situe un échec :

| Étape | Signal | Source |
|---|---|---|
| Source | détourage synthétique, avertissements | `audit.cutoutSources`, `cutoutWarnings` |
| Échelle | source retenue, repli déclenché | `audit.scaleSources`, `scaleFallbackFired` |
| Placement | ancrage tenu, recadrage, chevauchement | `placement.compositePlacements` |
| Nettoyage | obstacles supprimés, ignorés | `audit.obstaclesRemoved/Skipped` |
| Livraison | décision qualité, crédit débité | `qualityDecision`, `creditCharged` |
| Déformation | cohérence dimensions/silhouette, bridage, écart de hauteur | `placement.compositePlacements` |

`cutoutSynthetic` mérite d'être lu en premier : un détourage produit par le
modèle n'est pas la photo du client, et toute conclusion d'identité tirée d'un
tel cas est sans valeur — c'est le constat A03 de l'audit.

La **déformation** est le seul signal qui mesure vraiment quelque chose sans
intervention humaine, et il existait depuis toujours sans que rien ne l'expose.
`dimensionConsistency` vaut (longueur/hauteur) ÷ l'aspect de la silhouette
photographiée : 1 signifie que les dimensions saisies correspondent à la photo,
et s'en éloigner signifie qu'on étire l'objet pour satisfaire des nombres que sa
photo contredit. C'est exactement le constat A04, où l'audit avait reproduit
2,222 sur un tapis. `clamped` et `sizeFactor` disent quand la géométrie a refusé
d'honorer la taille demandée, `heightErrorPct` compare la hauteur rendue à celle
saisie.

L'écart d'ancrage est en revanche une **garde de régression, pas une découverte**. Le
composite ancre à `round(x·W), round(y·H)` par construction, donc l'écart est
attendu sous le pixel ; s'il ne l'est pas, le contrat de placement a cassé. Il ne
dit rien du point de contact physique, que seul un œil humain juge. Le présenter
comme une mesure de placement serait exactement le genre de faux indicateur que
l'audit reproche.

## Classer les échecs

Le harnais écrit une fiche `verdict.md` par cas, pré-remplie de ce que la
machine a vu et vide là où seul un humain répond. La taxonomie y figure en
entier, à cocher : elle n'est donc pas une prose de README qu'on oublie de
consulter au moment de juger. Sur un run simulé, la fiche refuse d'être remplie
plutôt que d'inviter à un jugement sans objet.

```bash
npm run corpus:aggregate corpus/runs/<horodatage>
```

L'agrégation compte ce qu'un humain a réellement décidé, et applique trois
règles que l'audit impose :

- une strate **expérimentale** n'entre jamais dans le taux du périmètre
  supporté — ses échecs ne doivent pas disparaître dans une moyenne ;
- une fiche non remplie est **non jugée**, ni réussite ni échec, et sort de
  tous les taux : la compter d'un côté ou de l'autre serait aussi faux ;
- l'effectif accompagne toujours le taux, et sous 20 cas l'agrégat le dit
  lui-même — un taux sur trois cas n'est pas un taux.

Le classement final range les échecs par fréquence **et par étape**. C'est
l'unique sortie qui répond à la question utile : où porter l'effort suivant.

## Ce que la revue adversariale a corrigé

Cinq défauts d'hygiène de capture, tous vérifiés en lisant le code avant
correction :

- le ré-encodage `sharp` d'une étape s'exécutait **même capture éteinte**, et
  hors du bloc qui garantit qu'une capture ne fait jamais échouer un rendu.
  `captureStage` prend maintenant un producteur, évalué seulement si la capture
  est active, et à l'intérieur de la garde ;
- une capture arrivant **après une annulation ou une suppression** s'attachait à
  un rendu que personne ne pouvait plus atteindre. L'écriture est conditionnelle
  à `status: "processing"`, et l'image déjà stockée est retirée sinon ;
- la suppression d'un rendu ne détruisait que l'image livrée : le composite et
  les étapes capturées — les photos intermédiaires du client — restaient
  lisibles jusqu'à l'expiration de la scène, après qu'il a demandé que le rendu
  disparaisse. Tout ce que le rendu a produit part avec lui ;
- avec plusieurs objets à remplacer, `scene_cleaned` était capturé **à chaque
  suppression**, chacune écrasant la précédente et orphelinant son image. Une
  seule capture, après la dernière suppression ;
- `scene_marked` était déclaré dans le type et jamais capturé. Retiré du type
  jusqu'à ce qu'il le soit — un type qui promet plus que le code ment.

Et quatre dans le harnais lui-même, dont un qui me concerne directement :

- **mon signal de déformation produisait un chiffre confiant et faux pour les
  objets à plat.** La géométrie divise la hauteur d'un objet à plat par
  `FLAT_FORESHORTENING = 0,45`, donc `dimensionConsistency` vaut 2,22 quand les
  dimensions saisies correspondent **parfaitement** à la photo. Ma légende disait
  « 1 = correspondance » et mon test présentait 2,222 comme la déformation du
  tapis de l'audit — c'était l'approximation de perspective voulue. Le signal est
  maintenant normalisé par type de pose ; 1 signifie « correspondance » pour
  tous ;
- `pollRender` abandonnait à la première erreur GET et classait le cas avec
  l'objet d'avant le sondage : statut `processing`, coût 0 — pendant que le rendu
  dépensait. Il réessaie, et au-delà de cinq échecs marque l'issue `unknown`
  plutôt que d'en inventer une ;
- la fiche de verdict imprimait « non » avec assurance pour des signaux jamais
  enregistrés — un rendu échoué n'a ni placement ni audit. Un signal absent
  s'imprime « — », et le contrat d'ancrage vaut `null` quand il n'y a rien à
  vérifier, plutôt que « tenu » ;
- le classement « où porter l'effort suivant » mélangeait les échecs des strates
  expérimentales aux autres, alors que l'audit interdit précisément qu'une
  catégorie hors périmètre pilote la feuille de route. Le classement ne compte
  que le périmètre supporté ; l'expérimental est listé à part.

## Ce que ce lot ne fait pas

- **Le corpus n'existe pas.** Zéro cas. Le harnais l'annonce à chaque run, et
  l'agrégat refuse alors de calculer quoi que ce soit.
- L'échelle mesurée n'est confrontée à aucune référence physique
  automatiquement. `groundTruth` est enregistré, rien ne l'exploite : le faire
  demande d'annoter le résultat, ce qui est un travail humain.
- Aucune comparaison aveugle n'est outillée, ni le jeu réservé de 30 scènes que
  l'audit exige de tenir à l'écart du réglage des seuils.
- La capture d'étapes couvre le parcours `simple_point` et la scène nettoyée du
  parcours Google. Le reste du parcours standard garde ses angles morts : son
  entrée de modèle et sa sortie brute ne sont pas conservées.
- La scène marquée envoyée à l'estimation d'échelle n'est pas capturée : elle est
  construite dans une boucle par objet, et la conserver demanderait de choisir
  laquelle, ce qui n'a pas de réponse évidente à plusieurs objets.
- Rien ici ne mesure l'identité produit pixel à pixel. L'audit la veut ; elle
  demande une annotation des parties fines que personne n'a encore produite.

## Suite

1. Constituer les 20 premiers cas, en commençant par la strate `opaque_simple`,
   avec dimensions mesurées et autorisation écrite.
2. Passer un premier run réel sous budget explicite, classer chaque échec avec
   la taxonomie, et publier l'effectif — pas seulement un taux.
3. À partir de ces échecs seulement, décider où porter l'effort : détourage
   fidèle (PRO-008), calibration des plans, occultations, intégration lumineuse.

Fixer les seuils avant d'avoir mesuré les inverserait : l'audit demande de les
ratifier après la première mesure, pas de mesurer pour les confirmer.
