# Mesure du parcours ByLiliDeco

Le navigateur met en file les étapes utiles après accord. Il tente au maximum deux envois par onglet et par visite de 30 minutes, avec 20 événements et 12 Kio par lot. Le premier envoi est déclenché à l’ouverture du formulaire ou lorsque l’onglet devient invisible. La demande enregistrée ou la fermeture de la page peut déclencher le second. Les répétitions d’un même événement pour un article ou une catégorie sont fusionnées. La collecte s’arrête au retrait du consentement.

Vercel authentifie chaque lot transmis au Worker Cloudflare. La route de mesure et le Worker utilisent zéro connexion MongoDB. Cloudflare limite la fréquence des lots, avec une clé calculée à partir de l’adresse fournie par Vercel lorsqu’elle est disponible. Le Worker utilise cette clé uniquement pour la limitation et ne l’écrit pas dans Analytics Engine. Les lots excluent les champs du formulaire, la référence de demande, le texte des recherches, les photos, l’adresse IP et les URL complètes.

## Activer Cloudflare

1. Dans le compte Cloudflare de la boutique, autoriser Workers et Analytics Engine. Analytics Engine crée le jeu de données `lilideco_storefront_events` à la première écriture.
2. Depuis la racine du dépôt, se connecter au bon compte et déployer le Worker.

   ```sh
   npx wrangler@4.168.0 login
   npx wrangler@4.168.0 deploy --config infra/storefront-analytics/wrangler.jsonc
   npx wrangler@4.168.0 secret put STOREFRONT_ANALYTICS_WRITE_TOKEN --config infra/storefront-analytics/wrangler.jsonc
   ```

   Générer un secret aléatoire avec `openssl rand -hex 32`. Entrer la même valeur dans les deux réglages sécurisés, Cloudflare et Vercel.

3. Dans le projet Vercel de la boutique, définir `STOREFRONT_ANALYTICS_WORKER_URL` avec l’origine HTTPS affichée par Wrangler et `STOREFRONT_ANALYTICS_WRITE_TOKEN` avec le secret. Relancer le déploiement.
4. Dans un navigateur, accepter uniquement la mesure d’audience, ouvrir une catégorie et un article, puis passer à un autre onglet. L’onglet Réseau doit montrer un `POST /api/storefront/measure` avec un statut 204. Dans Cloudflare, les lignes `catalogue_viewed`, `category_selected` et `product_viewed` doivent partager le même identifiant de visite. Refaire le parcours après un refus pour vérifier l’absence de requête de mesure.

Le Worker attend uniquement le chemin `/collect`. Pour suspendre la mesure, retirer l’URL du Worker sur Vercel et redéployer. Cloudflare conserve les points pendant trois mois. [Configuration Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/get-started/) · [Rétention](https://developers.cloudflare.com/analytics/analytics-engine/limits/)

## Rapports dans Analytics Engine

| Champ            | Valeur                                                                  |
| ---------------- | ----------------------------------------------------------------------- |
| `index1`         | Identifiant aléatoire de visite                                         |
| `blob1`          | Étape du parcours                                                       |
| `blob2`          | Canal parmi `direct`, `organic`, `social`, `paid-social`, `other`       |
| `blob3`, `blob4` | Catégorie et article du catalogue si applicables                        |
| `blob5`, `blob6` | Écran petit ou large et tranche de quantité à l’ouverture du formulaire |
| `double1`        | Numéro du lot pendant la visite                                         |

Comparer les visites par étape et canal sur 28 jours. Le comptage distinct évite de compter deux fois une visite à la même étape, y compris si elle ouvre plusieurs articles.

```sql
SELECT
  blob2 AS canal,
  blob1 AS etape,
  count(DISTINCT index1) AS visites_mesurees
FROM lilideco_storefront_events
WHERE timestamp >= NOW() - INTERVAL '28' DAY
GROUP BY blob2, blob1
ORDER BY canal, etape
```

Identifier les articles consultés et ajoutés au panier. Pour les catégories, grouper par `blob3` et filtrer sur `category_selected`.

```sql
SELECT
  blob3 AS categorie,
  blob4 AS article,
  blob1 AS etape,
  count(DISTINCT index1) AS visites_mesurees
FROM lilideco_storefront_events
WHERE timestamp >= NOW() - INTERVAL '28' DAY AND blob4 != ''
GROUP BY blob3, blob4, blob1
ORDER BY visites_mesurees DESC
LIMIT 100
```

Ces rapports décrivent les visites ayant donné leur accord dont les lots sont arrivés. Si Cloudflare échantillonne les points et que `_sample_interval` dépasse 1, les visites distinctes deviennent partielles. Le back-office reste la source du total des demandes enregistrées. Les bilans par jour utilisent les dates UTC du jeu de données. [API SQL Cloudflare](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/)

## Relier Meta Ads

1. Dans Meta Events Manager, préparer la source de données Web ByLiliDeco et relever son identifiant Pixel ou Dataset. Garder les événements automatiques et la correspondance avancée automatique désactivés. Il n’y a qu’une installation Pixel à maintenir.
2. Définir `STOREFRONT_META_PIXEL_ID` sur Vercel et redéployer. Le script Meta se charge après le consentement publicitaire, indépendant du choix Analytics Engine.
3. Dans **Test Events**, autoriser la mesure publicitaire et ouvrir une fiche. Vérifier `PageView` puis `ViewContent`. Un ajout accepté déclenche `AddToCart` et l’ouverture d’un formulaire disponible déclenche `InitiateCheckout`. Pour un essai de demande, convenir avec la boutique d’un test qui arrivera dans la boîte de commandes. Une demande enregistrée déclenche un seul `Lead` avec un identifiant stable `lead:<clé d’idempotence>`. C’est l’événement à sélectionner pour les campagnes de demandes.
4. Pour les liens des annonces Facebook et Instagram, utiliser `utm_source=facebook` ou `utm_source=instagram` et `utm_medium=paid_social`. La mesure d’audience les regroupe dans `paid-social`.

L’activation du Pixel attend l’identifiant Meta. Toute intégration future de la Conversions API devra réutiliser le même événement `Lead` et le même identifiant pour dédupliquer les deux livraisons. Vérifier la réception dans **Test Events** avant de s’appuyer sur les chiffres publicitaires. [Conversion Tracking](https://github.com/coreyhaines31/marketingskills/tree/main/skills/conversion-tracking)
