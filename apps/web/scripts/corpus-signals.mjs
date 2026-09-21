/**
 * The corpus harness's own judgement, kept apart from its plumbing so it can be
 * tested — PRO-007. A harness that reports a signal wrongly is worse than no
 * harness: it produces confident numbers about the wrong thing.
 */

/**
 * Refuses a case that cannot produce evidence, rather than running it.
 *
 * `provenance.authorisation` is required because "sources autorisées" is the
 * first line of the ticket, and a case without it must never reach a provider.
 */
export function validateCase(item) {
  const problems = [];
  const need = (path, value) => {
    if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
      problems.push(`champ manquant : ${path}`);
    }
  };
  need("id", item?.id);
  need("stratum", item?.stratum);
  need("provenance.authorisation", item?.provenance?.authorisation);
  need("room.file", item?.room?.file);
  need("product.file", item?.product?.file);
  need("product.name", item?.product?.name);
  need("product.dimensionsCm.height", item?.product?.dimensionsCm?.height);
  need("product.dimensionsCm.width", item?.product?.dimensionsCm?.width);
  need("product.dimensionsCm.depth", item?.product?.dimensionsCm?.depth);
  if (!/^[a-zA-Z0-9_-]+$/.test(item?.id ?? "")) problems.push("id : lettres, chiffres, tirets et soulignés uniquement");
  for (const axis of ["width", "height", "depth"]) {
    const value = item?.product?.dimensionsCm?.[axis];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) problems.push(`product.dimensionsCm.${axis} : mesure positive requise`);
  }
  if (!Array.isArray(item?.placements) || item.placements.length < 1) {
    problems.push("placements : au moins un point est requis");
  }
  for (const [index, placement] of (item?.placements ?? []).entries()) {
    if (
      typeof placement?.point?.x !== "number" ||
      typeof placement?.point?.y !== "number" ||
      ![placement?.point?.x, placement?.point?.y].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)
    ) {
      problems.push(`placements[${index}].point : x et y normalisés requis`);
    }
    if (!placement?.dimensionPair?.mode) {
      problems.push(`placements[${index}].dimensionPair : mode requis`);
    }
  }
  return problems;
}

/**
 * Signals a machine can read from one render. None judges whether the image
 * looks right — that is the human column of the report — but each localises a
 * failure to a stage.
 */
export function stageSignals(render, item) {
  const placements = render?.placement?.compositePlacements ?? [];
  const requested = item?.placements ?? [];
  const width = render?.placement?.sceneWidth ?? null;
  const height = render?.placement?.sceneHeight ?? null;
  // A REGRESSION GUARD, not a discovery. The composite anchors at
  // round(x*W), round(y*H) by construction, so this is expected under a pixel;
  // anything else means the placement contract broke. It says nothing about
  // whether the object sits where it physically should — that is the contact
  // point, which only a human looking at the image can judge.
  const anchorErrorPx = placements.map((placement) => {
    const asked = requested[placement.objectIndex]?.point;
    if (!asked || !width || !height) return null;
    return Number(
      Math.hypot(
        placement.baseX - asked.x * width,
        placement.baseY - asked.y * height,
      ).toFixed(2),
    );
  });
  const cutoutSources = render?.audit?.cutoutSources ?? null;
  return {
    // SOURCE — was the cutout the real photo, or one the model invented? A
    // synthesized cutout voids any identity conclusion (audit A03).
    cutoutSources,
    cutoutSynthetic: (cutoutSources ?? []).includes("model"),
    cutoutWarnings: render?.audit?.cutoutWarnings ?? null,
    // SCALE — measured, estimated, or nothing at all?
    scaleSources: render?.audit?.scaleSources ?? null,
    scaleFallbackFired: render?.audit?.scaleFallbackFired ?? null,
    // PLACEMENT
    anchorErrorPx,
    // Null, not true, when there is nothing to check: an empty placement list
    // or a missing frame is an absence of evidence, and "held" would be read
    // as evidence.
    anchorContractHeld: anchorErrorPx.some((value) => value !== null)
      ? anchorErrorPx.every((value) => value === null || value <= 1)
      : null,
    croppedByFrame: placements.map((p) => p.croppedByFrame ?? null),
    overlaps: placements.some((p) => p.overlaps === true),
    // DEFORMATION — the audit's A04, and already computed by the geometry.
    // `dimensionConsistency` is (length/height) / the photographed silhouette's
    // aspect: 1 means the declared dimensions match the photo, and anything far
    // from it means the object is being stretched to fit numbers the photo
    // contradicts. The audit reproduced 2.222 on a rug; nothing surfaced it.
    dimensionConsistency: placements.map((p, i) =>
      normalisedConsistency(p, requested[p.objectIndex ?? i]?.dimensionPair),
    ),
    // A size factor applied on top of the pure cm→px conversion, i.e. the
    // geometry declining to honour the requested size.
    sizeFactor: placements.map((p) => p.sizeFactor ?? null),
    clamped: placements.some((p) => p.clamped === true),
    // What the rendered box actually represents, against what was asked for.
    impliedHeightCm: placements.map((p) => p.impliedHeightCm ?? null),
    heightErrorPct: placements.map((placement) => {
      const pair = requested[placement.objectIndex]?.dimensionPair;
      const asked = pair?.mode === "height_length" ? pair.heightCm : null;
      const got = placement.impliedHeightCm;
      if (!asked || !got) return null;
      return Number((((got - asked) / asked) * 100).toFixed(1));
    }),
    // CLEANUP
    obstaclesRemoved: render?.audit?.obstaclesRemoved ?? null,
    obstaclesSkipped: render?.audit?.obstaclesSkipped ?? null,
    // DELIVERY
    quality: render?.qualityDecision?.status ?? null,
    qualityScore: render?.qualityDecision?.score ?? null,
    creditCharged: render?.creditCharged ?? null,
  };
}

/**
 * Mirrors FLAT_FORESHORTENING in packages/geometry/src/simple-placement.ts.
 * The geometry shrinks a flat object's far side by this factor, so its raw
 * `dimensionConsistency` reads 1/0.45 = 2.22 when the declared dimensions
 * match the photo perfectly. Reported raw, that number looked like the audit's
 * A04 deformation; it is the intended perspective approximation. Normalising
 * by pose makes 1 mean "match" for every kind.
 */
export const FLAT_FORESHORTENING = 0.45;

function normalisedConsistency(placement, dimensionPair) {
  const raw = placement?.dimensionConsistency;
  if (raw === null || raw === undefined) return null;
  const flatFootprint =
    placement.kind === "flat" && dimensionPair?.mode === "length_width";
  return Number((flatFootprint ? raw * FLAT_FORESHORTENING : raw).toFixed(3));
}

/**
 * Failure counts per code, supported perimeter and experimental strata kept
 * apart. The ranking that says "where to put the next effort" is built from
 * the supported perimeter only: an out-of-scope category must not steer it.
 */
export function rankFailures(verdicts) {
  const supported = {};
  const experimental = {};
  for (const verdict of verdicts) {
    const target = EXPERIMENTAL_STRATA.has(verdict.stratum)
      ? experimental
      : supported;
    for (const code of verdict.codes ?? []) {
      target[code] = (target[code] ?? 0) + 1;
    }
  }
  const rank = (counts) => Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return { supported: rank(supported), experimental: rank(experimental) };
}

/**
 * What a run is allowed to claim. Stated first in every report so a synthetic
 * run cannot be filed as a measurement.
 */
export function runClaim({ mockMode, caseCount }) {
  if (caseCount === 0) {
    return "AUCUNE. Le corpus est vide : ce run ne mesure rien.";
  }
  if (mockMode) {
    return "AUCUNE. Le serveur tourne en mode simulé : les images sont synthétiques et ce rapport ne mesure aucune qualité photographique.";
  }
  return "Signaux par étape et coût. La qualité photographique reste à juger par un humain, sur les images conservées.";
}

/**
 * The failure taxonomy, as data rather than prose, so the runner can print it
 * into every verdict sheet and an aggregate can count it. Each code names the
 * STAGE a failure belongs to: the point of phase 0 is to know what to fix, not
 * to describe what looks wrong.
 */
export const FAILURE_CODES = [
  ["source", "source_cutout_synthetic", "Le détourage vient du modèle, pas de la photo : la référence d'identité est inventée"],
  ["source", "source_cutout_amputated", "Le détourage a perdu une partie de l'objet"],
  ["source", "source_photo_unusable", "La photo produit ne permettait pas de travailler"],
  ["échelle", "scale_fallback", "Aucune échelle estimée : repli sur une largeur de pièce supposée"],
  ["échelle", "scale_wrong", "Échelle estimée mais fausse face à la mesure"],
  ["placement", "placement_contract_broken", "Le composite n'a pas respecté l'ancrage demandé"],
  ["placement", "placement_deformed", "Proportions incohérentes avec les dimensions déclarées"],
  ["placement", "placement_cropped", "L'objet sort du cadre sans que ce soit voulu"],
  ["nettoyage", "cleanup_incomplete", "L'objet remplacé est encore visible"],
  ["nettoyage", "cleanup_damaged", "Le nettoyage a abîmé le décor autour"],
  ["harmonisation", "harmony_identity_lost", "Le modèle a modifié le produit"],
  ["harmonisation", "harmony_decor_changed", "Le décor a bougé hors de la zone autorisée"],
  ["harmonisation", "harmony_contact", "L'objet flotte ou s'enfonce"],
  ["harmonisation", "harmony_light", "Lumière ou ombres incohérentes"],
  ["occultation", "occlusion_order", "Un élément du premier plan est passé derrière"],
  ["export", "export_artifact", "Défaut apparu à la recomposition ou à la compression"],
  ["livraison", "quality_false_reject", "Rendu correct refusé par le contrôle"],
  ["livraison", "quality_false_accept", "Rendu défectueux accepté"],
];

/** Strata the audit asks to report separately; `experimental` is out of scope. */
export const EXPERIMENTAL_STRATA = new Set(["experimental"]);

/**
 * The sheet a human fills in for one case. Pre-filled with what the machine
 * saw, empty where only a human can answer — and the two are kept visibly
 * apart, because a stage signal is not a judgement of the image.
 */
export function verdictSheet(record) {
  const s = record.signals ?? {};
  // A signal that was never recorded — a failed or rejected render carries
  // no placement, no audit — must print as absent, not as a confident "non".
  const flag = (value) =>
    value === null || value === undefined ? "—" : value ? "OUI" : "non";
  const machine = [
    `- détourage synthétique : ${flag(s.cutoutSynthetic)}${s.cutoutSynthetic ? "  ← toute conclusion d'identité sur ce cas est sans valeur" : ""}`,
    `- repli d'échelle déclenché : ${flag(s.scaleFallbackFired)} (sources : ${JSON.stringify(s.scaleSources)})`,
    `- contrat de placement tenu : ${flag(s.anchorContractHeld)} (écarts px : ${JSON.stringify(s.anchorErrorPx)})`,
    `- recadrage par le cadre : ${JSON.stringify(s.croppedByFrame)}`,
    `- cohérence dimensions/silhouette : ${JSON.stringify(s.dimensionConsistency)} (normalisée par type de pose : 1 = les dimensions saisies correspondent à la photo ; loin de 1 = objet étiré)`,
    `- taille bridée par la géométrie : ${flag(s.clamped)} (facteurs ${JSON.stringify(s.sizeFactor)})`,
    `- écart de hauteur rendue vs demandée : ${JSON.stringify(s.heightErrorPct)} %`,
    `- obstacles supprimés / ignorés : ${s.obstaclesRemoved} / ${s.obstaclesSkipped}`,
    `- décision qualité : ${s.quality} (score ${s.qualityScore ?? "—"}), crédit débité : ${flag(s.creditCharged)}`,
  ].join("\n");
  const codes = FAILURE_CODES.map(
    ([stage, code, label]) => `- [ ] \`${code}\` — ${stage} : ${label}`,
  ).join("\n");
  const synthetic = record.engineVersions?.mockMode;
  return `# Verdict — ${record.caseId}

Strate : ${record.stratum}
Moteur : ${JSON.stringify(record.engineVersions)}
${synthetic ? "\n> **RUN SIMULÉ.** Les images sont synthétiques. Ne remplissez pas ce verdict : il ne mesurerait rien.\n" : ""}
## Ce que la machine a vu

${machine}

## Ce que seul vous pouvez dire

Utilisable sans retouche ? (oui / non)  →

Si non, cochez chaque étape qui a échoué, et écrivez la phrase qui le justifie :

${codes}

Justification :

Attendu au départ : ${record.expectation ?? "—"}
`;
}

/**
 * Acceptance by stratum. Experimental strata are counted apart, never folded
 * into an average — the audit is explicit that their failures must not vanish
 * into one.
 */
export function aggregate(verdicts) {
  const buckets = new Map();
  for (const verdict of verdicts) {
    const key = verdict.stratum ?? "inconnu";
    const bucket = buckets.get(key) ?? { stratum: key, total: 0, usable: 0, codes: {} };
    bucket.total += 1;
    if (verdict.usable === true) bucket.usable += 1;
    for (const code of verdict.codes ?? []) {
      bucket.codes[code] = (bucket.codes[code] ?? 0) + 1;
    }
    buckets.set(key, bucket);
  }
  const all = [...buckets.values()];
  const supported = all.filter((b) => !EXPERIMENTAL_STRATA.has(b.stratum));
  const total = supported.reduce((n, b) => n + b.total, 0);
  const usable = supported.reduce((n, b) => n + b.usable, 0);
  return {
    // The count, not only the rate: a rate over three cases is not a rate.
    supported: { cases: total, usable, rate: total ? usable / total : null },
    experimental: all.filter((b) => EXPERIMENTAL_STRATA.has(b.stratum)),
    byStratum: all,
  };
}
