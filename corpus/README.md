# Corpus de référence — PRO-007

Ce dossier contient les cas qui servent à savoir si les rendus sont bons. Le
code n'en fabrique aucun : un cas exige de vraies photos, de vraies mesures et
une autorisation d'usage. Tant qu'il est vide, **le harnais ne mesure rien**, et
il le dit dans chaque rapport plutôt que de produire un chiffre rassurant.

## Ce qu'un run prouve et ne prouve pas

| Le harnais établit | Seul un humain établit |
|---|---|
| Où un échec s'est produit : source, échelle, placement, nettoyage, harmonisation, export | Si l'image est utilisable |
| Quelle version du moteur a produit l'image | Si l'objet est à la bonne taille dans la pièce |
| Ce que l'appel a coûté | Si la perspective et la lumière sont crédibles |
| Si le contrat de placement a tenu | Si le produit est resté lui-même |

Un run en **mode simulé** ne mesure aucune qualité photographique : les images
sont synthétiques. Le rapport le déclare en premier champ. Ne classez jamais un
tel run comme une mesure.

## Ajouter un cas

1. Déposez les photos dans `corpus/cases/` : la pièce et le produit.
2. Créez `corpus/cases/<id>.json` sur le modèle de `_exemple.json`.
3. Renseignez `provenance.authorisation` — qui a autorisé ces photos, et à quel
   titre. Un cas sans cette information est **refusé** avant exécution, pas
   exécuté puis signalé.
4. Mesurez le produit pour de vrai. Les dimensions déclarées sont ce à quoi le
   rendu sera comparé ; les inventer ne rend pas le cas inutile, il le rend
   trompeur.

Les photos ne sont pas versionnées par défaut (voir `.gitignore` de ce
dossier) : ce sont des photos de vrais intérieurs. Versionnez-les seulement si
leur autorisation le permet explicitement.

## Strates

L'audit demande de répartir les cas, et de **rapporter les catégories
expérimentales séparément** : leurs échecs ne doivent pas disparaître dans une
moyenne. Le champ `stratum` prend une de ces valeurs :

- `opaque_simple` — objet opaque, fond net, angle compatible ;
- `fine_detail` — anses, pieds, ajours, détails de quelques pixels ;
- `flat_surface` — tapis, tableaux : le plan doit être calibré ;
- `low_light` — faible lumière ou fond complexe ;
- `foreground` — un élément de la pièce passe devant l'objet ;
- `replacement` — un objet existant doit être retiré ;
- `experimental` — transparence, miroir, matière très réfléchissante. Hors
  périmètre annoncé ; à rapporter à part.

## Lancer

```bash
node apps/web/scripts/corpus-run.mjs http://127.0.0.1:3000 --budget-usd 1
```

Le budget est une **limite d'admission vérifiée entre les cas**. Un cas en cours
peut dépasser le reliquat ; les coûts sont estimés et non rapprochés des factures.
Le plafond par rendu ne borne pas à lui seul toute une campagne.

Pour conserver les images intermédiaires — indispensable pour situer un échec
entre nettoyage, harmonisation et export — l'instance doit tourner avec
`RENDER_STAGE_CAPTURE=true`. Sans cela le run fonctionne et le rapport indique
quelles étapes manquent.

Chaque run écrit dans `corpus/runs/<horodatage>/` : un dossier par cas avec les
images conservées, la réponse de rendu complète et les signaux extraits, plus un
`report.json` global.

## Taxonomie d'échecs

Elle sert à ranger un échec **à l'étape où il s'est produit**, pas à le décrire.
C'est ce qui permet de savoir quoi corriger.

| Étape | Code | Ce qui a échoué |
|---|---|---|
| Source | `source_cutout_synthetic` | Le détourage vient du modèle, pas de la photo : la référence d'identité est inventée |
| Source | `source_cutout_amputated` | Le détourage a perdu une partie de l'objet |
| Source | `source_photo_unusable` | La photo produit ne permettait pas de travailler |
| Échelle | `scale_fallback` | Aucune échelle estimée : repli sur une largeur de pièce supposée |
| Échelle | `scale_wrong` | Échelle estimée mais fausse face à la mesure |
| Placement | `placement_contract_broken` | Le composite n'a pas respecté l'ancrage demandé |
| Placement | `placement_deformed` | Proportions incohérentes avec les dimensions déclarées |
| Placement | `placement_cropped` | L'objet sort du cadre sans que ce soit voulu |
| Nettoyage | `cleanup_incomplete` | L'objet remplacé est encore visible |
| Nettoyage | `cleanup_damaged` | Le nettoyage a abîmé le décor autour |
| Harmonisation | `harmony_identity_lost` | Le modèle a modifié le produit |
| Harmonisation | `harmony_decor_changed` | Le décor a bougé hors de la zone autorisée |
| Harmonisation | `harmony_contact` | L'objet flotte ou s'enfonce |
| Harmonisation | `harmony_light` | Lumière ou ombres incohérentes |
| Occultation | `occlusion_order` | Un élément du premier plan est passé derrière |
| Export | `export_artifact` | Défaut apparu à la recomposition ou à la compression |
| Livraison | `quality_false_reject` | Rendu correct refusé par le contrôle |
| Livraison | `quality_false_accept` | Rendu défectueux accepté |

Le run écrit un `verdict.md` par cas, avec cette liste à cocher et la phrase à
justifier. Un cas peut porter plusieurs codes ; c'est même le cas intéressant,
parce qu'il montre une cascade.

Une fois les fiches remplies :

```bash
npm run corpus:aggregate corpus/runs/<horodatage>
```

Les strates expérimentales sont comptées à part, une fiche non remplie n'est
comptée nulle part, et l'effectif accompagne toujours le taux.

## Ce qui manque encore

- L'échelle mesurée n'est pas comparée automatiquement à une référence
  physique : `groundTruth` est enregistré mais rien ne le confronte au rendu.
  Le faire demande d'annoter le résultat, ce qui est un travail humain.
- La comparaison aveugle est outillée ci-dessous ; les campagnes et évaluations
  photographiques réelles restent à réaliser.
- Le jeu réservé de 30 scènes que l'audit exige — jamais utilisé pour régler les
  seuils — reste à constituer et à tenir à l'écart.

## Pilote, réglage et jeu réservé

Chaque manifeste indique `split: "pilot"`, `"tuning"` ou `"holdout"`.
Un manifeste ancien sans split est considéré comme pilote. Le runner n'exécute
que le pilote par défaut. Le jeu réservé exige deux options explicites :

```text
npm run corpus:validate
npm run corpus:run https://preproduction.example --split pilot --budget-usd 100
npm run corpus:run https://preproduction.example --split holdout --final-validation --budget-usd 100
```

Ces commandes de campagne appellent les fournisseurs réels si la préproduction
est configurée ainsi. Le montant est un plafond de sécurité configurable, pas
un objectif de réduction des coûts. Il reste fondé sur les coûts estimés ; un
appel peut dépasser le reliquat avant que le runner observe sa dépense.

Viser vingt cas pilotes, puis 120 cas uniques au total dont trente réservés.
Le pilote doit couvrir : blanc sur blanc, fonds complexes, pieds/anses/fils,
plantes, verre et miroir (strates séparées), reflets, murs, tapis obliques,
rebords/occultants, scènes multi-objets, remplacement confirmé et portrait EXIF.
Ne pas inventer de dimensions pour remplir le jeu. Le parcours simple bloque
les emplacements occupés ; les cas de remplacement confirmé nécessitent encore
l'adaptation du runner au parcours standard et sa zone de suppression.

## Comparaison aveugle

```text
npm run corpus:compare prepare corpus/runs/reference corpus/runs/candidate corpus/runs/comparaison
npm run corpus:compare score corpus/runs/comparaison
npm run corpus:compare score corpus/runs/comparaison arbitrage.json
```

Les campagnes doivent avoir le même split, la même population et des empreintes
identiques des manifestes/photos. Des résultats simulés ne peuvent pas devenir
une comparaison réelle. Les images sont renommées A/B aléatoirement par paire ;
seul le responsable reçoit `answer-key.json`. Transmettre uniquement le dossier
`blind/` aux deux évaluateurs, séparément. Il contient les photos de référence
disponibles et deux fiches JSON à remplir. Les identités des évaluateurs sont
requises et doivent être distinctes.

Un désaccord sur utilité, identité, occlusion ou réalisme reste non résolu sans
troisième arbitre. Sa fiche utilise le même format (`evaluator`, `items`, avec
`pair` et `arm`). Aucune moyenne de réalisme ne compense un défaut critique.
Les images non livrées restent dans le dénominateur des entrées utiles ; les
résultats inconnus empêchent de déclarer l'évaluation complète. Les matières
expérimentales restent séparées. Ce rapport ne valide pas à lui seul le
déploiement : métrique physique, charge et expérience réelle restent à qualifier.
