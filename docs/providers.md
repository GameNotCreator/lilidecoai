# Fournisseurs d’image

## Politique active de la démo

Le parcours public `simple_point` reste entièrement côté serveur.

| Étape                                        | Fournisseur | Modèle par défaut                        |
| -------------------------------------------- | ----------- | ---------------------------------------- |
| Ajout depuis un point, zone libre ou occupée | OpenAI      | `gpt-image-2.5-sunburst` (qualité `max`) |
| Échelle, précontrôle et contrôle final       | OpenAI      | `gpt-6-astra`                            |
| Tests et développement sans clé              | Mock local  | `mock-image-v2`                          |

La démo choisit explicitement OpenAI, même si les anciens fournisseurs restent
derrière les interfaces communes pour les parcours marchands existants.

Les interfaces `ImageGenerationProvider`, `ImageEditingProvider`,
`SegmentationProvider` et `SceneAnalysisProvider` se trouvent dans
`packages/ai-router`. Chaque tentative retourne le même contrat : fournisseur,
modèle, identifiant distant, statut, durée, coût estimé, images, sécurité,
erreur normalisée et nombre de tentatives.

## Pipeline

La géométrie n’est jamais demandée au modèle. Position, taille, ordre de
profondeur et rognage sont calculés par `computeSimplePlacement`
(`packages/geometry/src/simple-placement.ts`), la même fonction pure côté
navigateur et côté serveur : l’aperçu que le client voit avant de payer est
celui que le serveur composite.

1. **Détourage** (`/v1/products/:id/prepare`). `prepareCutout` produit un
   masque local : suppression du fond joignable depuis le bord, nettoyage des
   composantes parasites, décontamination alpha, séparation de l’ombre de
   contact et mesure de la ligne de base. Il retourne aussi des drapeaux de
   qualité ; un échec dur (rectangle opaque, forme creuse, fond enfermé, bande
   d’ombre, fond chargé) doit être corrigé avant génération. Le produit
   conserve les pixels de sa photo source et `cutout` : dimensions, `baseRowFraction`,
   provenance, `synthetic` et avertissements affichés au client.
2. **Échelle et lumière** (`POST /v1/scenes/:id/scale`, gratuit pour le
   client). Un appel `/v1/responses` sur une copie de la photo où chaque point
   porte un anneau rouge numéroté. Le modèle rend, par point, la portée d’un
   segment de 10 cm vertical pour les objets debout/muraux, horizontal pour
   les objets plats, le repère utilisé et sa taille supposée, la
   nature et le matériau du support, plus la lumière dominante de la pièce. Le
   code recalcule et vérifie : un repère hors plage ou incohérent de plus de
   le span déclaré est rejeté, et l’échelle retombe en cascade
   (`vision` → `vision_coarse` → `vision_interpolated` →
   `assumed_room_width`). Le résultat est mis en cache dans
   `scene.analysis.simpleScale` : la vérification avant paiement et le rendu
   payant partagent un seul appel.
3. **Pré-vol.** `planSimplePlacements` refuse, avant toute génération d’image,
   un objet qui ne tient pas au point demandé ou deux objets qui se
   chevauchent sur la même surface. L’étape 2 la précède nécessairement (il
   faut l’échelle pour calculer les tailles) mais son résultat est en cache.
4. **Remplacement au point.** Chaque point est inspecté sur une copie marquée ;
   une boîte qui ne contient pas le point tapé, ou qui recouvre une boîte déjà
   traitée, est ignorée. La suppression passe par le même chemin de
   letterboxing que le rendu final, puis est recollée avec un fondu large.
5. **Composite déterministe.** Les objets sont collés dans l’ordre de
   profondeur, avec une ellipse d’ombre indicative bornée au masque. Le
   composite est stocké (`compositeUrl`) **avant** l’appel payant : un rendu en
   échec conserve un aperçu honnête.
6. **Précontrôle et harmonisation.** Une analyse visuelle compare la composition,
   la pièce et les originaux produit avant l’édition. `/v1/images/edits`
   utilise `OPENAI_MODEL`, le composite en image 1 et les produits ensuite,
   du plus proche au plus lointain. `buildSimpleHarmonizePrompt`
   (`simple-composite-v3.0.0`) demande contact, ombres, contours et ajustement
   lumineux discret en préservant strictement position, taille et identité.
7. **Recollage.** Hors du masque, chaque pixel provient du composite ; au cœur
   de chaque objet, le détourage catalogue est réutilisé avec un transfert de
   luminance borné à ±12 %. Le résultat est encodé sans perte.
8. **Contrôle final.** Pièce originale, composition attendue, rendu et tous les
   originaux sont comparés. Chaque objet doit passer les vérifications de
   position, taille, identité, contact, contours, ombres et occlusion.
   Une reprise ciblée est possible si le temps restant le permet ; deux
   éditions maximum. Aucun final n’est livré si le contrôle est indisponible.

## Boutique publique : produits isolés

Les nouvelles admissions `storefront-room-integration-v5`, avec le prompt
`storefront-room-integration-v9`, génèrent une photographie complète à partir de
la pièce originale, d’un masque local de volume/contact, du guide et des photos
catalogue. Le produit et son interaction avec le support sont générés ensemble.
Le site ne découpe ni ne redimensionne un sprite produit après la génération.
Les pixels hors de la zone autorisée sont restaurés depuis la pièce ; le raster
généré est aligné par une mise à l’échelle uniforme, jamais déformé. Les guides
utilisent séparément largeur projetée et hauteur verticale. Une image transparente
ou un aspect incohérent est refusé.

Le contrôle `storefront-room-integration-review-v5` ajoute une preuve obligatoire
`supportIntegration` à tous les critères précédents. Une belle texture, une base
au bon pixel et une vue native isolée ne prouvent pas l’attachement au sol, le
volume ou l’ordre des occlusions. Le contrôle doit refuser un effet de collage,
sans ajouter de vérifications esthétiques détaillées de lumière. L’échelle reste
estimée sans mesure connue. Le profil conserve trois appels au maximum : analyse
25 secondes, génération `high` 90 secondes, revue `low` 45 secondes ; le délai
global est de 180 secondes, file d’attente comprise, sans relance automatique.

Le profil historique `storefront-isolated-product-v4` utilise une analyse de scène unique
(échelle estimée, support et angle de caméra), une génération d’image et une
revue finale indépendante. Le délai total est de 180 secondes depuis la création,
file d’attente comprise. Il ne relance pas automatiquement une image refusée.

`STOREFRONT_IMAGE_MODEL` utilise `gpt-image-2.5-sunburst` par défaut, à qualité
`high` pour les admissions historiques `storefront-isolated-camera-detail-v8`,
pour produire une vraie transparence WebP sans masque. La génération reste
bornée à 90 secondes et ne reçoit aucune relance automatique. Les anciens
profils v4 à v6 conservent leur qualité `medium`. Les photos
catalogue restent les références d’identité, une par objet. Les nouvelles
admissions historiques v6 à v8 transmettent d’abord une
fenêtre agrandie du guide autour de tous les emplacements, puis la pièce,
puis ces photos catalogue. Le recadrage conserve la perspective et décrit
explicitement ses coordonnées dans la photo originale ; il ne change ni les
angles estimés ni les pixels du résultat final. Ce contrat est figé à l’admission.
Les anciens v5 gardent leur guide complet ; les profils antérieurs gardent leur
ordre catalogue en premier.
Un panier de trois objets utilise trois colonnes dans la même
génération. Les répétitions d’un produit conservent leur colonne.

Le site extrait les nouvelles silhouettes, les redimensionne uniformément et
ancre leur base visible au point choisi. Il conserve les pixels de la pièce
hors de leur alpha, y compris les espaces entre les poignées. La perspective
provient du nouvel objet généré ; le détourage catalogue n’est pas recollé dans
le résultat final. Fonds opaques, silhouettes coupées et débordements sont
refusés. L’échelle sans référence mesurée reste une estimation visuelle.
Les nouvelles admissions `storefront-scene-width-pose-v4` estiment séparément
la largeur projetée et la hauteur verticale dans ce même appel d’analyse.
La silhouette finale utilise la largeur ; le guide garde la hauteur. Cela
évite de confondre ces deux axes lorsque la caméra est inclinée. Une largeur
inconnue est refusée avant la génération. Les anciens profils restent inchangés.

Le contrôle final de l’identité, du placement, de l’échelle et de la cohérence
photographique reste obligatoire. Un candidat refusé est privé et ne devient
ni un résultat livré ni un crédit de visualisation débité. Le budget utilise
le modèle effectivement admis ; la production actuelle limite chaque rendu
à 2 USD d’estimation. Les anciens rendus gardent leur contrat et leur modèle admis.

Le contrôle historique `storefront-realistic-detail-v4` reçoit
également l’image des produits générés avant leur réduction, avec les identifiants
de colonnes exacts. Il inspecte ainsi les petits détails de perspective, tout en
gardant la photo finale comme autorité pour la position, l’échelle et l’occlusion.
Cette vue détaillée ne suffit jamais à accepter un rendu. Les seuils et le nombre
d’appels de contrôle restent identiques ; un détail manquant ou ambigu est refusé.

## Variables serveur

```text
OPENAI_API_KEY=
OPENAI_MODEL=gpt-image-2.5-sunburst
STOREFRONT_IMAGE_MODEL=gpt-image-2.5-sunburst
OPENAI_VISION_MODEL=gpt-6-astra
OPENAI_QUALITY=max
OPENAI_SERVICE_TIER=default
OPENAI_MAX_COST_USD=5
RENDER_MAX_COST_USD=20
OPENAI_IMAGE_ENABLED=true
AI_MOCK_MODE=true
```

En production, mettre `AI_MOCK_MODE=false`. Aucune de ces variables ne doit
être préfixée par `NEXT_PUBLIC_`. Les clés, prompts complets et corps d’erreur
distants ne sont ni envoyés au navigateur, ni stockés en base, ni journalisés.

## Mode mock

`AI_MOCK_MODE=true` force les fournisseurs locaux et empêche tout appel payant,
même si une clé existe. Les tests unitaires et E2E utilisent ce mode. Le mock
couvre l’édition et le parcours complet sans appel OpenAI.

## Documentation officielle vérifiée

- [Génération et édition d’images OpenAI](https://developers.openai.com/api/docs/guides/image-generation)
- [Modèle GPT Image 2.5 Sunburst](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst)
- [Audit, limites et architecture de montée en charge](audit-image-2026-09-20.md)
