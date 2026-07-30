# Providers d’image

## Contrat

`ImageGenerationProvider` reçoit :

- la photo nettoyée de la pièce ;
- le cutout PNG du produit ;
- la composition géométrique ;
- le masque de modification ;
- un prompt structuré ;
- qualité, résolution et clé d’idempotence.

Il renvoie provider, modèle, statut, durée, usage, coût estimé et erreur sûre.
Chaque tentative est persistée dans `render_attempts`.

## OpenAI GPT Image 2

`OpenAIImageProvider` utilise exclusivement :

- `POST /v1/images/edits`
- modèle `gpt-image-2`
- qualité `medium` par défaut
- arrière-plan `opaque`
- sortie `webp`, compression `90`
- `1024x1024`, `1536x1024` ou `1024x1536` selon le ratio de la pièce

`input_fidelity` est volontairement omis : GPT Image 2 traite ses entrées en
haute fidélité automatiquement. Le provider envoie trois images (`room`,
`product`, `composition`) et le masque. Le cutout original est reposé après la
génération pour préserver les pixels catalogue.

Références officielles consultées :

- <https://developers.openai.com/api/docs/models/gpt-image-2>
- <https://developers.openai.com/api/docs/guides/image-generation>

Le connecteur n’a pas été exécuté sans clé. L’organisation OpenAI peut exiger
une vérification avant l’accès au modèle.

## Garde-fous

- clé uniquement côté serveur ;
- timeout configurable ;
- une nouvelle tentative ;
- clé d’idempotence par tentative ;
- plafond `OPENAI_MAX_COST_USD` ;
- coût estimé avant appel et usage réel enregistré après ;
- aucun test automatique ne peut sélectionner OpenAI en `DEMO_MODE=true` ;
- fallback automatique sur `MockImageProvider` sans clé.

## Ajouter un provider

1. Implémenter `is_available()` et `generate()` selon le protocole Python dans
   `services/api/app/rendering/providers.py`.
2. Ne renvoyer aucune erreur contenant un token, prompt privé ou corps complet.
3. Ajouter les variables serveur à `.env.example`.
4. Étendre `choose_provider` avec une règle explicite de qualité/coût.
5. Ajouter un test qui intercepte le réseau et prouve qu’aucun appel réel ne
   survient.
6. Garder l’overlay catalogue et le contrôle qualité indépendants du provider.

