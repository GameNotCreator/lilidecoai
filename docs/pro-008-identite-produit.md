# PRO-008 — l'objet livré est celui du client

Date : 7 septembre 2026. Implémentation locale, sans appel IA payant de
validation.

Ce lot traite le constat **A03** de l'[audit](audit-plan-professionnalisation-2026-09-05.md),
le dernier P0 non traité. Il suit le [lot 2](professionnalisation-lot-2.md)
(intégrité, dépense) et [PRO-007](pro-007-corpus.md), dont le harnais a rendu ce
défaut visible : un cas dont le détourage vient du modèle ne prouve rien sur
l'identité.

## Le défaut

Quand le détourage local échouait, `gpt-image-2` **re-générait le produit** sur
fond transparent et cette image devenait le détourage. La seule vérification
était `transparencyRatio < 0.08` — « est-ce assez transparent », jamais « est-ce
encore le même objet ».

Ce n'est pas un aperçu dégradé. Le détourage est :

- **les pixels livrés** — `pasteBackOutsideMask` les re-stampe **par-dessus** la
  sortie du modèle, en dernière opération avant encodage. Le mécanisme censé
  garantir l'identité réimposait donc l'objet inventé ;
- **la géométrie** — son rapport d'aspect fixe la largeur rendue, son
  `baseRowFraction` l'ancrage vertical, son alpha le masque éditable.

Un client pouvait ainsi payer pour voir, à la bonne taille et au bon endroit, un
objet que personne n'avait jamais fabriqué.

## La règle

**Chaque pixel d'un détourage stocké vient de la photo du client.**

## Pourquoi le masque du modèle n'était pas récupérable

L'idée naturelle — garder l'appel mais n'utiliser que son alpha sur les pixels
originaux — ne tient pas ici, et pas seulement par prudence :

- `selectOutputSize` quantifie la demande sur **trois** formats (1,5 / 1,0 /
  0,667) ; seules les entrées exactement en 3:2, 2:3 ou 1:1 reviennent au bon
  rapport ;
- la sortie fait 1024 ou 1536 px quand la source en fait jusqu'à 2048 : elle
  revient systématiquement à 0,5–0,75× ;
- **aucun masque n'est envoyé** — c'est le seul appel `/images/edits` du dépôt
  sans masque, donc rien ne contraint où le modèle place le produit.

Les deux grilles ne sont pas reliées. Appliquer cet alpha sur l'original
remplacerait un échec d'identité silencieux par un autre. L'appel est supprimé.

## Ce qui le remplace

Un verdict, calculé sur la photo originale et enregistré à chaque préparation.

**Deux issues sont refusées**, et aucune n'est un choix de politique :

- `background_not_removable` — rien n'a été retiré, donc composer reviendrait à
  coller le fond de la photo dans la pièce ;
- `product_not_separable` — rien n'a survécu, donc il n'y a plus de produit à
  coller.

**Tout le reste est enregistré sans être refusé** : bord flou, ombre de contact
conservée, poche de fond piégée dans la silhouette. Leur fréquence réelle sur des
photos de clients n'a **jamais été mesurée**, et refuser sur une estimation
écarterait des gens dont la photo fonctionne. Le corpus de PRO-007 est
l'instrument qui la mesurera ; l'application pourra suivre la mesure, pas la
précéder.

## La porte de confiance est une liste blanche

`cutoutTrust` n'accepte qu'un détourage dont la source est `heuristic` ou
`matting` **et** qui porte une version. Écrite en liste noire sur `synthetic`,
elle aurait lu « aucune métadonnée du tout » — c'est-à-dire tout produit préparé
avant l'existence de ce champ — comme digne de confiance, soit l'exact contraire
de la vérité.

Le rendu refuse un détourage non digne de confiance avec un message qui dit quoi
faire, plutôt que de produire une image et de la facturer.

## Trois dérives fermées hors du chemin principal

La revue les a trouvées en dehors de `/prepare`, et chacune laissait un
détourage désynchronisé de sa photo :

- **remplacer la photo de face** depuis le back-office posait le nouveau
  `assetId` sans jamais retirer l'ancien détourage : le produit décrivait une
  photo et en rendait une autre ;
- **supprimer la vue de face** retirait `assetId` et `cutoutAssetId` mais gardait
  `cutout` — des mesures décrivant une image disparue ;
- **dupliquer un produit** recopiait `cutout` sans les images, donc dimensionnait
  et ancrait la copie depuis une photo qu'elle n'a jamais portée.

## Deux conséquences assumées

`loadProductReferences` ne rend plus le détourage en référence de repli. Une
référence dit au modèle à quoi ressemble le produit ; le détourage est une image
**dérivée**, et la rendre autorité laisserait les erreurs de la découpe — bord
mangé, ombre gardée — devenir la vérité que le modèle reproduit. Le repli est
désormais la **photo originale**.

L'instruction de prompt « l'image N fait autorité pour ses couleurs » disparaît
avec le détourage synthétique pour lequel elle existait : il n'y a plus deux
apparences à arbitrer.

## Migration

```powershell
npm.cmd run migrate:cutout-provenance
npm.cmd run migrate:cutout-provenance -- --apply
```

Volontairement **destructive uniquement** : elle retire le détourage, efface
les métadonnées et repasse le produit en `processing`. Le retrait pose une
expiration immédiate sur l'image plutôt que de supprimer sa ligne : le script ne
peut pas atteindre l'adaptateur de stockage, et supprimer la ligne seule aurait
orpheliné l'objet Cloudinary derrière — un constat de la revue. Le cron de purge,
seul chemin de suppression testé, détruit objet et ligne ensemble. Elle ne re-prépare pas.
Le faire ici écrirait des mesures décrivant une image fraîchement calculée alors
que l'asset stocké serait encore l'ancien — un produit dont la géométrie et les
pixels viennent de deux images différentes, défaut pire que celui corrigé.

Les produits sans métadonnées ne sont **pas touchés** : leur provenance est
inconnue, pas connue-mauvaise. Le rendu les refuse déjà en invitant à
re-préparer.

## Une régression trouvée en vérifiant, avant la revue

La porte en liste blanche a eu une conséquence que je n'avais pas vue : le
**seed n'écrivait aucune métadonnée `cutout`**, seulement `cutoutAssetId`. Sur
une base fraîche, chaque produit du catalogue de démonstration aurait donc été
refusé au rendu avec « provenance inconnue » — le `/demo` public cassé.

L'E2E ne l'a pas détecté parce qu'**aucun test ne rendait un produit seedé** :
tous créent un produit frais via `/prepare`, qui écrit la provenance. Le trou de
couverture était exactement là où vivait la régression.

Correction : le seed matte désormais ses détourages par `prepareCutout`, comme
un client, et garde les métadonnées ; c'est le buffer du matte qui est stocké,
pour que géométrie et pixels viennent d'un même calcul. Une photo distante que
le matte ne sait pas séparer retombe sur le dessin de repli, plutôt que de
seeder un rectangle opaque en produit de catalogue. Pour les bases déjà seedées,
`repairCatalogCutouts` re-matte une fois, sous le même identifiant d'asset. Un
test E2E rend maintenant le vase seedé et vérifie que `engineVersions.mockMode`
dit la vérité.

## Ce que la revue adversariale a trouvé

Neuf chercheurs, puis trois réfutateurs par constat, sur PRO-007 et PRO-008
ensemble. Un constat grave sur ce lot, corrigé :

- **La porte de confiance ne couvrait que `simple_point`.** Je l'avais posée là
  où ce parcours sélectionne ses objets ; le parcours standard, qui composite
  directement le détourage du produit, passait à côté. Un détourage synthétique
  y restait la référence d'identité — le trou même que le lot prétendait fermer.
  La porte est désormais à l'**admission**, avant que le parcours ne se
  choisisse : une seule garde couvre les deux.

Deux autres chemins que j'avais laissés ouverts, corrigés :

- le `prepare` du **back-office** appelait `createCutout`, qui jette les
  métadonnées, puis marquait le produit `ready` sans `cutout` — il fabriquait
  des produits que la porte refuse au rendu. Il matte, juge et enregistre la
  provenance exactement comme `/prepare` ;
- le remplacement de photo de face **public** gardait l'ancien détourage. J'avais
  fermé ce trou côté admin sans le miroiter. C'est fait, et un test refuse
  désormais au rendu un détourage synthétique ou sans provenance — la porte ne
  peut plus être supprimée avec des tests verts.

La revue a aussi relevé le catalogue seedé sans provenance, que ma propre
vérification avait trouvé et corrigé quelques minutes plus tôt.

## Vérification

- `npm test` : 284 tests réussis, dont 10 nouveaux sur la règle d'identité.
- `npm run test:e2e` : 21 parcours, dont le nouveau rendu d'un produit seedé sur
  une base qui ne portait pas encore la provenance.
- `npm run lint`, `npm run typecheck` : verts.

## Ce que ce lot ne fait pas

- Il garantit un détourage **authentique**, pas **correct**. Chaque alpha vient
  de la photo, mais un bord flou, un coin mangé ou une ombre de contact
  conservée passent encore, avec avertissement. **PRO-008 ne règle pas la
  qualité de silhouette** et ne doit pas être rapporté comme tel.
- Le taux de refus réel est **inconnu**. Les deux causes refusées sont
  incontestables, mais leur fréquence sur des photos de clients n'a jamais été
  mesurée. Un corpus la donnera.
- Les drapeaux de qualité sont partiellement incohérents entre eux : `vanished`
  mesure sur une boîte englobante là où `raggedRatio` mesure sur une silhouette.
  Cela n'affecte pas les deux refus livrés, qui reposent sur des conditions
  franches, mais toute décision plus fine devra d'abord corriger la mesure.
- Les clients dont le fond est chargé perdent le rattrapage génératif et
  reçoivent un détourage imprécis avec avertissement, là où ils recevaient
  auparavant un bel objet — qui n'était pas le leur.
