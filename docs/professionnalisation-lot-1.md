# Professionnalisation — lot 1 : intégrité des rendus

Date : 6 septembre 2026. Implémentation locale, sans déploiement ni appel IA payant de validation.

Ce lot réalise une première partie de la phase 1 du [plan audité](audit-plan-professionnalisation-2026-09-05.md). Il conserve les modifications qui existaient avant le démarrage. Il ne clôture ni la professionnalisation ni la phase 1 complète.

## Changements

### Requête sauvegardée et nouvelle tentative — PRO-001

Chaque nouveau rendu conserve `requestSnapshot.version=1` et une copie détachée de ses paramètres normalisés : workflow, objets, points, dimensions, type de pose, échelle utilisateur, calibration, lumière et options. La finalisation ne réécrit pas cette copie. Le endpoint de retry repart de cette requête avec une nouvelle clé de longueur bornée, au lieu de reconstruire une demande mono-objet à partir d'un placement déjà transformé. Il passe désormais par le même quota que la création.

Les anciens rendus simples sont reconnus par les placements sauvegardés ou la version de prompt. Un ancien contrat incomplet ou une version de snapshot inconnue renvoie une erreur explicite. Les actifs produits et la configuration fournisseur ne sont pas encore figés par hash : la requête est rejouable, sans promesse d'image identique ni de reconstruction de toutes les anciennes versions du catalogue.

Code : `render-request.ts`, `rendering.ts`, `api.ts`, `types.ts`.

### Contrôle obligatoire avant livraison — PRO-002

Les parcours utilisent une décision partagée `accepted`, `rejected`, `unavailable` ou `simulated`. Une réponse absente, mal formée ou indisponible ne reçoit plus un score fictif de 90 %. Une simulation est explicitement identifiée et n'a aucun score de fidélité.

Le parcours public relit le composite final avec la scène et toutes les photos originales des produits, après recomposition. Il vérifie identité, présence de chaque objet, absence de doublon, décor, perspective, contact, réalisme et suppression de l'ancienne cible le cas échéant. Un bon score global ne compense plus un critère critique négatif. Une réponse Google incomplète ne reçoit plus de valeurs positives par défaut. Lors d'une réparation du parcours standard, une image acceptée prime sur une image mieux notée mais défectueuse.

Le résultat n'est publié et le crédit n'est capturé qu'après acceptation (ou simulation explicitement autorisée). En cas de rejet ou d'indisponibilité, l'aperçu déterministe reste disponible, le rendu est marqué en échec et la décision est conservée. Les aperçus intermédiaires standard sont désormais séparés de l'image finale. Les interfaces distinguent l'aperçu non validé et la simulation.

Il s'agit encore d'un contrôle visuel par modèle : il ne prouve pas les centimètres, ne garantit pas l'absence de faux négatifs et ne remplace pas le corpus photographique du plan. Une indisponibilité est aujourd'hui terminale pour cette tentative ; la reprise du contrôle seul, sans nouvelle génération, reste à construire.

Code : `render-quality.ts`, `rendering.ts`, schémas partagés et studios.

### Arrêt, suppression et finalisation — PRO-003, première étape

Les mises à jour de progression sont conditionnelles : elles ne peuvent plus faire repasser un rendu annulé, supprimé ou terminal en traitement. La finalisation acquiert un jeton atomique sur le document avant le débit. Une seule exécution peut acquérir ce jeton.

- Si l'annulation ou la suppression gagne, la génération tardive ne livre pas de résultat et ne débite pas de crédit.
- Si la finalisation a déjà acquis le jeton, la demande d'arrêt concurrente reçoit un conflit explicite ; elle n'est pas annoncée comme acceptée.
- Une seconde exécution ne peut pas reprendre la finalisation ni modifier son état au travers d'une progression ordinaire.
- Les erreurs du parcours simple synchrone sont maintenant persistées ; elles ne laissent plus systématiquement le document en traitement.

Cette exclusion mutuelle est limitée au document de rendu. Elle ne rend pas atomiques le wallet, son journal, le stockage de l'image et le résultat : PRO-004 reste nécessaire. Un arrêt brutal du processus après acquisition du jeton nécessite encore un mécanisme durable de reprise/rapprochement. Le jeton et sa date sont conservés pour ce travail. Un appel fournisseur déjà parti n'est pas physiquement interrompu par l'annulation.

Code : `render-lifecycle.ts`, `rendering.ts`, `api.ts`.

### Obstacles — partie d'A08

Une inspection indisponible, une zone incohérente ou une suppression qui échoue arrête désormais le parcours simple. Le système ne continue plus en plaçant le produit sur l'obstacle après ces erreurs. Le choix Ajouter/Remplacer et la correction du masque restent à réaliser ; le masque rectangulaire et le déclenchement automatique du nettoyage ne sont pas remplacés par ce lot.

### Tests indépendants de la configuration personnelle

Playwright démarre une instance dédiée, attend la santé de l'API et utilise une base de test explicitement configurée (`E2E_MONGODB_URI`, sinon MongoDB local). Les accès aux fournisseurs IA et à Cloudinary sont neutralisés par de vraies chaînes vides. L'ancienne `NEXT_PUBLIC_API_URL` locale ne détourne plus les requêtes des tests. Les sélecteurs du parcours simple ont été réconciliés avec le choix actuel de type de pose.

## Vérification

Les tests d'intégrité couvrent les réponses qualité invalides, critères critiques malgré un score élevé, simulation, replay à trois objets, paramètres anciens incomplets, annulation pendant génération, concurrence pendant capture, double finalisation et erreurs de nettoyage. Les courses sont contrôlées avec des opérations documentaires atomiques simulées ; les parcours navigateur utilisent MongoDB réel en local.

Validation locale terminée le 6 septembre 2026 :

- `npm test` : 181 tests réussis (37 géométrie, 17 routeur IA, 6 schémas, 121 application).
- `npm run test:e2e -- --max-failures=1` : 18 parcours réussis, 9 desktop et 9 mobile, avec MongoDB local et fournisseurs simulés.
- `npm run lint` : réussi, sans avertissement ESLint.
- `npm run typecheck` : réussi sur les workspaces.
- `npm run build` : compilation de production réussie, 19 pages statiques générées.
- `git diff --check` : aucune erreur d'espacement.

Le test de placement utilise maintenant des coordonnées relatives à l'image pour fonctionner sur les deux tailles d'écran. Aucun résultat de génération réelle ni comportement en production n'est revendiqué.

## Suite prioritaire

1. PRO-005 : séparation des uploads privés et du catalogue publié, contrôle d'expiration et tests inter-session.
2. PRO-004 et orchestration durable : réservation des crédits, transaction/réconciliation, reprise des finalisations et gestion des travaux abandonnés.
3. PRO-006/007 : traces par étape et premiers cas photographiques autorisés, avec mesures et références.
4. Détourage fidèle, calibration des plans, occultations et intégration lumineuse selon les phases suivantes.

La baseline de l'audit du 5 septembre reste historique ; les changements ci-dessus ne doivent pas être interprétés comme déjà présents lors de ses mesures.
