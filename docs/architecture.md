# Architecture

LiliDecoAI reste une application full-stack Next.js. Les pages React,
l’authentification et les routes `/v1/*` vivent dans `apps/web` et sont
hébergées ensemble sur Vercel. MongoDB est l’unique base ; Cloudinary stocke les
images privées ; Sharp normalise et compose les images. Il n’existe ni FastAPI,
ni Supabase, ni worker Python séparé.

## Flux de rendu

```mermaid
flowchart TD
    A["1 à 4 vues produit"] --> N["Normalisation serveur"]
    B["Photo de la pièce"] --> S["Analyse de scène"]
    C["Point utilisateur"] --> S
    S --> M{"Zone libre ou occupée ?"}
    M -->|"Libre"| G["Géométrie déterministe"]
    M -->|"Occupée"| K["Segmentation et correction du masque"]
    K --> X["Confirmation utilisateur"]
    X --> R["Suppression de la cible"]
    R --> S2["Réanalyse de la scène nettoyée"]
    S2 --> G
    N --> G
    G --> P["PromptBuilder versionné"]
    P --> Q{"Qualité"}
    Q -->|"Aperçu"| F["Gemini 3.1 Flash Image"]
    Q -->|"Final"| H["Gemini 3 Pro Image"]
    F --> V["Contrôle qualité"]
    H --> V
    V -->|"Correction ciblée, max. 1"| P
    V -->|"Accepté"| D["Cloudinary et MongoDB"]
```

La photo originale de la pièce est toujours fournie au rendu premium. Une
prévisualisation compressée n’est jamais sa seule référence. La géométrie,
l’échelle, les coordonnées et le confinement au masque restent déterministes
autant que possible ; le modèle génératif harmonise les pixels dans ces
contraintes.

## États et données

Le client suit `uploaded`, `analyzing_scene`, `segmenting_target`,
`awaiting_mask_confirmation`, `computing_geometry`, `removing_target`,
`building_prompt`, `generating_preview`, `generating_final`, `quality_check`,
`retrying`, `completed`, `failed` et `refunded`.

MongoDB conserve notamment :

- `products` avec 1 à 4 vues validées et leurs rôles ;
- `scenes`, analyse et durée de conservation ;
- `segmentations` et masque confirmé ;
- `renders`, mode, surface, points, dimensions, lumière, calibration, chaîne de
  modèles, score, latence, coût et version de prompt ;
- `render_attempts` pour chaque appel normalisé ;
- `render_feedback`, crédits, analytics sans image et audits ;
- `rate_limits` pour les quotas serveur.

Le script `npm run migrate:image-pipeline` est une simulation par défaut. Il
ajoute les champs compatibles aux anciens documents seulement avec `-- --apply`
et ne supprime aucune donnée.

## Parcours `simple_point`

Le parcours public ne demande aucune géométrie au modèle. Une seule fonction
pure, `computeSimplePlacement` dans `packages/geometry`, décide la taille en
pixels, l’ancrage de la base, l’ordre de profondeur et le rognage par le
cadre ; elle tourne à l’identique dans le navigateur et sur le serveur.

```mermaid
flowchart TD
    P["Photos produits"] --> C["prepareCutout: matte, ombre, ligne de base"]
    C -->|"échec dur"| M["Correction du détourage requise"]
    C --> C2
    R["Photo du lieu"] --> S["POST /scenes/:id/scale (gratuit, en cache)"]
    T["Points tapés"] --> S
    S --> G["computeSimplePlacement"]
    C2 --> G
    G --> A["Aperçu client, badges d’échelle, curseurs"]
    G --> V["planSimplePlacements: pré-vol 422"]
    V --> O{"Obstacle au point ?"}
    O -->|"oui"| X["Suppression masquée + recollage"]
    O -->|"non"| K
    X --> K["Composite déterministe stocké"]
    K --> Q["Précontrôle visuel de la composition"]
    Q --> H["GPT Image 2.5 Sunburst : contact, bords et lumière"]
    H --> B["Recollage hors masque + re-tampon d’identité"]
    B --> VQ["Contrôle visuel de chaque objet"]
    VQ -->|"Reprise ciblée, max. 1, si délai suffisant"| H
    VQ -->|"Accepté"| OK["Livraison et débit"]
```

Trois garanties tiennent par construction et non par prompt : la base d’un
objet ne bouge jamais du point tapé (le cadre le rogne, il n’est pas
déplacé) ; hors du masque, chaque pixel vient du composite ; et le cœur de
chaque objet réutilise le détourage catalogue avec une correction de luminance
basse fréquence bornée à ±12 %. L’échelle et sa
provenance (`vision`, `vision_coarse`, `vision_interpolated`,
`assumed_room_width`, `user`) remontent jusqu’à l’interface, qui ne présente
jamais une estimation comme une mesure.

## Limites connues

L’exécution différée reste limitée à la durée de la route web. Le plan de
file persistante, de reprise par étape et de concurrence bornée est détaillé
dans [l’audit du 20 septembre](audit-image-2026-09-20.md). Il n’est pas encore
déployé ; les délais sont bornés et un contrôle indisponible interdit la livraison.

- Sans calibration réelle, l’échelle reste estimée et l’interface l’indique.
- La segmentation compatible point/masque est interchangeable ; le backend
  actuel propose un masque assisté à corriger, pas un modèle SAM local lourd.
- Le parcours public accepte jusqu’à trois produits dans une seule édition ;
  les anciens parcours marchands conservent leurs contrats historiques.
- Les angles produit absents sont estimés et ne sont jamais présentés comme
  parfaitement fidèles.
- Les surfaces réfléchissantes, transparentes ou très occultées peuvent
  nécessiter une nouvelle photo ou une correction de masque.
