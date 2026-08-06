# Fournisseurs d’image

## Politique active de la démo

Le parcours public `simple_point` reste entièrement côté serveur.

| Étape                                    | Fournisseur | Modèle par défaut        |
| ---------------------------------------- | ----------- | ------------------------ |
| Ajout ou remplacement depuis un point    | OpenAI      | `gpt-image-2`            |
| Tests et développement sans clé          | Mock local  | `mock-image-v2`          |

La démo choisit explicitement OpenAI, même si les anciens fournisseurs restent
derrière les interfaces communes pour les parcours marchands existants.

Les interfaces `ImageGenerationProvider`, `ImageEditingProvider`,
`SegmentationProvider` et `SceneAnalysisProvider` se trouvent dans
`packages/ai-router`. Chaque tentative retourne le même contrat : fournisseur,
modèle, identifiant distant, statut, durée, coût estimé, images, sécurité,
erreur normalisée et nombre de tentatives.

## Pipeline

1. L’image 1 est la photo originale du lieu ; l’image 2 est l’objet fourni.
2. Le clic est converti en coordonnées pixel et normalisées.
3. Le choix de l’utilisateur fixe l’opération `Place` ou `Remplace` ; aucune
   segmentation automatique n’est imposée dans cette démo.
4. `buildSimplePointPrompt` ajoute le point, la largeur ou la hauteur réelle et
   les contraintes de préservation de la photo.
5. L’endpoint `/v1/images/edits` exécute une seule édition avec
   `model=gpt-image-2`. Le modèle reçoit les images en haute fidélité par
   défaut, conformément à la documentation OpenAI.

## Variables serveur

```text
OPENAI_API_KEY=
OPENAI_MODEL=gpt-image-2
OPENAI_IMAGE_ENABLED=true
AI_MOCK_MODE=true
```

En production, mettre `AI_MOCK_MODE=false`. Aucune de ces variables ne doit
être préfixée par `NEXT_PUBLIC_`. Les clés, prompts complets et corps d’erreur
distants ne sont ni envoyés au navigateur, ni stockés en base, ni journalisés.

## Mode mock

`AI_MOCK_MODE=true` force les fournisseurs locaux et empêche tout appel payant,
même si une clé existe. Les tests unitaires et E2E utilisent ce mode. Le mock
couvre l’édition et le parcours complet sans appel OpenAI.

## Documentation officielle vérifiée

- [Génération et édition d’images OpenAI](https://developers.openai.com/api/docs/guides/image-generation)
- [Modèle GPT Image 2](https://developers.openai.com/api/docs/models/gpt-image-2)
