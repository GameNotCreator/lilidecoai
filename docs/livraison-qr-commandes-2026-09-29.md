# Boutique ByLiliDeco — visuel, QR et commandes

## Parcours livré

- L’accueil illustre la visualisation chez soi avec une image générée. Il ne présente plus un produit arbitraire comme visuel principal.
- Sur ordinateur, le bouton de visualisation ouvre un QR généré dans le navigateur. Sur téléphone, le lien ouvre directement la sélection. La sélection conserve les quantités dans la limite de trois unités et est revérifiée côté serveur.
- Le panier ouvre une demande de commande sans paiement en ligne. Coordonnées, tarifs recalculés et articles sont enregistrés avant la notification à la boutique. Les demandes restent consultables dans `/admin/commandes`, même si l’envoi d’email échoue.
- Notification marchande : `bylilideco.tunisie@gmail.com`. L’expéditeur appartient au domaine Resend vérifié configuré côté serveur. Aucun secret n’est inclus dans le dépôt.
- Les fiches présentent ByLiliDeco et des références BLD. Les liens marchands et anciennes mentions du partenaire ont été retirés des fiches ; la provenance de recherche reste dans le dossier interne.
- L’ancienne localisation a été retirée des pages publiques. Aucune nouvelle adresse n’a été inventée.

## Limites conservées

Les photos des trois produits publiés ne sont pas encore qualifiées pour la visualisation. Leurs motifs de blocage restent conservés, et la sculpture reste en brouillon. L’ouverture du QR ne contourne pas ces restrictions. L’illustration d’accueil n’est pas une preuve de résultat du moteur.

Le checkout est une demande à confirmer : prix définitif, disponibilité, livraison et règlement sont convenus avec la boutique. Les tests d’email utilisent un fournisseur simulé ; ils ne prouvent pas la réception réelle dans Gmail. Le navigateur mobile de test ne constitue pas un scan physique avec un téléphone.

## Image d’accueil

Fichier : `apps/web/public/brand/visualiser-chez-vous.png` (1254 × 1254).

SHA-256 : `ac9a900306c6fef28415ea040b7de010eb89aa11e1dce5bbd421f59be80963a8`.

Générée avec l’outil d’image intégré à Codex, sans la clé IA du projet. Image originale copiée sans transformation dans les ressources publiques.

### Prompt final

Use case: photorealistic-natural. Asset type: premium home decor concept store website hero image, square composition, to sit in the right half of a clean black and off-white website. Primary request: express the idea of previewing a decorative object in your own home with a smartphone, seamlessly integrated into an elegant lived-in room, not a product catalogue photo. Scene: a quiet contemporary Mediterranean living room, warm off-white plaster walls, pale linen sofa at the left edge, a light oak sideboard, soft natural afternoon light, restrained warm neutral palette. In the foreground, a naturally proportioned hand holds a slim black smartphone vertically; the entire phone is visible and its screen is clear. The screen shows exactly the same room from the matching perspective, with a sculptural cream ceramic vase virtually placed on the otherwise empty oak sideboard. A very subtle thin white placement corner frame around the vase on the phone screen makes the visualization understandable. The physical sideboard visible just beyond the phone remains empty in that spot. Photorealistic interior editorial photography with natural material texture, believable coherent perspective, quiet sophisticated styling, soft shadows; phone and room both sufficiently in focus. Balanced airy composition suitable for a nearly square hero crop. No text, no letters, no brand marks, no price tag, no giant floating product, no QR code, no neon holograms, no sparkles, no busy interface, no collage, no watermark. The asset is a conceptual illustration of the service, not a claim that the pictured vase is a real catalog product.

## Validation et publication

Validation locale du 29 septembre : 1 205 tests unitaires, 32 intégrations Mongo, 62 contrôles de livraison et 6 tests d’import réussis. 56 scénarios navigateur ont été validés, dont des relances ciblées après correction du QR et des sélecteurs du test checkout. Les contrôles dédiés à 320, 375 et 430 px ont ensuite été rejoués après l’ajustement du logo mobile. Types, lint et compilation de production réussis ; audit npm production sans vulnérabilité signalée.

Sur mobile : champs à 16 px pour éviter le zoom iOS, commandes tactiles de 44 px minimum, textes longs contenus et récapitulatif empilé. Le contrôle navigateur vérifie les débordements du document et des modales. Il ne remplace pas un essai sur un téléphone physique. Le visuel public est optimisé par Next selon l’écran : réponse WebP de 37 526 octets à 640 px, contre 2 110 078 octets pour le PNG original. L’optimiseur refuse les chemins autres que `/brand/**` (400 vérifié).

Candidat v11 : 240 fichiers, `sha256:a1cfaad2f0a9f20f6de9d0298de66087d68e59dc7604d0ca5839bdbbbb55a715`. Installation et build du candidat, publication et contrôle distant à consigner après exécution.

La configuration de production Resend est enregistrée dans Vercel. `RESEND_API_KEY` est sensible et exclue de Git ; les valeurs d’expéditeur et de destinataire sont côté serveur. Le domaine de l’expéditeur a été vérifié auprès de Resend par une requête de lecture, sans email de test.
