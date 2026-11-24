# ByLiliDeco · Plan SEO et mesure du parcours client

Relevé du 24 novembre 2026. L’objectif est d’attirer des acheteurs en Tunisie sur les collections de la boutique et de mesurer les demandes de commande qui en résultent.

## Ce que le site sert aujourd’hui

| Point contrôlé | Résultat |
| --- | --- |
| Catalogue public | 17 fiches avec descriptif et prix, 10 catégories disponibles dans le filtre |
| Collections avec des produits | 12 coffrets cadeaux, 3 vases et cache-pots, 2 sculptures et objets déco |
| Sitemap | 20 URL, dont 17 fiches produit et 17 entrées d’image. Les catégories sont accessibles par le filtre. |
| Exemple de catégorie | `/?categorie=coffrets-cadeaux` répond 200, avec `noindex, follow` et une canonique vers l’accueil. |
| Exemple de fiche | Le coffret Chéchia Tounsi a une page 200, sa propre canonique, un titre, un descriptif et des données structurées `Product`. Sa photo principale pèse environ 169 Ko en WebP. |
| Parcours existant | La boutique enregistre des demandes de commande qui sont ensuite confirmées avec le client. |

L’accueil utilise `fr-TN` et présente ByLiliDeco comme boutique de décoration, d’artisanat et de cadeaux en Tunisie. Le sitemap déclare les fiches et leurs photos. Les impressions, clics et pages réellement indexées sont à mesurer dans Search Console. [Catalogue public](https://lilidecoai-web.vercel.app/api/storefront/products) · [Sitemap](https://lilidecoai-web.vercel.app/sitemap.xml) · [Robots](https://lilidecoai-web.vercel.app/robots.txt)

## Comparaison avec les boutiques tunisiennes

Le réseau de cette session a refusé les requêtes vers Google, Bing, DuckDuckGo, `interieurs.com.tn` et `decoshop.tn` avant l’accès aux sites. Le relevé concurrentiel reste à compléter avec l’accès HTTPS aux pages publiques ou des captures des pages, des résultats de recherche et du contenu des sitemaps. Les actions ci-dessous s’appuient sur l’audit de ByLiliDeco et proposent des tactiques à confronter au marché.

| Recherche en Tunisie à tester sur mobile | Concurrence à retenir | Preuves à relever et tactique à adapter |
| --- | --- | --- |
| `coffret cadeau artisanal tunisie`, `coffret céramique raku tunisie` | Deux boutiques de cadeaux ou d’artisanat présentes dans les résultats organiques | Page exacte qui ressort, titre, H1, lien depuis l’accueil, produits et usages montrés. Si une collection dédiée ressort, reprendre cette structure pour les coffrets ByLiliDeco avec ses propres photos et descriptions. |
| `vase céramique tunisie`, `cache-pot artisanal tunisie` | Une boutique spécialisée en décoration ou céramique présente dans les résultats | URL de catégorie et de produit, matière, dimensions, prix en TND, disponibilité, livraison et maillage entre fiches. Adapter les informations utiles aux pièces ByLiliDeco. |
| `sculpture artisanale décoration tunisie` | Un artisan ou une boutique d’objets déco avec une offre comparable | Manière de présenter l’auteur, les inspirations et le savoir-faire. Donner des preuves équivalentes lorsque la boutique dispose des faits et photos. |

Pour chaque boutique retenue, relever à la même date une catégorie et une fiche produit. Noter la requête, le titre, la canonique, l’indexabilité, les liens internes, les données structurées visibles après rendu et les conditions commerciales affichées. Une position observée constitue un relevé ponctuel. Les stratégies retenues doivent être adaptées au catalogue, au stock et à la façon de commander chez ByLiliDeco. [SEO Audit](https://github.com/coreyhaines31/marketingskills/tree/main/skills/seo-audit)

## Plan SEO sur quatre semaines

| Quand | Action | Résultat attendu et contrôle |
| --- | --- | --- |
| Semaine 1 | Vérifier la propriété Search Console de l’origine publique et soumettre le sitemap. Inspecter l’accueil, deux fiches et une URL filtrée. | Exporter une référence sur 28 jours pour les impressions, clics, CTR et pages indexées. Vérifier les canoniques choisies par Google. |
| Semaine 1 | Créer `/categories/coffrets-cadeaux` et `/categories/vases-cache-pots` à partir des catégories MongoDB. Utiliser une URL et une canonique stables, un titre et un H1 propres, une introduction courte qui décrit la collection et des liens HTML vers les articles. | Les deux URL répondent 200, figurent dans le sitemap et sont atteignables depuis l’accueil. Le filtre multi-critères garde sa fonction de navigation. |
| Semaine 2 | Relire les 17 fiches. Commencer par les coffrets et les vases. Mettre les différences utiles dans le titre et le descriptif, notamment la technique, le motif, la matière, les dimensions et ce que contient le coffret. Ajouter un lien vers la catégorie et vers des articles complémentaires. | Titres et descriptions distincts. Les liens et caractéristiques sont présents dans le HTML de la fiche et lisibles sur téléphone. |
| Semaine 2 | Donner sur chaque catégorie un accès clair au parcours de demande de commande et aux modalités de contact. Afficher les zones et délais de livraison, les retours et les options cadeaux lorsque la boutique les a confirmés. | L’acheteur sait à quoi s’attendre en ouvrant le panier. Les informations affichées correspondent au processus réellement utilisé par la boutique. |
| Semaine 3 | Tester sur mobile les deux catégories et deux fiches. Prévoir des variantes de largeur pour les photos publiques, réserver leur espace et différer les images sous la ligne de flottaison. Éviter le second chargement immédiat du catalogue côté client lorsque la page a déjà reçu ses données serveur. | Comparer le poids transféré, les requêtes d’images et les lectures du catalogue avant et après. Viser au 75e percentile LCP ≤ 2,5 s, INP ≤ 200 ms et CLS ≤ 0,1 lorsque les mesures terrain sont disponibles. |
| Semaine 4 | Contrôler les données `Product` et ajouter `BreadcrumbList` aux nouvelles pages. Étudier `Offer` au regard des règles Google et des prix, stocks et conditions réellement proposés. Publier ensuite un guide d’achat, par exemple pour choisir un coffret en céramique à offrir. | Le balisage reflète les informations visibles et validées. Le guide dirige vers la collection et comporte des conseils originaux tirés des pièces vendues. |

La page Sculptures & Objets Déco sera prioritaire quand elle réunira assez de pièces et de contenu pour aider un acheteur à choisir. Ajouter au sitemap les catégories dont le contenu et l’assortiment justifient une page de recherche. Conserver les identifiants des fiches comme références stables. Une réécriture future des URL produit doit inclure des redirections permanentes, une mise à jour des liens internes et des canoniques. [Guide Google pour l’e-commerce](https://developers.google.com/search/docs/specialty/ecommerce) · [Core Web Vitals](https://web.dev/articles/vitals)

Mettre en cache les données du catalogue public pendant une fenêtre courte, par exemple 60 secondes, et invalider cette entrée lorsqu’une fiche est publiée, archivée ou déplacée dans une catégorie. Alimenter l’accueil, les pages de catégorie et le sitemap avec la même lecture. Les photos publiques peuvent recevoir des variantes de taille distinctes selon l’écran, à partir du WebP des nouveaux imports.

Après 28 jours complets, comparer des fenêtres de même durée dans Search Console. Examiner d’abord les requêtes qui ont déjà des impressions. Ajuster les titres des pages dont le CTR déçoit à position comparable et renforcer le contenu des pages qui se rapprochent de la première page. Utiliser les demandes enregistrées comme mesure commerciale.

## Plan pour mesurer le parcours sans charger Atlas

### Décisions à éclairer

| Événement | Déclenchement | Données utiles | Décision |
| --- | --- | --- | --- |
| `catalogue_viewed` | Première ouverture du catalogue pendant la visite | Canal parmi `organic`, `social`, `direct`, `other` | Identifier quel canal amène les acheteurs intéressés |
| `category_selected` | Sélection explicite dans le filtre ou ouverture d’une page de catégorie | Identifiant de catégorie | Prioriser les collections recherchées |
| `product_viewed` | Fiche ou aperçu réellement ouvert, une fois par produit et par visite | Identifiant produit, catégorie | Repérer les pièces à mettre en avant |
| `cart_item_added` | Premier ajout confirmé pour un produit pendant la visite | Identifiant produit, catégorie | Comparer intérêt et intention de commande |
| `checkout_started` | Ouverture du formulaire avec un panier | Nombre d’articles par tranche | Repérer un décrochage après le panier |
| `order_request_recorded` | Confirmation serveur `recorded: true` | Événement seul, une fois par visite mesurée | Mesurer le passage du formulaire à la demande enregistrée |

Le tableau commercial prend le nombre de demandes depuis les données déjà enregistrées dans le back-office. Les taux du parcours consentant comparent des visites de la même période et de la même cohorte. La couverture des lots reste partielle en cas de refus ou de fermeture brusque d’un onglet. [Analytics Tracking](https://github.com/coreyhaines31/marketingskills/tree/main/skills/analytics)

### Trajet des données et budget de requêtes

```text
Navigateur → lot léger → endpoint de mesure → Worker Cloudflare → Analytics Engine
Demande commerciale → enregistrement de commande existant → back-office
```

1. Activer la mesure après un choix explicite. Mettre à jour la politique de confidentialité avant l’activation. Une fois le consentement donné, utiliser un identifiant de visite aléatoire de 30 minutes dans `sessionStorage`. Effacer la file et l’identifiant au retrait du consentement.
2. Mettre les événements utiles en file. Fusionner dans la visite les répétitions du même événement pour le même produit ou la même catégorie. Autoriser uniquement les identifiants du catalogue, une liste fermée de canaux et des compteurs bornés. Les formulaires, recherches libres, URL intégrales, photos et coordonnées restent dans leurs parcours fonctionnels.
3. Envoyer jusqu’à 20 événements et 12 Ko par lot, au maximum deux envois par visite. Envoyer quand le visiteur ouvre le formulaire ou quand la page devient invisible. Utiliser `fetch` avec `keepalive` ou `sendBeacon`, et empêcher les doubles envois `visibilitychange` et `pagehide` avec un identifiant de lot. Conserver la confirmation de demande avant les événements de curiosité lorsque la file est pleine.
4. Configurer une route légère et un Worker avec schéma fermé, taille maximale, contrôle d’origine et limitation des abus en périphérie. Le Worker enregistre les points dans Analytics Engine et déduplique les lots au moment de produire les agrégats. La route et le Worker ne dépendent d’aucun client MongoDB. Fixer les rapports à partir d’agrégats par jour et par catégorie. Analytics Engine annonce trois mois de rétention pour les points. [Configuration Cloudflare](https://developers.cloudflare.com/analytics/analytics-engine/get-started/) · [Limites et rétention](https://developers.cloudflare.com/analytics/analytics-engine/limits/)
5. Si le back-office doit afficher ce tableau, synchroniser uniquement les totaux une fois par jour avec un `updateOne` idempotent par jour. Le traitement planifié utilise le client MongoDB partagé et une rétention bornée pour les agrégats. Le tableau lit une plage de jours en une requête et sert le résultat en cache.

Exemple pour dimensionner le budget. Avec 100 visites qui génèrent six événements chacune, une collecte par événement ferait 600 requêtes. Le budget proposé plafonne les envois navigateur à 200 pour ces visites et les connexions MongoDB de la collecte à zéro.

### Vérification avant lancement

| Contrôle | Critère d’acceptation |
| --- | --- |
| Requêtes navigateur | Le parcours catégorie → fiche → panier → confirmation émet au plus deux lots par visite. Un aller-retour sur un autre onglet ne renvoie pas le même lot. |
| Refus de la mesure | Le scénario de refus garde une file vide et zéro requête de mesure. |
| Données | Inspecter le corps d’un lot fictif et le point stocké. Ils respectent la liste fermée des champs. |
| Résilience | Le catalogue et la demande restent utilisables lorsque le Worker est indisponible. Les échecs de mesure n’entraînent pas de boucle de renvoi. |
| MongoDB | Le point d’entrée de mesure reste opérationnel en test avec MongoDB déconnecté. Dans Atlas, comparer les connexions du primaire pendant deux fenêtres de trafic comparables autour du déploiement. |
| Commerce | Une demande confirmée compte une seule fois dans le back-office. Le tableau de mesure affiche la taille de la cohorte et les étapes dédupliquées. |

Le chemin `/v1/analytics` du visualiseur ouvre actuellement le client partagé et insère un document par envoi. Le plan de mesure de la boutique utilise le Worker. L’app Vercel limite aujourd’hui son pool MongoDB à quatre connexions de travail par instance et par serveur. La séparation du stockage des mesures évite que les ouvertures de fiches et les clics alimentent ce pool. [Route actuelle](../apps/web/lib/server/api.ts) · [Pool MongoDB](../apps/web/lib/server/mongodb.ts) · [Politique de confidentialité](https://lilidecoai-web.vercel.app/privacy)
