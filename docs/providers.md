# Provider d’image

## Pipeline

Le pipeline TypeScript dans `apps/web/lib/server/rendering.ts` reçoit :

- la photo normalisée de la pièce ;
- le cutout du produit ;
- le support choisi par l’utilisateur ;
- le placement structuré proposé par le modèle de vision ;
- la composition déterministe ;
- le masque de modification ;
- une clé d’idempotence.

Chaque tentative est persistée dans `render_attempts` avec provider, modèle,
durée, statut, score qualité et erreur sûre.

## OpenAI GPT Image 2

L’appel serveur utilise :

- `POST /v1/responses` avec `gpt-5.6` pour analyser la pièce et retourner un
  placement structuré ;
- `POST /v1/images/edits` ;
- le modèle `gpt-image-2` par défaut ;
- les images `composition`, `product`, `room` et le masque ;
- un format de sortie WebP ;
- une taille adaptée au ratio de la pièce ;
- la qualité `medium` par défaut.

La composition contenant déjà le produit est l’image principale. Le masque
protège les pixels du produit et n’autorise que le travail d’ombre, de contact et
de lumière autour de lui. Aucun second cutout n’est recollé après la génération.
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
