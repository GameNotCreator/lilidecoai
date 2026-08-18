# Back office et banque de produits

Le back office vit sous `/admin`. Il gère la banque de produits publiée par le
visualiseur, la démo et le widget marchand, et il expose une vue des opérations
IA. Il est indépendant de l’espace marchand `/app` et de `DEMO_MODE`.

## Accès

L’interface reste **verrouillée tant qu’aucun identifiant n’est présent dans
l’environnement**, y compris quand `DEMO_MODE=true`. La page de connexion
affiche alors la variable manquante.

| Variable | Rôle |
| --- | --- |
| `ADMIN_USERNAME` | Identifiant de connexion. Défaut : `admin`. Insensible à la casse. |
| `ADMIN_PASSWORD` | Mot de passe en clair. Obligatoire si aucun hash n’est fourni. |
| `ADMIN_PASSWORD_HASH` | Hash bcrypt, prioritaire sur `ADMIN_PASSWORD`. Recommandé en production. |
| `ADMIN_SESSION_SECRET` | Secret de signature dédié. Retombe sur `APP_SESSION_SECRET`. |
| `ADMIN_SESSION_HOURS` | Durée de la session. Défaut 12 h, plafond 168 h. |
| `ADMIN_ORGANIZATION_SLUG` | Boutique alimentée par la banque. Défaut `atelier-lili`. |
| `ADMIN_ORGANIZATION_NAME` | Nom affiché de cette boutique si elle doit être créée. |

Générer un hash bcrypt :

```bash
node -e "console.log(require('bcryptjs').hashSync(process.argv[1],12))" "votre-mot-de-passe"
```

Règles appliquées au démarrage :

- une valeur d’exemple (`replace-with…`, `change-me…`, `admin`, `password`) est
  refusée ;
- en production, un mot de passe en clair de moins de 10 caractères est refusé ;
- un `ADMIN_PASSWORD_HASH` mal formé est refusé plutôt qu’ignoré.

## Sécurité

- Session signée HS256 dans un cookie `lili_backoffice`, `HttpOnly`,
  `SameSite=Strict`, `Secure` en production.
- La clé de signature dérive de `sha256(secret + "::backoffice")` avec une
  audience distincte : un jeton marchand ne peut pas être rejoué en jeton
  administrateur, ni l’inverse.
- Identifiant et mot de passe comparés en temps constant ; les deux
  vérifications sont toujours exécutées.
- Connexion limitée à 8 tentatives par client et 60 au total par tranche de
  10 minutes, via la collection `rate_limits`.
- Changer `ADMIN_USERNAME` invalide immédiatement les sessions en cours.
- Toutes les routes `/api/admin/*` revérifient la session à chaque requête ; le
  layout `app/admin/(protected)` redirige vers `/admin/login`.
- Les pages `/admin` sont marquées `noindex, nofollow`.

## Interface

| Route | Contenu |
| --- | --- |
| `/admin` | Compteurs du catalogue, réussite et coût des rendus, dernières fiches modifiées. |
| `/admin/produits` | Banque de produits : recherche, filtres, tri, sélection multiple, export CSV. |
| `/admin/produits/nouveau` | Création d’une fiche avec photo de face. |
| `/admin/produits/[id]` | Édition complète, gestion des vues, publication, suppression. |
| `/admin/operations` | 25 dernières tentatives des fournisseurs d’images. |

## Champs d’une fiche

- **Identité** : nom, SKU, marque, collection, type d’objet, support conseillé,
  tags (12 maximum), description.
- **Dimensions** : largeur/longueur, hauteur, profondeur en centimètres, poids
  en kilogrammes, matière. Un rappel indique la convention selon le type — pour
  un vase la largeur est le diamètre, pour un tapis la hauteur est l’épaisseur.
- **Tailles et déclinaisons** : liste de variantes, chacune avec libellé, SKU,
  dimensions, prix, stock et disponibilité. Les dimensions de la fiche restent
  la source de vérité du rendu ; les variantes décrivent l’offre commerciale.
- **Commercial** : prix, devise (`TND` par défaut), stock, lien d’achat
  (`http://` ou `https://` uniquement).
- **Rendu IA** : lumière de la photo, aspect de la matière, instructions de
  génération.

## Cycle de vie

```text
draft ──photo──▶ processing ──détourage──▶ ready ──▶ archived
  ▲                                          │           │
  └──────────── dépublier ◀──────────────────┘  restaurer┘
```

- Une fiche ne peut passer en `ready` que si elle possède un détourage ; sinon
  l’API répond 422.
- **Archiver** conserve la fiche et l’historique des rendus, mais la retire du
  site. **Supprimer définitivement** efface la fiche et toutes ses images, y
  compris sur Cloudinary.
- **Dupliquer** copie les champs et les variantes (avec de nouveaux
  identifiants) sans les images, en `draft`.
- **Rendre permanent** retire l’expiration d’un produit créé par un visiteur de
  la démo et le fait entrer dans la banque.
- Les produits de démonstration semés par `ensureDemoSeed` sont recréés au
  redémarrage s’ils sont supprimés définitivement ; archivez-les plutôt.

## Lien avec le site

Les fiches sont écrites dans la collection `products` de l’organisation
`ADMIN_ORGANIZATION_SLUG`, avec `createdByUserId = demo-catalog`. Une fiche
publiée est donc immédiatement disponible pour :

- `GET /v1/products` (espace marchand `/app/catalog`) ;
- le studio de démonstration et les sessions invitées ;
- `GET /v1/visualizer/{slug}/{productId}` et le widget marchand.

L’organisation est créée automatiquement au premier accès si elle n’existe pas.

## API

Toutes les routes exigent le cookie de session administrateur.

| Méthode | Route | Effet |
| --- | --- | --- |
| `GET` | `/api/admin/session` | État de configuration et de session. |
| `POST` | `/api/admin/session` | Connexion. |
| `DELETE` | `/api/admin/session` | Déconnexion. |
| `GET` | `/api/admin/overview` | Compteurs catalogue et opérations. |
| `GET` | `/api/admin/products` | Liste paginée (`q`, `status`, `objectType`, `placementType`, `sort`, `page`, `pageSize`). |
| `POST` | `/api/admin/products` | Création. |
| `GET` | `/api/admin/products/{id}` | Fiche complète. |
| `PATCH` | `/api/admin/products/{id}` | Mise à jour partielle : seules les clés envoyées sont écrites. |
| `DELETE` | `/api/admin/products/{id}` | Archive, ou efface avec `?permanent=true`. |
| `POST` | `/api/admin/products/{id}/actions` | `prepare`, `publish`, `unpublish`, `archive`, `restore`, `duplicate`, `persist`. |
| `POST` | `/api/admin/products/{id}/views` | Envoi multipart d’une vue (`file`, `viewType`). |
| `DELETE` | `/api/admin/products/{id}/views?type=` | Retrait d’une vue. |
| `POST` | `/api/admin/products/bulk` | Action groupée sur 100 identifiants maximum. |
| `GET` | `/api/admin/products/export` | Export CSV (UTF-8 avec BOM). |
