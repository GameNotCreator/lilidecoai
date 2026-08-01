# Provider d’image

## Pipeline

Le pipeline TypeScript dans `apps/web/lib/server/rendering.ts` reçoit :

- la photo normalisée de la pièce ;
- le cutout du produit ;
- le point de contact et le support choisis par l’utilisateur ;
- l’échelle, la rotation et la lumière proposées par le modèle de vision ;
- la composition déterministe ;
- le masque de modification ;
- une clé d’idempotence.

Chaque tentative est persistée dans `render_attempts` avec provider, modèle,
durée, statut, score qualité et erreur sûre.

## OpenAI GPT Image 2

L’appel serveur utilise :

- `POST /v1/responses` avec `gpt-5.6-sol` en mode Fast pour analyser la pièce
  et retourner un placement structuré ;
- `POST /v1/images/edits` ;
- le modèle `gpt-image-2` par défaut ;
- les images `composition`, `product` et le masque ;
- un format de sortie WebP ;
- une taille adaptée au ratio de la pièce ;
- la qualité `high` par défaut.

Le contrôle qualité utilise des copies WebP limitées à 1 024 px avec un niveau
de détail `high`. Le rendu final, la photo utilisée pour le placement et le
cutout envoyé au générateur conservent leur précision d'origine. Si le compte
OpenAI ne permet pas le mode Fast, le pipeline retente automatiquement l'analyse
en traitement standard.

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
- validation structurée du placement et repli local en cas d’échec de la vision ;
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
