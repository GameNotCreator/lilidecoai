# Photos source pour la visualisation des produits

Relevé du 29 septembre 2026. Recherche en lecture seule, sans modification du catalogue, sans génération d'image et sans appel IA payant.

## Résultat utile : panier en jute

La seconde image de la [fiche ILEYCOM du panier](https://ileycom.com/en/produit/laundry-basket-with-lid-diameter-40-cm-height-40-cm/) montre le panier entier, avec son couvercle et ses anses, sur fond blanc. Le tressage, le motif ajouré horizontal et les anses sont visuellement cohérents avec la photo d'ambiance déjà collectée. La fiche reste la même référence `250760` et annonce un diamètre de 40 cm et une hauteur de 40 cm.

- Source originale annoncée dans la galerie : `https://ileycom.com/wp-content/uploads/2026/01/panier-avec-couvercle-en-jute.png`.
- Image effectivement chargée et téléchargée sans retouche : `https://ileycom.com/wp-content/uploads/2026/01/panier-avec-couvercle-en-jute-800x800.png`.
- Fichier : `artifacts/placement-source-research-2026-09-29/panier-jute-packshot-source.png` (800 × 800, 131438 octets).
- SHA-256 : `b6397dad0185a77f7922a558f1409f2f409ed5e94703f9f54397142b02cc89a2`.
- Méthode : extraction de l'adresse depuis les attributs visibles de la galerie, puis téléchargement de cette image avec le navigateur.

C'est un candidat de segmentation, pas une validation de placement. La source commerciale associe cette image à cette référence ; cette association ne certifie pas l'histoire photographique du fichier. Aucun nom de fichier de cette image n'annonce une génération IA. Il reste à contrôler le détourage des anses et de leurs ouvertures, le contour du couvercle, la conservation du tressage et l'échelle dans la scène.

## Cache-pot : aucune vue vide vérifiée

La [fiche initiale](https://ileycom.com/en/produit/cachepot-bureau-elegant-20-cm-de-diametre-pour-un-espace-chic/) propose deux vues déjà collectées : un bonsaï dans le pot et une vue d'ambiance avec la même plante. La mesure de 16 cm décrit le pot ; elle ne doit pas être appliquée à la silhouette plante et pot.

Une [seconde fiche du vendeur](https://ileycom.com/en/produit/cachepot-moderne-design-20-cm-pour-un-bureau-elegant-et-chic/), référence `375845`, expose cinq images. Les trois premières ont des noms commençant explicitement par `ai-generated-Cache-pot-de-bureau-diam-20-H-` et sont exclues. Les deux autres portent les identifiants `jai3mj47lzo-1789933111047` et `o8qk486dj5-1789933103215`, également présents dans les deux images initiales avec bonsaï. Les URL et titres ont été relevés dans le navigateur ; la comparaison binaire de ces variantes sans suffixe `-1` n'a pas abouti, après perte de connexion au navigateur puis refus du téléchargement direct par le site. Leur égalité binaire n'est donc pas affirmée.

Aucune photo du pot seul n'a été vérifiée dans les deux fiches consultées. Ne pas supprimer la plante par génération pour inventer les parties cachées du bord ou du pot.

## Grenade noire et blanche

La [fiche de la grenade](https://ileycom.com/en/produit/grenade-decorative-artisanale-noire-et-blanche-14-cm-qualite-premium/) fournit déjà cinq vues non explicitement marquées génératives dans le dossier source du premier audit :

- `grenade-noire-blanche.jpg` et `grenade-autre-vue.jpg` : objet entier isolé, fond blanc ; le précédent détourage effaçait de la céramique claire.
- `grenade-detail.jpg` : vue coupée, impropre à une silhouette entière.
- `grenade-ambiance.jpg` et `grenade-bibliotheque.jpg` : objet entier mais environnement complexe.

Ces fichiers sont conservés dans `C:/Users/Hedi/Documents/Dev/LiliDecoAI/artifacts/catalogue-lilideco-2026-09-29/assets/`. Une sixième image dont le nom contient `ai-generated` reste exclue. Aucune meilleure vue source supplémentaire n'a été trouvée lors de cette recherche. L'amélioration doit porter sur un masque qui conserve les pixels des vues isolées existantes, avec contrôle visuel.

## Limites et remise

Le navigateur embarqué n'était plus disponible. La recherche a utilisé un nouvel onglet Brave dédié, sans manipuler les onglets personnels, puis les fichiers locaux du premier audit. La connexion Brave s'est interrompue après la récupération du nouveau panier. Aucun contournement du refus de téléchargement n'a été effectué.

Le packshot panier et son empreinte ont été transmis à l'agent principal et à l'auditeur du placement. Aucun produit n'a été rendu visualisable par cette seule recherche ; aucune donnée de production n'a été modifiée.
