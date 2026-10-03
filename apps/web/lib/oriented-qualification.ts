import { createHash } from "node:crypto";
import { z } from "zod";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const label = z.string().trim().min(1).max(200);
const criterion = z.enum(["pass", "fail", "indeterminate"]);
export const orientedCorpusCriteriaSchema = z.object({
  identity: criterion, angle: criterion, geometry: criterion, alpha: criterion,
  contact: criterion, shadow: criterion, background: criterion,
}).strict();
const reviewSchema = z.object({
  kind: z.enum(["human", "agent", "automated"]), actorId: label, reviewedAt: z.iso.datetime(),
  criteria: orientedCorpusCriteriaSchema, evidenceSha256: z.array(hash).min(1), notes: z.array(label).max(50),
}).strict();
const productSchema = z.object({
  key: label, label, productId: label.nullable(), variantId: label.nullable(),
  status: z.enum(["pending", "selected"]), sourceSha256: z.array(hash).max(12),
  dimensionsVerified: z.boolean(), variantVerified: z.boolean(), imageRightsVerified: z.boolean(),
}).strict();
const caseSchema = z.object({
  id: label, productKey: label, split: z.enum(["development", "holdout", "repetition"]),
  sceneSha256: hash, productSourceSha256: z.array(hash).min(1).max(12),
  expectedAdmissible: z.boolean(), expectedFailure: z.enum([
    "angle", "size", "identity", "mask", "contact", "shadow", "background", "provider", "infrastructure",
  ]).nullable(),
  conditions: z.array(label).min(1).max(20), repeatsCaseId: label.nullable(),
}).strict();
const resultSchema = z.object({
  caseId: label, manifestFingerprint: hash, startedAt: z.iso.datetime(), completedAt: z.iso.datetime(),
  decision: z.enum(["accepted", "rejected", "indeterminate", "unavailable"]),
  criteria: orientedCorpusCriteriaSchema, manualCorrections: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().finite().nonnegative(), totalDurationMs: z.number().int().nonnegative(),
  providerCalls: z.number().int().nonnegative(), resultSha256: hash.nullable(),
  reviews: z.array(reviewSchema).max(20), failureDetail: z.string().max(2000).nullable(),
}).strict();
export const orientedQualificationManifestSchema = z.object({
  schemaVersion: z.literal(1), corpusId: label, status: z.enum(["draft", "frozen"]),
  frozenAt: z.iso.datetime().nullable(), products: z.array(productSchema).max(100),
  cases: z.array(caseSchema).max(10_000), results: z.array(resultSchema).max(10_000),
  notes: z.array(z.string().min(1).max(2000)).max(30),
}).strict();
export type OrientedQualificationManifest = z.infer<typeof orientedQualificationManifestSchema>;
export type OrientedQualificationCase = OrientedQualificationManifest["cases"][number];
export type OrientedQualificationResult = OrientedQualificationManifest["results"][number];

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

/** The frozen inputs and expected outcomes are hashed; results never change their fingerprint. */
export function orientedQualificationManifestFingerprint(manifest: OrientedQualificationManifest) {
  const { results: ignored, ...definition } = manifest;
  void ignored;
  return createHash("sha256").update(JSON.stringify(canonical(definition))).digest("hex");
}
const allPass = (criteria: z.infer<typeof orientedCorpusCriteriaSchema>) => Object.values(criteria).every(v => v === "pass");
const percentile = (values: number[], rank: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * rank) - 1)]!;
};

/** Fail closed: software checks, visual human review and metric precision are separate proofs. */
export function qualifyOrientedCorpus(input: unknown) {
  const manifest = orientedQualificationManifestSchema.parse(input);
  const manifestFingerprint = orientedQualificationManifestFingerprint(manifest);
  const issues: Array<{ code: string; detail: string; caseId?: string }> = [];
  const add = (code: string, detail: string, caseId?: string) => issues.push({ code, detail, ...(caseId ? { caseId } : {}) });
  if (manifest.status !== "frozen" || !manifest.frozenAt) add("manifest_not_frozen", "Figer les sources, la répartition et les résultats attendus avant la campagne.");
  const products = new Map<string, typeof manifest.products[number]>();
  for (const product of manifest.products) {
    if (products.has(product.key)) add("duplicate_product", `Produit répété : ${product.key}.`);
    products.set(product.key, product);
  }
  const verifiedProducts = manifest.products.filter(p => p.status === "selected" && p.productId &&
    p.sourceSha256.length && p.dimensionsVerified && p.variantVerified && p.imageRightsVerified);
  if (new Set(verifiedProducts.map(p => p.productId)).size < 3) add("insufficient_products", "Trois produits distincts avec sources, dimensions, variante et droits vérifiés sont requis.");
  if (new Set(verifiedProducts.map(p => `${p.productId}:${p.variantId}`)).size !== verifiedProducts.length)
    add("duplicate_product_reference", "Deux lignes désignent la même référence et variante.");
  const cases = new Map<string, OrientedQualificationCase>();
  const splits = { development: new Set<string>(), holdout: new Set<string>() };
  for (const item of manifest.cases) {
    if (cases.has(item.id)) add("duplicate_case", "Identifiant de cas répété.", item.id);
    cases.set(item.id, item);
    const product = products.get(item.productKey);
    if (!product || !verifiedProducts.includes(product)) add("unverified_product", "La référence de ce cas n’est pas vérifiée.", item.id);
    if (product && item.productSourceSha256.some(source => !product.sourceSha256.includes(source)))
      add("source_mismatch", "Les sources du cas ne figurent pas dans les références figées du produit.", item.id);
    if (item.split !== "repetition") splits[item.split].add(item.sceneSha256);
    if (item.split !== "repetition" && item.repeatsCaseId !== null) add("invalid_repetition", "Seul un cas de répétition désigne un cas d’origine.", item.id);
    if (item.expectedAdmissible && item.expectedFailure !== null) add("contradictory_expectation", "Un cas admissible ne peut pas annoncer un échec attendu.", item.id);
  }
  for (const sceneHash of splits.holdout) if (splits.development.has(sceneHash))
    add("holdout_contamination", `La scène ${sceneHash} est présente dans le développement et la réserve.`);
  for (const item of manifest.cases.filter(item => item.split === "repetition")) {
    const source = item.repeatsCaseId ? cases.get(item.repeatsCaseId) : undefined;
    if (!source || source.split === "repetition" || source.sceneSha256 !== item.sceneSha256 ||
        source.productKey !== item.productKey || source.expectedAdmissible !== item.expectedAdmissible ||
        source.expectedFailure !== item.expectedFailure || JSON.stringify(source.conditions) !== JSON.stringify(item.conditions) ||
        JSON.stringify(source.productSourceSha256) !== JSON.stringify(item.productSourceSha256))
      add("invalid_repetition", "La répétition doit reprendre la scène, le produit et les attentes d’un cas figé.", item.id);
  }
  for (const product of verifiedProducts) for (const split of ["development", "holdout"] as const) {
    if (!manifest.cases.some(item => item.productKey === product.key && item.split === split && item.expectedAdmissible))
      add("product_not_covered", `${product.label} ne possède aucun cas admissible en ${split}.`);
  }
  const byCase = new Map<string, OrientedQualificationResult>();
  const humanKinds = { human: 0, agent: 0, automated: 0 };
  for (const result of manifest.results) {
    if (byCase.has(result.caseId)) add("duplicate_result", "Une seule exécution est admise par cas ; créer un cas de répétition avant exécution.", result.caseId);
    byCase.set(result.caseId, result);
    if (!cases.has(result.caseId)) add("unknown_case", "Ce résultat ne correspond à aucun cas figé.", result.caseId);
    if (result.manifestFingerprint !== manifestFingerprint) add("manifest_mismatch", "Les sources ou attentes ont changé depuis cette exécution.", result.caseId);
    if (!manifest.frozenAt || Date.parse(result.startedAt) < Date.parse(manifest.frozenAt))
      add("execution_before_freeze", "Cette exécution précède le gel du corpus.", result.caseId);
    if (Date.parse(result.completedAt) < Date.parse(result.startedAt)) add("invalid_timing", "La fin d’exécution précède son début.", result.caseId);
    const human = result.reviews.filter(r => r.kind === "human");
    if (!human.length) add("missing_human_review", "Une revue humaine initiale est obligatoire ; un avis d’agent ne la remplace pas.", result.caseId);
    for (const review of result.reviews) {
      humanKinds[review.kind]++;
      if (Date.parse(review.reviewedAt) < Date.parse(result.completedAt)) add("review_before_result", "La revue précède le résultat examiné.", result.caseId);
      if (result.resultSha256 && !review.evidenceSha256.includes(result.resultSha256))
        add("review_evidence_mismatch", "La revue ne désigne pas l’empreinte du résultat examiné.", result.caseId);
    }
    if (result.decision === "accepted") {
      if (!result.resultSha256) add("accepted_without_image", "Un résultat accepté doit conserver son image vérifiable.", result.caseId);
      if (!cases.get(result.caseId)?.expectedAdmissible) add("false_acceptance", "Un cas déclaré inadmissible a été livré accepté.", result.caseId);
      if ([result.criteria, ...result.reviews.map(r => r.criteria)].some(c => c.identity !== "pass" || c.background !== "pass"))
        add("accepted_critical_defect", "Un résultat accepté présente une identité ou un décor défectueux ou indéterminé.", result.caseId);
      if ([result.criteria, ...human.map(r => r.criteria)].some(c => !allPass(c)))
        add("accepted_visual_defect", "Un résultat accepté ne satisfait pas tous les critères visuels séparés.", result.caseId);
    }
  }
  for (const item of manifest.cases) if (!byCase.has(item.id)) add("missing_result", "Cas non exécuté.", item.id);
  const minimum = { development: 36, holdout: 18, repetition: 12 };
  const summaries = (Object.keys(minimum) as Array<keyof typeof minimum>).map(split => {
    const inventory = manifest.cases.filter(c => c.split === split);
    if (inventory.length < minimum[split]) add("insufficient_cases", `${split} : ${inventory.length}/${minimum[split]} cas définis.`);
    const admissible = inventory.filter(c => c.expectedAdmissible);
    const completed = inventory.map(c => byCase.get(c.id)).filter((r): r is OrientedQualificationResult => Boolean(r));
    const autonomous = admissible.filter(c => {
      const result = byCase.get(c.id);
      if (!result || result.decision !== "accepted" || result.manualCorrections !== 0 || !allPass(result.criteria)) return false;
      const human = result.reviews.filter(r => r.kind === "human");
      return human.length > 0 && human.every(r => allPass(r.criteria));
    }).length;
    const rate = admissible.length ? autonomous / admissible.length : null;
    if (split !== "repetition" && (rate === null || rate < 0.9)) add("autonomy_below_threshold", `${split} : au moins 90 % de cas admissibles acceptables sans correction manuelle sont requis.`);
    return { split, defined: inventory.length, required: minimum[split], completed: completed.length,
      admissible: admissible.length, autonomousAccepted: autonomous, autonomousAcceptanceRate: rate,
      rejected: completed.filter(r => r.decision === "rejected").length,
      refusalRate: inventory.length ? completed.filter(r => r.decision !== "accepted").length / inventory.length : null,
      manualCorrections: completed.reduce((sum, r) => sum + r.manualCorrections, 0),
      estimatedCostUsd: completed.reduce((sum, r) => sum + r.estimatedCostUsd, 0),
      medianDurationMs: percentile(completed.map(r => r.totalDurationMs), 0.5),
      p95DurationMs: percentile(completed.map(r => r.totalDurationMs), 0.95) };
  });
  return { schemaVersion: 1 as const, policyVersion: "oriented-corpus-v1", corpusId: manifest.corpusId,
    manifestFingerprint, qualified: issues.length === 0, metricQualified: false, productionAuthorized: false,
    generatedAt: new Date().toISOString(), issues, splits: summaries, reviewCounts: humanKinds,
    totals: { defined: manifest.cases.length, recorded: manifest.results.length,
      estimatedCostUsd: manifest.results.reduce((sum, r) => sum + r.estimatedCostUsd, 0),
      providerCalls: manifest.results.reduce((sum, r) => sum + r.providerCalls, 0),
      manualCorrections: manifest.results.reduce((sum, r) => sum + r.manualCorrections, 0) },
  };
}
