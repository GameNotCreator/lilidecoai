# Plan d’exécution — système d’image LiliDecoAI

Date : 20 septembre 2026. Mise à jour : 21 septembre 2026.
Statut : exécution engagée ; voir le [suivi d'implémentation](execution-systeme-image-2026-09-21.md).
Référence : [audit du 20 septembre](audit-image-2026-09-20.md).

## Objectif

Placer le bon produit au point demandé, avec une taille dont la précision est
connue, un détourage propre et une intégration crédible. Le traitement doit
survivre aux interruptions, supporter plusieurs clients simultanément et ne
livrer que des résultats vérifiés.

La qualité prime sur le coût. Conserver un plafond de tentatives et une échéance
pour éviter les traitements sans fin ; mesurer les dépenses sans chercher à
les réduire pendant cette phase.

## Point de départ

Les corrections locales de l’audit sont une base à conserver : orientation
EXIF, échelle plus prudente, protection des détails, recomposition sans perte,
modèles configurables, précontrôle visuel et contrôle de chaque objet.
375 tests applicatifs passaient lors de l’audit ; le contrôle TypeScript global
était bloqué par 18 erreurs dans des fichiers expérimentaux.

Ces résultats ne valident pas encore le photoréalisme. L’accès réel aux modèles,
le corpus photographique et le comportement du déploiement restent à vérifier.
Le traitement dépend encore d’une tâche web limitée à cinq minutes.

## Ordre des travaux

| Lot | Priorité | Résultat attendu | Dépendances |
| --- | --- | --- | --- |
| L0 — Stabiliser la version | P0 | Version reproductible, contrôles de livraison verts, accès fournisseurs vérifié | Aucune |
| L1 — Mesurer sur de vraies photos | P0 | Référence comparative et classement des défauts | L0 |
| L2 — Rendre l’exécution durable | P0 | File persistante, reprise, annulation et finalisation fiables | L0 ; parallèle à L1 |
| L3 — Fiabiliser le détourage | P1 | Masques précis conservant les pixels du produit | Premiers cas de L1 |
| L4 — Fiabiliser taille, perspective et occlusion | P1 | Placement cohérent avec le support et le premier plan | L1 ; parallèle à L3 |
| L5 — Améliorer l’intégration et la correction | P1 | Ombres et lumière naturelles, réparations ciblées | L2, L3, L4 |
| L6 — Guider l’utilisateur et calibrer le contrôle | P1 | Erreurs compréhensibles, peu de faux refus, aucun faux succès technique | L1 ; finalisation après L5 |
| L7 — Valider et déployer progressivement | P0 avant production | Qualité démontrée, charge testée, retour arrière prêt | L0 à L6 |

P0 désigne un prérequis de fiabilité ou de mise en production, P1 une capacité
nécessaire au niveau de qualité recherché. Les lots parallèles partagent des
contrats versionnés pour éviter que leurs calculs divergent.

## L0 — Stabiliser la version

- Identifier précisément les changements de l’audit parmi les travaux locaux
  déjà présents ; figer une version candidate sans embarquer les autres travaux.
- Résoudre les erreurs TypeScript expérimentales ou isoler explicitement les
  expériences hors des contrôles de livraison, en conservant leurs fichiers.
- Vérifier tests, compilation de production et parcours navigateur desktop/mobile.
- Configurer les accès serveur en préproduction. Vérifier les modèles réellement
  accessibles, puis réussir une édition avec masque et une analyse structurée.
- Enregistrer modèles, paramètres et versions effectifs. Garder la qualité
  maximale configurée ; ne pas substituer silencieusement un modèle inférieur.

**Validation :** compilation et contrôles de livraison verts ; un rendu réel
complet peut être produit et vérifié ; les résultats simulés sont identifiables.

## L1 — Construire la référence de qualité

- Préparer 20 cas pilotes avec sources autorisées, originaux produit/pièce,
  dimensions, position attendue et, lorsque possible, photo du vrai produit
  physiquement placé dans la pièce.
- Couvrir objets blancs, pieds/anses fins, plantes, verre, surfaces brillantes,
  murs, tapis obliques, rebords, plusieurs objets, remplacement et portrait EXIF.
- Séparer les mesures physiques des appréciations visuelles. Une scène sans
  référence métrique ne sert pas à mesurer une erreur en centimètres.
- Capturer les étapes : source, alpha, géométrie, nettoyage, composition,
  sortie brute, image recomposée, décisions et tentatives.
- Comparer la version de référence et la candidate sur les mêmes entrées,
  en aveugle, avec deux évaluateurs et arbitrage des désaccords.
- Répéter les cas sensibles pour mesurer la variabilité. Étendre ensuite à
  120 cas, dont 30 réservés à la validation finale et exclus du réglage.

**Validation :** chaque défaut est rattaché à une étape et à une catégorie ;
un tableau compare fidélité, placement, échelle, réalisme, refus, reprises et
latence. Les rejets restent dans le dénominateur de l’évaluation d’utilité.

## L2 — Sortir les rendus longs de la requête web

Conserver Next.js pour l’interface et l’API. Introduire une file persistante
et des processus de rendu séparés, exécutant les étapes avec des points de reprise.
Choisir le service de file et l’hébergement après vérification des contraintes
du déploiement ; préserver un contrat indépendant du prestataire.

- Persister une requête immuable : `renderId`, références d’images, placements,
  versions, étapes terminées et échéance. Ne pas mettre les images encodées dans la file.
- Réserver les travaux atomiquement avec bail, renouvellement et jeton
  d’exécution empêchant un ancien processus de finaliser après reprise.
- Persister les sorties de chaque étape pour reprendre sans recalcul inutile.
- Traiter séparément panne réseau, limitation fournisseur, refus permanent,
  résultat de génération incertain et indisponibilité du contrôle visuel.
- Quand seule la vérification est indisponible, conserver le candidat et
  réessayer la vérification ; ne pas régénérer systématiquement l’image.
- Borner les tentatives par étape et au total, avec délais progressifs et
  concurrence limitée globalement et par boutique.
- Finaliser état métier et crédits de façon atomique et réconciliable ; publier
  l’asset par référence, nettoyer les orphelins et tester l’expiration des sources.
- Vérifier l’isolation entre boutiques et sessions à la lecture des sources,
  dans les messages de file, les reprises et la livraison des résultats.
- Vérifier l’annulation entre étapes et avant livraison. Un résultat fournisseur
  incertain ne déclenche pas automatiquement un nouvel appel payant : rapprocher
  son statut lorsque possible, sinon appliquer une politique explicite de reprise.

**Validation :** les scénarios de redémarrage, doublon de message, expiration de
bail, `429`, réponse perdue et annulation concurrente ne provoquent ni double
débit ni résurrection d’un rendu annulé. Un rendu dépassant cinq minutes peut
terminer dans son échéance métier, ou échouer proprement avec un état explicite.

## L3 — Passer à un détourage précis

- Évaluer sur L1 des solutions spécialisées produisant un masque et un alpha,
  puis retenir celle qui préserve le mieux les détails critiques.
- Conserver la photo originale comme source des couleurs et textures ; affiner
  les contours en pleine résolution plutôt que recréer le produit.
- Traiter franges de fond, trous internes, ombres photographiées, fils, anses,
  pieds et éléments translucides ; mesurer séparément les matériaux difficiles.
- Ajouter une correction simple « conserver/effacer » avec annulation et aperçu
  sur fond clair/sombre. Demander une autre photo seulement si nécessaire.
- Versionner le masque et ses diagnostics ; prévoir une régénération explicite
  des anciens détourages sans réécrire les résultats historiques.

**Validation :** aucune partie critique perdue sur les cas supportés du jeu
réservé ; absence de rectangle de fond ou halo évident dans les résultats
acceptés. Évaluer les contours et détails fins, pas seulement la surface globale.

## L4 — Traiter la vraie géométrie de la scène

- Séparer trois modes : échelle estimée, taille ajustée visuellement et
  calibration par une mesure connue. Un curseur validé n’est pas une mesure.
- Stocker avec chaque référence son axe, son plan, sa position et sa provenance.
  Demander un repère vertical compatible pour une hauteur et un plan calibré
  pour les surfaces à plat.
- Remplacer le raccourcissement fixe des tapis par une projection du plan
  fondée sur quatre points ; réutiliser les outils d’homographie existants.
- Choisir une vue catalogue compatible avec la caméra pour les objets en
  volume. Si elle manque, signaler la limite ou demander une autre vue.
- Identifier les éléments au premier plan et restaurer leurs pixels devant
  l’objet : rebords, pieds de table, mobilier et autres occultants.
- Faire passer aperçu et rendu par un même contrat de placement versionné.

**Validation :** point d’ancrage préservé à 2 pixels près avant export ;
objectif proposé sur les cas réellement calibrés : erreur d’échelle médiane
≤ 5 %, P95 ≤ 10 %. Aucun ordre d’occlusion critique inversé parmi les résultats
acceptés du jeu réservé. Ne pas annoncer ces précisions pour le mode estimé.

## L5 — Améliorer l’intégration photographique

- Garder distincts les pixels du produit, les ombres, les effets de contact,
  les ajustements lumineux et le premier plan.
- Adapter direction, dureté et étendue des ombres au support et à la pièce.
  Comparer le transfert lumineux borné actuel à des variantes sur L1.
- Traiter le remplacement comme une étape vérifiée : cible complète retirée,
  structure du meuble intacte, texture locale plausible, avant insertion.
- Comparer sur le pilote un et plusieurs candidats, sans priorité au coût ;
  décider du nombre utile à partir du gain réel et de la variabilité.
- Utiliser des diagnostics ciblés : réparer une ombre ou un bord ; revenir au
  placement si la géométrie est mauvaise ; corriger la source si l’identité est
  compromise. Toujours repartir des sources et contrats validés.
- Conserver les intermédiaires sans perte et limiter la compression à l’export
  quand son effet a été mesuré.

**Validation :** amélioration du réalisme en comparaison aveugle, sans baisse
de fidélité produit ni modification hors zone autorisée. Aucun défaut critique
n’est compensé par une meilleure note globale.

## L6 — Rendre le parcours et les contrôles fiables

- Guider la prise de photo : netteté, objet entier, vue compatible et support
  visible ; fournir un conseil précis lorsque le contrôle détecte un problème.
- Présenter explicitement « Ajouter » et « Remplacer » et montrer la zone à
  supprimer ; ne pas déduire une suppression uniquement d’un point touché.
- Montrer le détourage et le placement avant génération. Afficher clairement
  la provenance de l’échelle et préserver l’aperçu en cas d’échec.
- Distinguer « à corriger », « contrôle temporairement indisponible » et « rendu
  validé ». Proposer l’action adaptée sans exposer les détails techniques.
- Mesurer faux accords et faux refus du juge visuel contre les évaluations
  humaines. Tester un second juge indépendant sur les cas ambigus seulement
  si cette comparaison apporte un gain mesurable.
- Recueillir le retour utilisateur par défaut observé : taille, position,
  détourage, identité, lumière ou décor modifié.

**Validation :** les parcours desktop/mobile permettent de corriger chaque
problème fréquent ; une panne du juge ne devient jamais un succès ; ses seuils
sont réglés sur des erreurs observées et validés sur le jeu réservé.

## L7 — Valider la version et déployer progressivement

- Exécuter la campagne sur les 120 cas avec résultats détaillés par catégorie.
  Qualifier séparément verre, miroir et vues manquantes ; ne pas masquer leurs
  limites dans une moyenne générale.
- Tester la charge à partir d’un volume de pointe explicite, puis à deux fois
  ce volume : attente dans la file, concurrence, mémoire, latence p95,
  saturation fournisseur, récupération et annulation.
- Fixer les objectifs de temps de traitement après les mesures réelles ;
  rendre les attentes longues visibles et maîtrisées.
- Déployer derrière une bascule versionnée : préproduction, utilisateurs
  internes, petit groupe de clients, puis élargissement si les critères tiennent.
- Préparer le retour au moteur précédent et la coexistence des versions pour
  les travaux déjà lancés. Tester la conservation et la purge des nouveaux dérivés.

**Portes de lancement proposées, à confirmer après le pilote :**

- zéro altération majeure d’identité parmi les résultats acceptés du jeu réservé,
  avec effectif publié ; cela ne prouve pas un risque nul en production ;
- au moins 90 % des résultats livrés jugés utilisables sans retouche par les
  évaluateurs, sur les catégories supportées ;
- au moins 85 % des entrées conformes aboutissant à un résultat utilisable dans
  le nombre de tentatives prévu ; publier aussi les refus et demandes de correction ;
- géométrie conforme aux objectifs de L4, aucune livraison non vérifiée,
  aucun double débit ni résultat annulé livré dans les scénarios d’interruption ;
- traces exploitables pour chaque échec, alertes sur travaux bloqués et
  procédure de retour arrière testée.

## Première séquence à lancer

1. Stabiliser la version et valider l’accès réel aux modèles (L0).
2. Constituer les 20 cas pilotes et obtenir une première comparaison (L1).
3. En parallèle, construire l’exécution durable et ses tests de panne (L2).
4. Prioriser les corrections L3/L4 selon les défauts du pilote, puis terminer
   l’intégration, les contrôles et le parcours (L5/L6).
5. Passer les portes de lancement de L7 avant généralisation.

Les accès de préproduction, les photos autorisées et les mesures de référence
sont les dépendances externes à réunir au début. Ce document crée le plan ;
il ne déclenche aucun déploiement ni campagne payante.
