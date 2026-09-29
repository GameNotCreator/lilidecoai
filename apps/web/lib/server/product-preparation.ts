import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { CUTOUT_VERSION } from "./assets";
import { cutoutTrust } from "./cutout-identity";
import { spatialPreparationForCatalog } from "./spatial-policy";
import type { ProductDocument } from "./types";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const completedSchema = z.object({
  version: z.literal(1),
  configuration: z.string(),
  sourceAssetId: z.string().min(1),
  sourceSha256: sha,
  cutoutAssetId: z.string().min(1),
  cutoutSha256: sha,
  metadataSha256: sha,
  geometryFingerprint: sha,
  preparedAt: z.date(),
}).strict();
export type CompletedProductPreparation = z.infer<typeof completedSchema>;
export interface ProductPreparationState {
  completed?: CompletedProductPreparation;
  lease?: { token: string; sourceAssetId: string; expiresAt: Date };
  failure?: { sourceAssetId: string; detail: string; at: Date };
}
export const preparationHash = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
/** This admin path is local only. Matting/provider credentials do not affect it. */
export const adminPreparationConfiguration = () => `admin-local-v3/${CUTOUT_VERSION}/topology-v1/hollowed-refusal-v1`;
export function productPreparationGeometryFingerprint(product: ProductDocument) {
  return preparationHash(JSON.stringify({
    dimensions: [product.widthCm, product.heightCm, product.depthCm],
    geometry: spatialPreparationForCatalog(product)?.fingerprint ?? null,
  }));
}
export function completedProductPreparation(product: ProductDocument) {
  const parsed = completedSchema.safeParse(product.productPreparation?.completed);
  return parsed.success ? parsed.data : undefined;
}
/** This validates catalog provenance. Reuse additionally checks both asset bytes. */
export function currentProductCutoutPreparation(product: ProductDocument) {
  const completed = completedProductPreparation(product);
  if (!completed || completed.configuration !== adminPreparationConfiguration() ||
    completed.sourceAssetId !== product.assetId || completed.cutoutAssetId !== product.cutoutAssetId ||
    !product.cutout || product.cutout.source !== "heuristic" || product.cutout.synthetic ||
    product.cutout.cutoutVersion !== CUTOUT_VERSION || product.cutout.verdict?.usable !== true ||
    !cutoutTrust(product.cutout).trusted ||
    completed.metadataSha256 !== preparationHash(JSON.stringify(product.cutout))) return undefined;
  return completed;
}
export function productPreparationStatus(product: ProductDocument) {
  const completed = completedProductPreparation(product);
  const preparedAt = completed?.preparedAt.toISOString() ?? null;
  const result = (status: "missing-photo" | "not-prepared" | "stale" | "preparing" | "ready" | "failed", detail: string) => ({ status, detail, preparedAt });
  if (!product.assetId) return result("missing-photo", "Ajoutez une photo de face.");
  if (product.visualizationBlockedReason?.trim())
    return result("failed", `Visualisation désactivée : ${product.visualizationBlockedReason}`);
  const lease = product.productPreparation?.lease;
  if (lease?.sourceAssetId === product.assetId && lease.expiresAt instanceof Date && lease.expiresAt.getTime() > Date.now())
    return result("preparing", "La préparation de ce produit est en cours.");
  const current = currentProductCutoutPreparation(product);
  const failure = product.productPreparation?.failure;
  if (failure?.sourceAssetId === product.assetId)
    return result("failed", failure.detail);
  if (current && current.geometryFingerprint === productPreparationGeometryFingerprint(product))
    return result("ready", "Photo et fiche préparées. Aucune nouvelle préparation nécessaire.");
  if (completed || product.cutoutAssetId)
    return result("stale", current ? "Actualisez la préparation pour prendre en compte la fiche modifiée. Le détourage sera réutilisé." : "La photo ou sa préparation a changé. Relancez la préparation.");
  return result("not-prepared", "Préparez cette photo avant de proposer la visualisation du produit.");
}
