# Sécurité et confidentialité

## Déjà appliqué

- détection réelle du format via Pillow, indépendamment de l’extension ;
- JPEG, PNG et WebP uniquement, taille et résolution configurables ;
- réencodage sans EXIF ;
- séparation stricte des requêtes par `organization_id` ;
- JWT Supabase HS256 validé côté serveur hors mode démo ;
- rôles marchand et administration ;
- CORS restrictif et aucun credential cross-origin ;
- URLs signées HMAC et expirables hors mode démo ;
- clés IA/paiement uniquement serveur ;
- portefeuille non négatif, réservation/capture/libération idempotentes ;
- webhook Konnect HMAC et attribution unique des crédits ;
- limitation de débit locale, en-têtes de sécurité et journaux sans photo ;
- consentement requis et purge des scènes expirées sous 24 h ;
- payload analytics limité et rejet explicite de `data:image`.

Le mode démo accepte des headers de tenant uniquement parce qu’il est
explicitement local. `DEMO_MODE=false` supprime ce chemin et exige un Bearer JWT
ainsi qu’une membership persistée.

## Production

1. Remplacer `SIGNED_URL_SECRET`.
2. Configurer `SUPABASE_JWT_SECRET`, PostgreSQL TLS et les rôles DB.
3. Mettre les assets privés dans R2, avec URLs présignées courtes.
4. Remplacer le rate limiter mémoire par Redis partagé.
5. Configurer une CSP avec les origines exactes du widget.
6. Définir la signature Konnect selon le compte marchand réel et rejouer les
   webhooks en staging.
7. Activer Sentry avec filtrage des données et une politique PostHog sans media.
8. Programmer `python services/api/scripts/purge.py` au minimum chaque heure.

Les routes utilisent des Bearer tokens, pas des cookies de session ; la
protection CSRF n’est donc pas le mécanisme principal. Si une couche web adopte
des cookies, ajouter `SameSite`, token CSRF et validation d’Origin avant
activation.

## Dépendances amont

Au 30 juillet 2026, `npm audit --omit=dev` signale `postcss@8.4.31` et
`sharp@0.34.5`, embarqués par la dernière version stable `next@16.2.12`. Le
correctif automatique proposé rétrograde Next vers une version incompatible et
la branche corrigée disponible est encore `preview`. Le MVP garde donc la
dernière stable, n’accepte aucune CSS non fiable au build et désactive
l’optimisation Next/Image (Sharp n’est pas dans le chemin d’exécution). Mettre à
jour Next dès la publication d’une stable embarquant PostCSS 8.5.18+ et Sharp
0.35+.
