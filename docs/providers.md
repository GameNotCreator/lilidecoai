# Fournisseurs d’image

## Politique active

Le pipeline est piloté par `IMAGE_PIPELINE_MODE=google_hybrid` et reste
entièrement côté serveur.

| Étape                                    | Fournisseur | Modèle par défaut        |
| ---------------------------------------- | ----------- | ------------------------ |
| Analyse, segmentation assistée et aperçu | Google      | `gemini-3.1-flash-image` |
| Rendu final et remplacement              | Google      | `gemini-3-pro-image`     |
| Secours explicite uniquement             | OpenAI      | `gpt-image-2`            |
| Tests et développement sans clé          | Mock local  | `mock-image-v2`          |

OpenAI est conservé derrière les interfaces communes, mais n’est jamais choisi
tant que `OPENAI_IMAGE_ENABLED` ne vaut pas explicitement `true`. Il n’existe
aucune intégration Black Forest Labs dans cette version.

Les interfaces `ImageGenerationProvider`, `ImageEditingProvider`,
`SegmentationProvider` et `SceneAnalysisProvider` se trouvent dans
`packages/ai-router`. Chaque tentative retourne le même contrat : fournisseur,
modèle, identifiant distant, statut, durée, coût estimé, images, sécurité,
erreur normalisée et nombre de tentatives.

## Pipeline

1. La pièce originale, le point normalisé et les dimensions sont analysés.
2. En mode remplacement, un masque est proposé puis doit être corrigé ou
   confirmé dans l’interface. Aucun rendu ne part au premier clic.
3. La géométrie déterministe calcule la boîte, le contact et la taille depuis
   la perspective, la surface et la calibration disponible.
4. Le `PromptBuilder` versionné attribue un rôle à chaque référence et encode
   les contraintes de fidélité, caméra, perspective, éclairage et occlusion.
5. Google Flash génère les aperçus. Google Pro utilise la pièce originale et
   toutes les vues produit validées pour le rendu final.
6. Le validateur note onze critères. Une seule correction ciblée est autorisée,
   uniquement avec une raison précise et dans le plafond de coût.

Le remplacement reconstruit d’abord la zone confirmée, puis réanalyse la scène
nettoyée. L’arrière-plan hors masque est préservé. En mode insertion, un
obstacle détecté au point produit une demande claire de passer en mode
remplacement plutôt que de superposer deux objets.

## Variables serveur

```text
GOOGLE_AI_API_KEY=
# GEMINI_API_KEY est accepté comme alias de transition
GOOGLE_PREVIEW_IMAGE_MODEL=gemini-3.1-flash-image
GOOGLE_FINAL_IMAGE_MODEL=gemini-3-pro-image
GOOGLE_IMAGE_TIMEOUT_MS=240000
GOOGLE_IMAGE_MAX_RETRIES=1
GOOGLE_IMAGE_MAX_COST_USD=0.45
IMAGE_PIPELINE_MODE=google_hybrid
OPENAI_IMAGE_ENABLED=false
AI_MOCK_MODE=true
```

En production, mettre `AI_MOCK_MODE=false`. Aucune de ces variables ne doit
être préfixée par `NEXT_PUBLIC_`. Les clés, prompts complets et corps d’erreur
distants ne sont ni envoyés au navigateur, ni stockés en base, ni journalisés.

## Mode mock

`AI_MOCK_MODE=true` force les fournisseurs locaux et empêche tout appel payant,
même si une clé existe. Les tests unitaires et E2E utilisent ce mode. Le mock
couvre l’analyse de scène, la segmentation, l’édition et la génération.

## Documentation officielle vérifiée

- [Génération d’images Gemini](https://ai.google.dev/gemini-api/docs/image-generation)
- [API REST `generateContent`](https://ai.google.dev/api/generate-content)
- [Génération et édition d’images OpenAI](https://developers.openai.com/api/docs/guides/image-generation)
