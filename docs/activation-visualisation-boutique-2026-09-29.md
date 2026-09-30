# Préparation des produits pour la visualisation

La boutique utilisait uniquement le détourage par couleur du fond. Les photos de la grenade et du panier perdaient des parties claires du produit : leur désactivation était donc justifiée. Le chemin boutique reste `legacy/simple_point` ; le moteur spatial expérimental reste fermé.

## État vérifié le 30 septembre 2026

La grenade BLD-375567 est activée en production après acceptation du sixième contrôle réel à 0,85 et revue indépendante du candidat V5. Le rendu initial reste échoué ; l'acceptation porte sur un candidat retraité distinct, obtenu sans seconde génération d'image. Les 22 fichiers de preuve concordent avec leurs empreintes. Le détourage publié a été recréé depuis la source et le masque : fichier identique, aucun pixel RGB source modifié et aucun écart d'alpha.

L'activation ne modifie que cette fiche. Les 12 fiches administrateur et les 3 articles publics sont conservés. Le QR code ouvre la grenade dans le parcours de visualisation, et le panier autorise jusqu'à trois articles, quantités comprises. Ces contrôles navigateur ne constituent pas un essai de caméra sur téléphone physique ni un rendu payant exécuté sur Vercel.

La révision `ba4bb08829d06959e7aa460c43c61499b13ab616` est déployée en production et sa chaîne CI complète a réussi. Le panier attend encore sa qualification finale : sa seconde tentative a conservé trois analyses réussies, puis le garde local a refusé l'entrée verticale 1500 × 2250 avant tout appel image. Le total conservateur de la campagne est alors de 5,667418 USD, réservations inconnues comprises. Le cache-pot reste désactivé, faute de photo du pot seul correspondant à ses dimensions.

## Correction

Le backoffice accepte désormais un masque PNG en niveaux de gris lié à l'identifiant et à l'empreinte de la photo enregistrée. Le serveur applique uniquement sa couverture aux couleurs de cette photo. Il refuse les formats et dimensions incompatibles, les masques vides ou opaques, les silhouettes abîmées et les sujets multiples. L'import authentifié conserve les contrôles d'origine et les protections contre les modifications concurrentes.

Une nouvelle préparation remet l'article en brouillon. Elle devient réutilisable après contrôle des empreintes de la photo, du détourage, de ses métadonnées et de la géométrie. Une modification des dimensions actualise uniquement la géométrie. La publication reste une action distincte ; importer un masque ne retire jamais un motif de désactivation.

## Photos de la boutique

| Article | Photo stockée SHA256 | Masque SHA256 | Revue du détourage |
| --- | --- | --- | --- |
| Grenade, BLD-375567 | `c5759fd4f64f06db125317e723cd4d96dece6a0c4342768eea45d074cdb6271f` | `78f203382f2800c535478a78330f52e287a18e081e9cdcec4db5dda0faf7457f` | Silhouette, pied, couronne et motifs conservés |
| Panier, BLD-250760 | `fdfcc1dadc048b9cbfb22e3113f5b6d9205bb0becb3b426cbb014021965adfba` | `46f77815c154a182432c6a1cd368d28e4459bdf30610b9d5ee9a3ee1dfd4ac0f` | Couvercle, poignées et base conservés |
| Cache-pot, BLD-375856 | Photo avec bonsaï | Aucun masque approuvé | Reste désactivé : dimensions du pot seul |

Les masques sont calculés localement avec les poids BiRefNet-lite déjà vérifiés. La grenade reçoit une correction des seules cavités fermées de sa céramique pleine. Cette correction ne devient pas une règle générale pour les anses, les plantes ou les objets creux. Les couleurs ne sont pas régénérées. Les preuves locales sont dans `artifacts/catalogue-matting-2026-09-29/final-proof.json` du checkout original ; les fixtures positives reproductibles sont versionnées dans `apps/web/tests/fixtures/catalogue`.

## Validation et limites

La contre-revue des sources et des détourages est une revue par agents, pas une revue humaine. Les scènes de catalogue utilisées pour les essais représentent une vérification de plausibilité visuelle, sans mesure physique indépendante. Le site annonce déjà une échelle approximative.

La publication des produits nécessite également un essai réel accepté, la revue du résultat et une relecture des fiches en production. Chaque essai complet est lancé séparément avec une limite estimée de 2 USD, comprenant analyse, génération et contrôle. Un contrôle seul est limité à 0,90 USD et la campagne à 7,76 USD conservateurs, conformément au dernier budget autorisé. Les réservations et réponses sont enregistrées ; un résultat réseau inconnu interdit une relance automatique. Ces montants ne sont pas une facture ni le solde du compte fournisseur.

Les trois utilitaires de qualification omis du précédent envoi Git ont aussi été réintégrés. Les 45 tests associés passent à nouveau dans le checkout géré ; cette correction ne constitue pas une qualification spatiale.

## Correction de l’intégration dans la photo

Le premier essai réel de la grenade a produit une image, puis son contrôle final a expiré après 45 secondes. L’image générée décalait le produit ; le transfert des pixels générés autour de la silhouette, suivi de la restauration du produit original, créait un dédoublement. Le rendu initial reste enregistré comme `failed`, avec une décision `unavailable` et une réservation conservatrice pour l’appel de contrôle dont l’issue est inconnue.

Le parcours `simple_point` utilise désormais `composite-v3/contact-light-v5`. Il conserve les motifs et la teinte source, puis applique un éclairage achromatique borné au produit. Quand la sortie générée est décalée, la lumière latérale estimée de la pièce fournit une correction douce ; le gain total reste limité à ±12 %, y compris lorsqu’un champ généré compatible est disponible. Les RGB du résultat sont donc ajustés, sans modifier les assets catalogue ni remplacer leurs détails. Une ombre de contact et une ombre portée sont calculées depuis sa silhouette, sa largeur d’appui et la lumière estimée de la pièce. Leur atténuation est plafonnée à 45 %, dans le masque autorisé ; il s’agit d’une approximation géométrique, pas d’une mesure physique. Un contour clair épais peut recevoir un retrait d’alpha limité à une couche de pixels à la composition, sans modifier le détourage stocké ni ses couleurs. Les structures fines, le cœur opaque et les contours sombres sont protégés. Aucun pixel RGB généré n’est recopié autour du produit. Le traitement spatial et la suppression d’obstacles conservent leur comportement antérieur. Le contrôle final dispose de 150 secondes maximum, toujours limité par l’échéance du rendu ; le précontrôle conserve 45 secondes et les critères d’acceptation sont inchangés. L’analyse d’échelle dispose de 90 secondes maximum, incluant la préparation de son image et bornées par le temps restant du rendu avec une réserve de 100 secondes pour la suite.

Le retraitement réutilise les octets déjà générés, sans nouvel appel d’image. Le premier candidat sans doublon a été refusé à 0,46 pour contact et ombres insuffisants. Le candidat v2 a été refusé à 0,68 pour son seul liseré clair, avec contact à 0,88 et lumière/ombres à 0,84. Le candidat v3 conserve exactement cette ombre ; seuls 303 pixels d’alpha du bord sont atténués, dont 142 précédemment opaques sur le contour. Les couleurs source, le cœur et la couronne restent identiques. Aucun pixel hors du masque ne change. Chaque nouveau contrôle est enregistré séparément et ne transforme jamais l’échec historique en succès.

Le troisième contrôle réel refuse encore le candidat v3 à 0,65 pour le liseré clair et l’éclairage du catalogue, malgré un contact à 0,88. La grenade n’est donc pas encore qualifiée. Le premier essai du panier s’arrête sur l’analyse de la pièce après 60 secondes, avant toute génération d’image ; sa réservation de 0,53 USD reste comptée et aucune relance automatique n’a lieu. Le total conservateur des essais et réservations atteint alors 3,345493 USD, sans valeur de facture.

Les 1 260 tests unitaires passent après v5. Les 32 tests d’intégration de la file de rendu, les 66 contrôles de livraison et 58 tests navigateur (4 scénarios ignorés intentionnellement) ont également passé avant les corrections v2/v3/v4/v5. Le build de production, le typage et le lint passent après v5. Les tests locaux ne constituent pas une preuve de publication en production.

Le quatrième contrôle de la grenade a expiré après 90 secondes sans verdict. Sa réservation de 0,84 USD reste conservée, portant le total conservateur à 4,185493 USD avant les nouveaux essais. Le délai final est porté à 150 secondes, sans modifier le prompt, le raisonnement ni les critères ; les 94 tests ciblés, le lint et la compilation passent. La route du worker actuelle autorise 800 secondes avec une interruption entre étapes à 300 secondes. Le cinquième contrôle reste une exécution distincte, jamais une validation présumée de l’appel perdu.

Le cinquième contrôle réel refuse V4 à 0,70 pour la seule frange blanche : lumière/ombres à 0,84 et contact à 0,90. Son coût conservateur de 0,377775 USD porte le total à 4,563268 USD. V5 retient la variante de bord à 1 pixel après comparaison hors ligne de 0,65/0,85/1 pixel : 331 alphas de bord ajustés, 101 pixels rendus transparents dont un auparavant opaque ; cœur, couronne, structures fines, RGB catalogue, ombres et fond préservés. Cette correction ne présume pas le résultat de QA6.
