# Back office et banque de produits

Le back office vit sous `/admin`. Il gère la banque de produits publiée par le
visualiseur, la démo et le widget marchand, et il expose une vue des opérations
IA. Il est indépendant de l’espace marchand `/app` et de `DEMO_MODE`.

## Accès

Le compte **LiliDeco** demandé est actif par défaut : son mot de passe est
vérifié contre un hash bcrypt de coût 12, conservé dans un module serveur.
Aucun mot de passe par défaut ni hash n'est envoyé à l'interface. Les anciennes
variables de connexion `ADMIN_USERNAME`, `ADMIN_PASSWORD` et
`ADMIN_PASSWORD_HASH` ne remplacent pas silencieusement ce compte.

Un **`APP_SESSION_SECRET` privé d'au moins 32 caractères reste obligatoire**,
y compris en local et en démo. Aucun secret de signature commun ou de secours
n'est fourni par le code. Sans cette configuration, l'accès reste verrouillé.

| Variable | Rôle |
| --- | --- |
| `APP_SESSION_SECRET` | Secret privé obligatoire, au moins 32 caractères. |
| `ADMIN_CREDENTIALS_MODE` | `fixed` par défaut. `environment` active explicitement une rotation de compte. |
| `ADMIN_USERNAME` | En mode `environment` seulement : identifiant, `LiliDeco` par défaut. Casse et espaces extérieurs ignorés. |
| `ADMIN_PASSWORD_HASH` | En mode `environment` seulement : hash bcrypt, prioritaire sur le mot de passe en clair. |
| `ADMIN_PASSWORD` | En mode `environment` seulement : alternative au hash. Au moins 10 caractères en production. |
| `ADMIN_SESSION_SECRET` | Secret privé dédié facultatif, au moins 32 caractères. `APP_SESSION_SECRET` reste exigé. |
| `ADMIN_SESSION_HOURS` | Durée de la session. Défaut 12 h, plafond 168 h. |
| `ADMIN_ORGANIZATION_SLUG` | Boutique alimentée par la banque. Défaut `atelier-lili`. |
| `ADMIN_ORGANIZATION_NAME` | Nom affiché de cette boutique si elle doit être créée. |

Générer un hash bcrypt :

```bash
node -e "console.log(require('bcryptjs').hashSync(process.argv[1],12))" "votre-mot-de-passe"
```

Pour une rotation volontaire, définir `ADMIN_CREDENTIALS_MODE=environment`,
puis le nouveau hash et éventuellement l'identifiant. Un mode inconnu, un hash
mal formé ou un mode `environment` sans mot de passe bloque l'accès ; aucune
reprise silencieuse du compte par défaut n'a lieu. La rotation du compte, du
mot de passe ou du secret invalide les sessions existantes.

Le précontrôle de production suit cette même règle : il n'exige pas de variables
de mot de passe en mode `fixed`, mais exige toujours le secret de session privé.
En mode `environment`, il valide les identifiants de rotation et la priorité du
hash, sans en écrire les valeurs dans les résultats.

Pour la boutique en production, le précontrôle exige également la désactivation
des inscriptions marchandes qui attribuent des crédits gratuits : laisser
`MERCHANT_SIGNUP_ENABLED` absent ou définir `false`. L'activation explicite à
`true` concerne un autre parcours d'exploitation et bloque ce précontrôle de
publication. Les connexions des comptes existants restent distinctes.

Règles appliquées aux identifiants configurés pour une rotation :

- une valeur d’exemple (`replace-with…`, `change-me…`, `admin`, `password`) est
  refusée ;
- en production, un mot de passe en clair de moins de 10 caractères est refusé ;
- un `ADMIN_PASSWORD_HASH` mal formé est refusé plutôt qu’ignoré.

## Le back office reste verrouillé ?

Ouvrez `/api/admin/session` sur le déploiement concerné. La réponse indique la
raison et la présence des variables — jamais les valeurs. La page de connexion
affiche seulement un message de configuration indisponible.

```json
{
  "configured": false,
  "reason": "…",
  "detected": {
    "ADMIN_CREDENTIALS_MODE": false,
    "ADMIN_USERNAME": false,
    "ADMIN_PASSWORD": false,
    "ADMIN_PASSWORD_HASH": false,
    "APP_SESSION_SECRET": false
  }
}
```

| Symptôme | Cause | Correctif |
| --- | --- | --- |
| `APP_SESSION_SECRET` absent, trop court ou d'exemple | Aucune clé privée valide n'est disponible. | Configurer un secret privé d'au moins 32 caractères, puis redémarrer ou redéployer. |
| Compte demandé refusé malgré d'anciens `ADMIN_*` | Le mode de rotation a été activé explicitement. | Utiliser le compte tourné ou remettre `ADMIN_CREDENTIALS_MODE=fixed`. |
| Mode `environment` verrouillé | Hash absent/mal formé ou mot de passe rejeté. | Corriger les identifiants de rotation, puis redémarrer ou redéployer. |
| Changement de variable sans effet | Le déploiement ou le processus local précède la modification. | Redémarrer localement ou créer un nouveau déploiement dans l'environnement concerné. |
| `Identifiants invalides` | La saisie ne correspond pas au compte actif. | Vérifier le compte ; le mot de passe reste sensible à la casse et aux espaces. |

En local, `apps/web/next.config.ts` charge aussi le `.env` (et `.env.local`) de
la racine du dépôt, celui que le README demande de créer. Une variable déjà
définie dans l’environnement n’est jamais écrasée, et sur Vercel le fichier est
absent : ce sont les variables du tableau de bord qui s’appliquent. Après avoir
modifié ce fichier, redémarrez `npm run dev`.

## Sécurité

- Session signée HS256 dans un cookie `lili_backoffice`, `HttpOnly`,
  `SameSite=Strict`, `Secure` en production.
- La clé de signature dérive du secret privé, d'un contexte back office et des
  identifiants actifs. L'audience et l'algorithme HS256 sont vérifiés : un jeton
  marchand ne peut pas être rejoué en jeton administrateur.
- Identifiant et mot de passe comparés en temps constant ; les deux
  vérifications sont toujours exécutées.
- Connexion limitée à 8 tentatives par client et 60 au total par tranche de
  10 minutes, via la collection `rate_limits`.
- Changer les identifiants actifs ou le secret de signature invalide les sessions
  dans les pages comme dans les API. Les valeurs de rotation ignorées en mode
  `fixed` n'ont pas d'effet sur les sessions.
- La connexion, la déconnexion et toutes les mutations `/api/admin/*` exigent
  l'en-tête `Origin` de ce site ; une
  origine étrangère, absente ou un contexte `Sec-Fetch-Site: cross-site` est
  refusé avant lecture des identifiants ou accès à la base. Les clients HTTP de
  test doivent donc fournir `Origin` explicitement.
  La comparaison utilise le `Host` reçu par le serveur (sans faire confiance à
  `X-Forwarded-Host`) car Next peut réécrire l'URL interne ; HTTPS est exigé en
  production.
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
draft ──photo──▶ processing ──publier la fiche──▶ ready
  ▲                  │                            │
  └── détourage ──────┘               dépublier ───┘
draft ◀── restaurer ── archived ◀── archiver
```

- Une fiche passe en `ready` avec ses champs commerciaux valides, ses dimensions
  exigées et une photo produit disponible de la même organisation ; sinon
  l’API répond 422. Le statut signifie **publié au catalogue**, pas qualification
  automatique de la visualisation.
- Le détourage est facultatif pour afficher la fiche. La visualisation exige
  séparément un détourage de provenance valide et une préparation actuelle.
  Un état périmé, échoué ou en cours la bloque, même pour un produit publié.
  La préparation peut être relancée sans dépense IA ; il faut vérifier l’aperçu.
- Le champ `visualizationBlockedReason` (texte de 500 caractères maximum,
  nullable) fournit un veto explicite. Un motif non vide bloque Préparer et
  toute nouvelle visualisation boutique, y compris avec un ancien détourage,
  sans dépublier la fiche. Un PATCH qui omet ce champ le préserve ; `null` ou
  une chaîne vide le retire explicitement. Les anciens produits sans ce champ
  n’ont pas de veto supplémentaire. Le motif n’est pas exposé dans le catalogue public.
- Le détourage prépare l’image sans publier la fiche. Seule l’action
  **Publier sur le site** rend le produit et ses images accessibles au public.
- Dépublier ou restaurer remet la fiche en brouillon et privatise toutes ses
  images. Les produits temporaires d’un visiteur restent privés même lorsqu’ils
  sont prêts à être rendus.
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
