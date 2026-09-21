# Exécution du plan image — 21 septembre 2026

Les fondations logicielles L0/L1/L2 sont implémentées localement et les limites
du parcours sont corrigées en L6. **Le plan complet L0–L7 n'est pas validé.**
Le corpus contient zéro cas réel autorisé avec fichiers ; `.env` ne contient
pas d'accès OpenAI, Google, MongoDB distant ou Cloudinary utilisable. Aucune
génération payante, comparaison photographique ou mise en production n'a eu lieu.

| Lot | Livré dans ce lot | Reste nécessaire |
| --- | --- | --- |
| L0 | Isolation explicite des expériences conservées ; scripts reproductibles ; build de production vérifié | Accès aux modèles, édition réelle avec masque, analyse réelle et version candidate isolée des travaux locaux préexistants |
| L1 | Validation des sources, empreintes des photos/paramètres, splits pilote/réglage/réservé, comparaison aveugle à deux évaluateurs avec arbitrage | Fournir les 20 photos pilotes et leurs mesures, effectuer les deux campagnes réelles, étendre à 120 dont 30 réservées |
| L2 | Worker séparé sur MongoDB pour `simple_point` et `standard`, requête et masque confirmé figés, baux et jetons, checkpoints privés, reprises bornées, crédits/finalisation transactionnels, annulation et expiration | Hébergement du worker, essais fournisseurs réels et charge mesurée |
| L3 | Garde-fous existants de provenance et de fidélité conservés | Comparer des segmentations spécialisées sur L1 ; outil de correction de masque et qualification des matières difficiles |
| L4 | Le curseur est étiqueté comme ajustement visuel et l'analyse de photo comme estimation, sans attestation de calibration physique | Contrat de référence métrique complet, projection des surfaces à quatre points, sélection de vues et occultants |
| L5 | Reprise sur la composition figée ; candidat conservé pendant une panne de contrôle | Comparaison des ombres/lumières et réparations ciblées fondée sur le pilote |
| L6 | Attente/reprise/contrôle distingués ; aperçu conservé ; le parcours Ajouter ne supprime plus un obstacle par déduction | Parcours simple Remplacer avec masque confirmé, mesures des faux accords/refus et correction de détourage |
| L7 | Bascule explicite, empreinte de révision et procédure de drainage/rollback documentées | Charge nominale et ×2, comparaison réservée, alertes hébergées et déploiement progressif |

## Livrables techniques

- [Exploitation du worker](../infra/render-worker.md) et Dockerfile dédié.
- `npm run worker:render` : processus séparé pour `simple_point` et `standard`.
- `npm run test:durable` : injections de panne et courses applicatives.
- `npm run test:durable:integration` : transactions sur un replica set temporaire.
- `npm run test:e2e:isolated` : navigateur et base MongoDB isolée.
- `npm run corpus:validate` : refuse une population manquante/invalide.
- `npm run corpus:compare` : préparation aveugle et agrégation indépendante.

Le moteur durable reste désactivé par défaut. Les produits et images d'origine
restent autoritaires ; aucune qualité inférieure n'est substituée. Une panne
du juge ne devient jamais une livraison. Les coûts restent des estimations
issues des adaptateurs, pas des factures rapprochées. Une coupure avant
journalisation peut laisser un coût inconnu associé au checkpoint `running`.

## Vérifications locales

- `npm test` : 402 tests unitaires passants (335 web, 44 géométrie, 17 routeur,
  6 types). Les tests nécessitant un replica set sont exécutés séparément.
- `npm run test:durable` : 20 cas de reprise et de courses passants, inclus dans
  les 402 tests ; ils utilisent des doubles de stockage.
- `npm run test:durable:integration` : 22 tests passants sur un vrai replica set
  MongoDB temporaire, dont course annulation/finalisation, récupération de bail,
  protection des réservations longues et pipelines complets **simulés**.
  Les appels HTTP OpenAI/Google sont simulés : reprise du juge sans nouvelle
  image, 429 sans reprise interne, réponse perdue sans répétition, annulation
  pendant la génération, masque confirmé figé ou expiré, réparation déjà
  payée contrôlée près de l'échéance. Les deux formats de masque RGBA sont
  relus depuis les checkpoints privés sans perte.
- `npm run test:e2e:isolated` : 22 parcours passants, Chromium desktop et WebKit
  en profil iPhone, sur une base temporaire et des images synthétiques.
  Le parcours standard teste également la transition `queued` vers `succeeded`
  avec réponses de livraison retardées par Playwright ; ce test ne lance pas
  de worker réel dans le navigateur.
- `npm run lint`, `npm run typecheck`, `npm run build` et `git diff --check` :
  passants. La compilation a nécessité l'accès réseau aux polices Google.
- `npm run corpus:validate` : retourne volontairement le code 2 ; zéro cas
  photographique disponible, aucune population pilote ou réservée validée.

Ces résultats couvrent le code et les scénarios listés. Ils ne mesurent ni le
photoréalisme, ni les coûts facturés, ni la latence réelle d'un fournisseur.

## Dépendances externes à réunir

Fournir une configuration de préproduction (hors Git), un hébergement persistant
pour le worker et les photos autorisées avec mesures. Le choix de segmentation,
les seuils du juge, le nombre utile de candidats et les objectifs de latence
restent à décider à partir des mesures. Le document de plan conserve toutes
les portes de lancement ; aucune n'est déclarée franchie sur des images simulées.
