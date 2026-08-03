# Provider d’image

## Pipeline

Le pipeline TypeScript dans `apps/web/lib/server/rendering.ts` reçoit :

- la photo normalisée de la pièce ;
- le cutout du produit ;
- le point de contact et le support choisis par l’utilisateur ;
- l’inspection séparée de l’obstacle au point choisi ;
- l’image nettoyée quand un objet doit être remplacé ;
- la seconde analyse de perspective, d’échelle et de volume disponible ;
- la composition déterministe ;
- le masque de modification ;
- une clé d’idempotence.

Chaque tentative est persistée dans `render_attempts` avec provider, modèle,
durée, statut, score qualité et erreur sûre.

## OpenAI GPT Image 2

L’appel serveur utilise :

- deux appels structurés à `POST /v1/responses` avec `gpt-5.6-sol` en mode Fast :
  le premier détecte l’obstacle et la lisibilité, le second relit l’image
  nettoyée et calcule le contact, l’échelle et les limites ;
- `POST /v1/images/edits` ;
- le modèle `gpt-image-2` par défaut ;
- une première retouche locale `medium` uniquement lorsqu’un obstacle doit être
  effacé, sans ajout de produit ;
- les images `composition`, `product` et le masque ;
- un format de sortie WebP ;
- une taille adaptée au ratio de la pièce ;
- la qualité `high` par défaut.

Le contrôle qualité conserve les trois références en détail `original`. Le
rendu final, la photo utilisée pour le placement et le cutout envoyé au
générateur gardent donc leur précision d'origine. Si le compte OpenAI ne permet
pas le mode Fast, le pipeline retente automatiquement l'analyse en traitement
standard.

Sur Vercel, la route renvoie immédiatement un rendu `processing`, puis exécute
les couches avec `after`. Le client affiche l’étape active, interroge le rendu
toutes les trois secondes et montre successivement l’image nettoyée, la
prévisualisation placée puis l’image contrôlée.

La composition contenant déjà le produit est l’image principale. Le masque
limite la retouche à la zone cible et protège tous les pixels extérieurs, tout en
laissant le modèle harmoniser le matériau, la lumière et le contact du produit.
Aucun second cutout n’est recollé après la génération.
En `DEMO_MODE=true` ou sans `OPENAI_API_KEY`, aucun appel OpenAI n’est effectué :
un placement automatique de secours et le rendu local Sharp sont utilisés.

## Garde-fous

- clé uniquement côté serveur ;
- plafond `OPENAI_MAX_COST_USD` avant appel ;
- coût et durée enregistrés par tentative ;
- débit d’un crédit uniquement après succès ;
- messages d’erreur nettoyés ;
- refus explicite d’une image illisible ou d’un emplacement trop petit ;
- validation géométrique déterministe de la boîte projetée du produit dans le
  volume libre retourné par l’analyse ;
- un seul exemplaire du produit dans le résultat final.

## Ajouter un provider

1. Ajouter son implémentation TypeScript au pipeline serveur.
2. Accepter des buffers, jamais des chemins de disque persistants.
3. Ne renvoyer aucun secret, prompt privé ou corps complet d’erreur.
4. Ajouter uniquement des variables serveur dans `.env.example`.
5. Intercepter le réseau dans les tests pour garantir qu’aucun appel réel ne
   survient en mode démo.
6. Conserver la composition, l’overlay et le débit de crédit indépendants du
   fournisseur.
