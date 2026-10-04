# Placement manuel et intégration photographique — 4 octobre 2026

La boutique prépare désormais le placement avant de demander une intégration photographique à OpenAI. Le client choisit une boîte avec deux coins dans les deux sens, règle la taille et déplace le vrai détourage. La zone facultative de retrait d'un ancien objet est indépendante. La référence de hauteur a été retirée du parcours.

Pour les objets plats et muraux, quatre coins guidés définissent le plan. La boîte de placement est exprimée dans ce plan, puis projetée par homographie. Le navigateur et le serveur partagent la même géométrie et préservent les proportions du détourage. Il s'agit d'une taille visuelle, sans calibration métrique.

## Contrat de génération

Les nouvelles requêtes portent `simplePlacements[].manualPlacement` : une boîte normalisée et, pour les catégories plates et murales, un quadrilatère ordonné. Le serveur recalcule le type et les proportions à partir du catalogue et lit la photo dans la session du visiteur. Les versions des anciennes tâches sont conservées ; elles continuent d'utiliser leur contrat historique.

1. Lire la photographie privée et les détourages préparés. Refuser un détourage vide ou une image de catalogue opaque ; une surface rectangulaire plate n'est admise qu'avec sa préparation authentique et vérifiée.
2. Composer le produit à sa position et sa taille choisies. Aucun précontrôle d'échelle, de pose ou de dégagement n'interdit ce parcours manuel.
3. Si nécessaire, nettoyer uniquement la région explicitement sélectionnée, sans référence au nouveau produit. Restaurer le fond extérieur à cette région.
4. Composer les pixels détourés, avec la perspective du plan pour les tapis et objets muraux.
5. Transmettre la composition PNG en première image, son masque alpha de même taille, les références produit et la pièce. Une édition OpenAI ajuste lumière, perspective, contours, ombre et occultations. Le détourage d'origine n'est pas recollé après cette édition.
6. Contrôler l'identité, l'emprise visuelle choisie, le contact, les doublons, la conservation de la pièce, les occultations et le retrait demandé. La taille physique incertaine reste informative. Un refus n'est jamais présenté comme un résultat validé ni débité comme une réussite.

Le parcours utilise une édition d'image et une revue visuelle ; le remplacement ajoute une édition de nettoyage. MyArchitectAI ne participe pas aux nouveaux placements manuels. Les étapes payantes durables ne rejouent pas un appel dont l'issue est inconnue. La limite de trois minutes comprend la file d'attente ; les marges de chaque appel réservent du temps au contrôle final. Actualiser le suivi ou recharger la page conserve la tâche et sa clé d'idempotence.

## Vérification et niveaux de preuve

Les tests automatisés couvrent la géométrie et l'alpha, la normalisation publique, les droits privés, le montage et les masques envoyés, l'idempotence, les limites de temps, la facturation et le suivi. Les tests navigateur couvrent les deux sens de sélection, la taille, le déplacement, les plans, le retrait indépendant et la récupération après rechargement. L'émulation mobile ne constitue pas un essai sur téléphone physique.

Sur le code final : 2 664 tests web réussis, 64 exclus ; 91 tests de géométrie, contrat et routage réussis ; 51 cas navigateur réussis, 7 exclus intentionnellement. TypeScript passe dans les six modules et ESLint dans toute l'application web. La suite web finale a utilisé deux workers et une limite de 15 secondes par test, après dépassements de la limite initiale de 5 secondes sur des opérations raster historiques ; aucune assertion de qualité n'a été réduite.

Le script `apps/web/scripts/qualify-manual-composition.ts` effectue les essais fournisseurs dans une base et un stockage locaux isolés. Son mode par défaut ne fait aucun appel payant. Chaque exécution réelle exige un identifiant inédit et conserve les hashes du code, les images intermédiaires, les appels et leurs issues. Les preuves et résultats de la livraison sont conservés hors du worktree temporaire dans `artifacts/manual-composition-2026-10-04/release-evidence.md` du dossier principal.

Les premiers essais pleine pièce ont été refusés. Le premier panier avait grandi d'environ 13 %. Le resserrement du masque a conservé la taille, mais la comparaison des sorties brutes et restaurées a ensuite établi un autre mécanisme : le modèle conservait les anses et le motif du tapis, puis sa dérive d'emprise entraînait leur découpe lors de la restauration du fond. Le miroir présentait le même défaut. Ces refus restent conservés comme preuves ; les seuils de qualité n'ont pas été abaissés.

La correction finale cadre localement le montage, la pièce et le masque dans une fenêtre identique avec du contexte autour du produit. Les données de placement sont des fractions du canevas local avec ses bordures, communes aux résolutions d'entrée et de sortie. Pour les produits plats et muraux, le masque suit la silhouette alpha projetée avec une dilatation en disque de 20 % du plus petit côté, bornée entre 6 et 32 pixels. Le fondu de 5 pixels à son bord extérieur mélange uniquement la sortie générée et la pièce source. Le contrôle compare la boîte des pixels alpha réellement visibles ; les quatre coins du plan restent un contrat distinct. Les objets debout conservent leur emprise stricte et leur zone d'ombre au pied. L'édition reste unique, le résultat rejoint le cadre original et le contrôle qualité examine la pièce complète. Aucun détourage catalogue n'est recollé sur l'édition produite.

Les résultats réels restent partiellement qualifiés :

| Cas | Version exécutée | Durée totale | Résultat observé |
| --- | --- | ---: | --- |
| Panier debout | Prompt V4 | 49,793 s | Accepté, QA 0,93 ; produit complet, proportions et contact crédibles. |
| Remplacement du globe | Prompt V4 | 77,442 s | Accepté, QA 0,82 ; retrait effectif, console conservée, raccord légèrement adouci à la base. |
| Miroir mural abaissé | Prompt V6 final | 45,610 s | Refusé ; déplacement/agrandissement fournisseur et partie supérieure du cadre encore affectée par la restauration bornée. |
| Tapis sur photo Nexus 5 | Prompt V6 final | 52,890 s | Refusé ; dérive d'emprise et de perspective, panneaux supérieurs rognés dans la restitution complète. |

Les deux réussites ont été exécutées sur V4, avant les dernières modifications limitées aux masques et boîtes attendues des objets plans ; elles n'ont pas été rappelées sur V6. Seize essais uniques sont conservés au total : deux acceptations et quatorze refus, tous sous trois minutes. Ils représentent 34 appels OpenAI connus, 440 réponses de suivi conformes au schéma et environ 2,8227465 USD de consommation estimée, pas une facture fournisseur. Les portefeuilles sont des fixtures locales ; aucun crédit de production n'a été utilisé. Les refus ne débitent aucun crédit et ne deviennent pas des résultats validés.

Les aperçus en perspective du sol et du mur fonctionnent, mais les deux derniers rendus photographiques restent non qualifiés. Le modèle peut modifier le quadrilatère malgré le montage et les coordonnées ; le masque et le contrôle qualité limitent ce défaut sans garantir une édition conforme. Cette livraison ne prétend pas résoudre toutes les scènes ni le cas personnel absent.

## Références et limites

Paramètres vérifiés dans les [documentations officielles OpenAI sur les images](https://developers.openai.com/api/docs/guides/image-generation) et [l'outil de génération d'images](https://developers.openai.com/api/docs/guides/tools-image-generation). Le [portail MyArchitectAI](https://portal.myarchitectai.com/docs) a aussi été consulté ; aucune nouvelle option de ce service n'est utilisée.

La photographie de séjour des essais debout, remplacement, mur et d'un essai de sol est [Living Room, de Tim Collins](https://commons.wikimedia.org/wiki/File:Living_Room.jpg), œuvre propre de 2010, sous CC BY-SA 3.0. Le dernier essai de sol emploie [Empty apartment room with corner windows, d'aismallard](https://commons.wikimedia.org/wiki/File:Empty_apartment_room_with_corner_windows.jpg), prise au Nexus 5 le 8 août 2018, sous CC BY-SA 3.0 ; l'original est conservé avec son hash et la variante est réduite à 1 280 × 960 pixels. Les variantes d'essai insèrent ou retirent un produit et restent des adaptations de ces photographies ; une éventuelle republication doit conserver l'attribution et les conditions de partage. La fixture de parquet issue de Pinterest, utilisée dans les premiers essais de sol refusés, a une provenance photographique non certifiée : elle ne prouve pas une capture de caméra réelle.

La photographie personnelle à l'origine du mauvais essai n'a pas été fournie. Ces essais qualifient des cas concrets, sans garantir toutes les scènes, une dimension en centimètres ou le fonctionnement de la caméra sur téléphone physique. La sélection manuelle doit englober complètement l'ancien objet à retirer et repérer un plan visuellement cohérent.
