import { z } from "zod";
const humanSchema = z
  .object({
    acceptable: z.boolean(),
    majorDesignDefect: z.boolean(),
    majorBackgroundDefect: z.boolean(),
  })
  .strict();
export const spatialQualificationSchema = z
  .object({
    version: z.literal(1),
    cases: z
      .array(
        z
          .object({
            id: z.string().min(1),
            family: z.string().min(1),
            holdout: z.boolean(),
            human: humanSchema.nullable(),
            outcome: z.enum([
              "delivered",
              "rejected",
              "clarification",
              "unavailable",
              "not_run",
            ]),
            calibrated: z.boolean(),
            reference: z.string().min(1).nullable(),
            projectedDimensionError: z.number().nonnegative().nullable(),
            durationMs: z.number().nonnegative().nullable(),
          })
          .strict(),
      )
      .refine(
        (cases) => new Set(cases.map((item) => item.id)).size === cases.length,
        "Duplicate case IDs",
      ),
  })
  .strict();

const imageEvidenceSchema = z
  .object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const spatialQualificationV2Schema = z
  .object({
    version: z.literal(2),
    campaign: z.string().min(1),
    engineVersion: z.string().regex(/^spatial-v[1-9][0-9]*$/),
    cases: z
      .array(
        z
          .object({
            id: z.string().min(1),
            family: z.string().min(1),
            holdout: z.boolean(),
            outcome: z.enum([
              "delivered",
              "rejected",
              "clarification",
              "unavailable",
              "not_run",
            ]),
            durationMs: z.number().finite().nonnegative().nullable(),
            evidence: z
              .object({
                renderId: z.string().min(1),
                sceneId: z.string().min(1),
                engineVersion: z.string().regex(/^spatial-v[1-9][0-9]*$/),
                source: z.enum(["real-photo", "synthetic", "unverified"]),
                execution: z.enum(["provider", "mock"]),
                room: imageEvidenceSchema,
                product: imageEvidenceSchema,
                candidate: imageEvidenceSchema.nullable(),
              })
              .strict()
              .nullable(),
            human: humanSchema
              .extend({
                reviewer: z.string().min(1),
                reviewedAt: z.iso.datetime(),
                blind: z.boolean(),
                checks: z
                  .object({
                    design: z.boolean(),
                    perspective: z.boolean(),
                    scale: z.boolean(),
                    contactLighting: z.boolean(),
                    background: z.boolean(),
                  })
                  .strict(),
                notes: z.string().min(1),
              })
              .strict()
              .nullable(),
            measurement: z
              .object({
                reference: z.string().min(1),
                referenceLengthCm: z.number().finite().positive(),
                expectedPx: z.number().finite().positive(),
                observedPx: z.number().finite().positive(),
              })
              .strict()
              .nullable(),
          })
          .strict(),
      )
      .refine(
        (cases) => new Set(cases.map((item) => item.id)).size === cases.length,
        "Duplicate case IDs",
      ),
  })
  .strict();
export type SpatialQualificationV2 = z.infer<
  typeof spatialQualificationV2Schema
>;
export function qualificationImages(input: SpatialQualificationV2) {
  return input.cases.flatMap((item) =>
    item.evidence
      ? [
          item.evidence.room,
          item.evidence.product,
          ...(item.evidence.candidate ? [item.evidence.candidate] : []),
        ]
      : [],
  );
}
export type QualificationFileVerification = {
  verified: Array<{ path: string; sha256: string }>;
  errors: string[];
};

function summarizeCorpus(input: unknown) {
  const { cases } = spatialQualificationSchema.parse(input);
  const evaluated = cases.filter((item) => item.human !== null);
  const measured = cases.filter(
    (item) =>
      item.calibrated &&
      item.reference &&
      item.projectedDimensionError !== null &&
      item.human !== null,
  );
  const measuredScenes = new Set(measured.map((item) => item.reference)).size;
  const sortedErrors = measured
    .map((item) => item.projectedDimensionError!)
    .sort((a, b) => a - b);
  const medianError = sortedErrors.length
    ? (sortedErrors[Math.floor((sortedErrors.length - 1) / 2)]! +
        sortedErrors[Math.ceil((sortedErrors.length - 1) / 2)]!) /
      2
    : null;
  const acceptance = cases.length
    ? evaluated.filter(
        (item) => item.outcome === "delivered" && item.human!.acceptable,
      ).length / cases.length
    : 0;
  const durations = cases
    .flatMap((item) => (item.durationMs === null ? [] : [item.durationMs]))
    .sort((a, b) => a - b);
  const blockers = [
    ...(evaluated.length < 30 ? ["Moins de 30 cas évalués humainement"] : []),
    ...(evaluated.length !== cases.length
      ? ["Cas sans annotation humaine"]
      : []),
    ...(new Set(evaluated.map((item) => item.family)).size < 5
      ? ["Moins de cinq familles évaluées"]
      : []),
    ...(!evaluated.some((item) => item.holdout)
      ? ["Aucun cas de réserve évalué"]
      : []),
    ...(measuredScenes < 10
      ? ["Moins de dix scènes mesurées avec référence"]
      : []),
    ...(evaluated.some(
      (item) =>
        item.human!.majorDesignDefect || item.human!.majorBackgroundDefect,
    )
      ? ["Altération majeure du design ou du décor"]
      : []),
    ...(acceptance < 0.9 ? ["Acceptabilité visuelle inférieure à 90 %"] : []),
    ...(medianError === null ||
    medianError > 0.1 ||
    sortedErrors.some((error) => error > 0.2)
      ? ["Tolérance dimensionnelle non démontrée"]
      : []),
    ...(cases.some((item) => item.outcome === "not_run")
      ? ["Essais non exécutés"]
      : []),
  ];
  return {
    qualified: blockers.length === 0,
    blockers,
    total: cases.length,
    evaluated: evaluated.length,
    measured: measured.length,
    measuredScenes,
    acceptance,
    medianProjectedDimensionError: medianError,
    falseAgreements: cases.filter(
      (item) =>
        item.outcome === "delivered" && item.human && !item.human.acceptable,
    ).length,
    outcomes: Object.fromEntries(
      ["delivered", "rejected", "clarification", "unavailable", "not_run"].map(
        (status) => [
          status,
          cases.filter((item) => item.outcome === status).length,
        ],
      ),
    ),
    latency: {
      samples: durations.length,
      medianMs: durations.length
        ? (durations[Math.floor((durations.length - 1) / 2)]! +
            durations[Math.ceil((durations.length - 1) / 2)]!) /
          2
        : null,
      p95Ms: durations.length
        ? durations[Math.ceil(durations.length * 0.95) - 1]
        : null,
    },
  };
}

/** A passing report is conditional on supplied human/measurement declarations.
 * Hash verification proves file identity, not reviewer independence or physical truth. */
export function qualifySpatialCorpus(
  input: unknown,
  files?: QualificationFileVerification,
) {
  if ((input as { version?: unknown } | null)?.version !== 2) {
    const result = summarizeCorpus(input);
    return {
      ...result,
      qualified: false,
      blockers: [
        ...result.blockers,
        "Format v1 : provenance des images et du moteur non vérifiable",
      ],
      evidenceVersion: 1,
    };
  }
  const data = spatialQualificationV2Schema.parse(input);
  const converted = data.cases.map((item) => ({
    id: item.id,
    family: item.family,
    holdout: item.holdout,
    outcome: item.outcome,
    durationMs: item.durationMs,
    human: item.human
      ? {
          acceptable:
            item.human.acceptable &&
            Object.values(item.human.checks).every(Boolean) &&
            !item.human.majorDesignDefect &&
            !item.human.majorBackgroundDefect,
          majorDesignDefect: item.human.majorDesignDefect,
          majorBackgroundDefect: item.human.majorBackgroundDefect,
        }
      : null,
    calibrated: Boolean(item.measurement && item.evidence?.candidate),
    reference:
      item.measurement && item.evidence?.candidate
        ? item.evidence.sceneId
        : null,
    projectedDimensionError:
      item.measurement && item.evidence?.candidate
        ? Math.abs(item.measurement.observedPx - item.measurement.expectedPx) /
          item.measurement.expectedPx
        : null,
  }));
  const result = summarizeCorpus({ version: 1, cases: converted });
  const blockers = [...result.blockers];
  const add = (condition: boolean, message: string) => {
    if (condition) blockers.push(message);
  };
  add(
    data.cases.some((item) => !item.evidence),
    "Essais sans provenance",
  );
  add(
    data.cases.some(
      (item) =>
        item.evidence &&
        (item.evidence.source !== "real-photo" ||
          item.evidence.execution !== "provider"),
    ),
    "Cas synthétiques, simulés ou d’origine non vérifiée dans le corpus de qualification",
  );
  add(
    data.cases.some(
      (item) =>
        item.evidence && item.evidence.engineVersion !== data.engineVersion,
    ),
    "Versions de moteur mélangées",
  );
  add(
    data.cases.some(
      (item) => item.outcome === "delivered" && !item.evidence?.candidate,
    ),
    "Résultat livré sans image candidate",
  );
  add(
    data.cases.some((item) => item.human && !item.evidence?.candidate),
    "Annotation humaine sans image candidate",
  );
  add(
    data.cases.some(
      (item) => item.measurement && (!item.evidence?.candidate || !item.human),
    ),
    "Mesure sans image candidate évaluée",
  );
  add(
    data.cases.some((item) => item.human && !item.human.blind),
    "Revue humaine non aveugle",
  );
  const runs = data.cases.flatMap((item) =>
    item.evidence ? [item.evidence.renderId] : [],
  );
  const outputs = data.cases.flatMap((item) =>
    item.evidence?.candidate ? [item.evidence.candidate.sha256] : [],
  );
  add(
    new Set(runs).size !== runs.length ||
      new Set(outputs).size !== outputs.length,
    "Essai ou image candidate compté plusieurs fois",
  );
  const reserved = data.cases.filter((item) => item.holdout);
  const tuningPhotos = new Set(
    data.cases
      .filter((item) => !item.holdout)
      .flatMap((item) => (item.evidence ? [item.evidence.room.sha256] : [])),
  );
  const tuningScenes = new Set(
    data.cases
      .filter((item) => !item.holdout)
      .flatMap((item) => (item.evidence ? [item.evidence.sceneId] : [])),
  );
  add(
    reserved.some(
      (item) =>
        item.evidence &&
        (tuningPhotos.has(item.evidence.room.sha256) ||
          tuningScenes.has(item.evidence.sceneId)),
    ),
    "Scène partagée entre ajustement et réserve",
  );
  const photosMeasured = new Set(
    data.cases
      .filter(
        (item) => item.measurement && item.human && item.evidence?.candidate,
      )
      .map((item) => item.evidence!.room.sha256),
  ).size;
  add(photosMeasured < 10, "Moins de dix photos distinctes de scènes mesurées");
  const key = (asset: { path: string; sha256: string }) =>
    JSON.stringify([asset.path, asset.sha256]);
  const verified = new Set(files?.verified.map(key) ?? []);
  add(
    !files ||
      files.errors.length > 0 ||
      qualificationImages(data).some((asset) => !verified.has(key(asset))),
    "Fichiers de preuve absents, modifiés ou non vérifiés",
  );
  const segment = (items: typeof converted) => ({
    total: items.length,
    delivered: items.filter((item) => item.outcome === "delivered").length,
    evaluated: items.filter((item) => item.human).length,
    acceptance: items.length
      ? items.filter(
          (item) => item.outcome === "delivered" && item.human?.acceptable,
        ).length / items.length
      : 0,
  });
  const holdout = segment(converted.filter((item) => item.holdout));
  add(
    holdout.acceptance < 0.9,
    "Acceptabilité de la réserve inférieure à 90 %",
  );
  return {
    ...result,
    qualified: blockers.length === 0,
    blockers,
    evidenceVersion: 2,
    campaign: data.campaign,
    engineVersion: data.engineVersion,
    measuredPhotos: photosMeasured,
    holdout,
    byFamily: Object.fromEntries(
      [...new Set(converted.map((item) => item.family))].map((family) => [
        family,
        segment(converted.filter((item) => item.family === family)),
      ]),
    ),
    fileErrors: files?.errors ?? ["Vérification locale non exécutée"],
    qualificationScope:
      "Seuils sur les fichiers vérifiés et les annotations déclarées ; ni certification des mesures ni autorisation de déploiement",
  };
}
