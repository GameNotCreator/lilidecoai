# Provider d’image

## Pipeline

Le pipeline TypeScript dans `apps/web/lib/server/rendering.ts` reçoit :

- la photo normalisée de la pièce ;
- le cutout du produit ;
- la transformation géométrique ;
- la composition déterministe ;
- le masque de modification ;
- une clé d’idempotence.

Chaque tentative est persistée dans `render_attempts` avec provider, modèle,
durée, statut, score qualité et erreur sûre.

## OpenAI GPT Image 2

L’appel serveur utilise :

- `POST /v1/images/edits` ;
- le modèle `gpt-image-2` par défaut ;
- les images `room`, `product`, `composition` et le masque ;
- un format de sortie WebP ;
- une taille adaptée au ratio de la pièce ;
- la qualité `medium` par défaut.

Le cutout original est replacé après la génération pour préserver les pixels du
catalogue. En `DEMO_MODE=true` ou sans `OPENAI_API_KEY`, aucun appel OpenAI
n’est effectué : le rendu local Sharp est utilisé.

## Garde-fous

- clé uniquement côté serveur ;
- plafond `OPENAI_MAX_COST_USD` avant appel ;
- coût et durée enregistrés par tentative ;
- débit d’un crédit uniquement après succès ;
- messages d’erreur nettoyés ;
- contrôle qualité et overlay indépendants du provider.

## Ajouter un provider

1. Ajouter son implémentation TypeScript au pipeline serveur.
2. Accepter des buffers, jamais des chemins de disque persistants.
3. Ne renvoyer aucun secret, prompt privé ou corps complet d’erreur.
4. Ajouter uniquement des variables serveur dans `.env.example`.
5. Intercepter le réseau dans les tests pour garantir qu’aucun appel réel ne
   survient en mode démo.
6. Conserver la composition, l’overlay et le débit de crédit indépendants du
   fournisseur.
