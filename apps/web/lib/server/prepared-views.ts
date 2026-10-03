import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { ClientSession, Db } from "mongodb";
import { preparedProductViewSchema, preparedViewReviewSchema, renderViewSnapshotSchema,
  reviewPreparedViewRequestSchema, revokePreparedViewRequestSchema,
  type PreparedProductView, type PreparedViewReview, type RenderViewSnapshot } from "@lili/types";
import { AdminProductError, findProduct } from "./admin-products";
import { readAsset } from "./assets";
import type { ProductDocument } from "./types";

export const preparedHash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
interface PreparedViewRecord extends PreparedProductView { deliveryFence?: number; preparationLeaseToken?: string }
export function preparedCollections(db: Db) {
  return { views: db.collection<PreparedViewRecord>("prepared_product_views"),
    tasks: db.collection<import("./prepared-view-tasks").PreparedViewTask>("prepared_view_tasks") };
}
/** Additive migration: never seeds or approves historical catalogue items. */
export async function ensurePreparedViewIndexes(db: Db) {
  const c = preparedCollections(db);
  await Promise.all([
    c.views.createIndex({ organizationId: 1, id: 1 }, { unique: true }),
    c.views.createIndex({ organizationId: 1, productId: 1, variantId: 1, state: 1 }),
    c.tasks.createIndex({ organizationId: 1, businessKey: 1 }, { unique: true }),
    c.tasks.createIndex({ organizationId: 1, idempotencyKey: 1 }, { unique: true }),
    c.tasks.createIndex({ state: 1, "lease.expiresAt": 1 }),
  ]);
}
export function assertPreparedProduct(product: ProductDocument, variantId: string | null) {
  if (product.status === "archived") throw new AdminProductError("Produit archivé.", 409);
  if (product.expiresAt && product.expiresAt.getTime() <= Date.now()) throw new AdminProductError("Produit expiré.", 409);
  if (product.visualizationBlockedReason?.trim())
    throw new AdminProductError(`Visualisation désactivée : ${product.visualizationBlockedReason}`, 422);
  if (variantId && !product.variants?.some(v => v.id === variantId && v.available))
    throw new AdminProductError("Variante indisponible.", 422);
}
export function preparedGeometryFingerprint(product: ProductDocument, variantId: string | null) {
  const variant = variantId ? product.variants?.find(v => v.id === variantId) : undefined;
  return preparedHash(JSON.stringify({ variantId, width: variant?.widthCm ?? product.widthCm,
    height: variant?.heightCm ?? product.heightCm, depth: variant?.depthCm ?? product.depthCm,
    placementType: product.placementType }));
}
export async function preparedSources(db: Db, product: ProductDocument, variantId: string | null) {
  assertPreparedProduct(product, variantId);
  return catalogueFingerprints(db, product, variantId);
}
async function catalogueFingerprints(db: Db, product: ProductDocument, variantId: string | null) {
  const inventory = [
    ...(product.assetId ? [{ assetId: product.assetId, role: "front" as const }] : []),
    ...(product.views ?? []).filter(v => v.validationStatus === "valid").map(v => ({ assetId: v.assetId, role: v.type })),
  ].filter((source, i, list) => list.findIndex(other => other.assetId === source.assetId) === i);
  if (!inventory.length) throw new AdminProductError("Ajoutez une photographie du produit.", 422);
  const sources = [] as PreparedProductView["sources"];
  for (const source of inventory) {
    const asset = await readAsset(db, source.assetId);
    if (!asset || asset.asset.organizationId !== product.organizationId ||
        !["product", "product_view"].includes(asset.asset.kind) || asset.asset.purgeClaimedAt ||
        (asset.asset.expiresAt && asset.asset.expiresAt <= new Date()))
      throw new AdminProductError("Une photographie source est indisponible.", 409);
    sources.push({ ...source, sha256: preparedHash(asset.buffer) });
  }
  return { sources, sourceFingerprint: preparedHash(JSON.stringify({ variantId, sources })),
    geometryFingerprint: preparedGeometryFingerprint(product, variantId) };
}
export function preparedViewAssets(view: PreparedProductView) {
  return [...new Set([...view.sources.map(s => s.assetId), view.image?.assetId, view.alpha?.assetId,
    ...(view.review?.evidenceAssetIds ?? [])].filter((v): v is string => Boolean(v)))];
}
export async function verifyPreparedViewAssets(db: Db, view: PreparedProductView) {
  for (const expected of [...view.sources, view.image, view.alpha].filter((v): v is NonNullable<typeof v> => Boolean(v))) {
    const actual = await readAsset(db, expected.assetId);
    if (!actual || actual.asset.organizationId !== view.organizationId || actual.asset.purgeClaimedAt ||
        (actual.asset.expiresAt && actual.asset.expiresAt <= new Date()) || preparedHash(actual.buffer) !== expected.sha256)
      throw new AdminProductError("Un actif de la vue préparée a expiré ou a changé.", 409);
    if ((expected === view.image || expected === view.alpha) && actual.asset.visibility !== "private")
      throw new AdminProductError("Un candidat doit rester privé.", 409);
  }
}
export async function listPreparedViews(db: Db, organizationId: string, productId: string) {
  const product = await findProduct(db, organizationId, productId);
  await syncPreparedViewCompatibility(db, organizationId, product);
  const c = preparedCollections(db);
  const views = await c.views.find({ organizationId, productId }).sort({ createdAt: -1 }).limit(100).toArray();
  // MongoDB's internal _id is not part of the public, versioned contract.
  return views.map(parseViewRecord);
}
/** Updates eligibility metadata only; historical bytes and reviews are immutable evidence. */
export async function syncPreparedViewCompatibility(db: Db, organizationId: string, product: ProductDocument) {
  if (product.organizationId !== organizationId) throw new AdminProductError("Produit introuvable.", 404);
  const c = preparedCollections(db);
  const views = await c.views.find({ organizationId, productId: product.id,
    state: { $in: ["approved", "needs_review", "rejected"] } }).toArray();
  const fingerprints = new Map<string | null, Awaited<ReturnType<typeof catalogueFingerprints>> | null>();
  for (const view of views) {
    if (!fingerprints.has(view.variantId)) {
      try { fingerprints.set(view.variantId, await catalogueFingerprints(db, product, view.variantId)); }
      catch (error) {
        if (!(error instanceof AdminProductError)) throw error;
        fingerprints.set(view.variantId, null);
      }
    }
    const current = fingerprints.get(view.variantId);
    const variantGone = view.variantId && !product.variants?.some(v => v.id === view.variantId);
    const obsoleteOrientation = view.origin === "generated" && view.versions.prompt === "prepared-view-v1.0.0";
    if (obsoleteOrientation || variantGone || !current || current.sourceFingerprint !== view.sourceFingerprint ||
        current.geometryFingerprint !== view.geometryFingerprint) {
      await c.views.updateOne({ organizationId, productId: product.id, id: view.id, revision: view.revision, state: view.state },
        { $set: { state: "stale", updatedAt: new Date().toISOString() }, $inc: { revision: 1 } });
    }
  }
}
function parseViewRecord(doc: PreparedViewRecord) {
  const view = { ...doc } as PreparedViewRecord & { _id?: unknown };
  delete view._id; delete view.deliveryFence; delete view.preparationLeaseToken;
  return preparedProductViewSchema.parse(view);
}
async function getView(db: Db, organizationId: string, productId: string, viewId: string, session?: ClientSession) {
  const doc = await preparedCollections(db).views.findOne({ organizationId, productId, id: viewId }, { session });
  if (!doc) throw new AdminProductError("Vue préparée introuvable.", 404);
  return parseViewRecord(doc);
}
export async function reviewPreparedView(db: Db, organizationId: string, productId: string, viewId: string,
  actorId: string, input: unknown, kind: PreparedViewReview["kind"] = "human") {
  const request = reviewPreparedViewRequestSchema.parse(input);
  const product = await findProduct(db, organizationId, productId);
  const view = await getView(db, organizationId, productId, viewId);
  assertPreparedProduct(product, view.variantId);
  if (request.decision === "approved" && view.origin === "generated" && view.versions.prompt === "prepared-view-v1.0.0")
    throw new AdminProductError("Cette ancienne préparation utilise une convention d’angle obsolète. Préparez une nouvelle version.", 409);
  if (!["needs_review", "approved", "rejected", "stale"].includes(view.state))
    throw new AdminProductError("Cette vue ne peut pas être revue dans son état actuel.", 409);
  const current = await preparedSources(db, product, view.variantId);
  if (current.sourceFingerprint !== view.sourceFingerprint)
    throw new AdminProductError("Les photographies ont changé. Préparez une nouvelle vue.", 409);
  await verifyPreparedViewAssets(db, view);
  if ((view.reviewHistory?.length ?? 0) >= 100) throw new AdminProductError("Limite de révisions atteinte : créez une nouvelle version de vue.", 409);
  if (request.decision === "approved" && (kind !== "human" || !view.image || !view.alpha ||
      !view.anchor || view.anchor.confidence < 0.8 || !view.visibleBounds ||
      !request.physicalHeightSegment || !request.estimatedOrientation || !request.coverage ||
      Object.values(request.criteria).some(v => v !== "pass")))
    throw new AdminProductError("L’approbation initiale exige une revue humaine complète, un angle, un contact et une hauteur physique documentés.", 422);
  if (request.decision === "approved" && view.origin === "generated" && !request.unknownFaces.length)
    throw new AdminProductError("Une vue reconstruite doit conserver la liste des faces ou détails non vérifiés.", 422);
  if (request.decision === "approved" && request.coverage && request.estimatedOrientation && (
    request.estimatedOrientation.azimuthDeg < request.coverage.azimuthMinDeg ||
    request.estimatedOrientation.azimuthDeg > request.coverage.azimuthMaxDeg ||
    request.estimatedOrientation.elevationDeg < request.coverage.elevationMinDeg ||
    request.estimatedOrientation.elevationDeg > request.coverage.elevationMaxDeg))
    throw new AdminProductError("La couverture doit inclure l’orientation observée.", 422);
  const review = preparedViewReviewSchema.parse({ id: randomUUID(), kind, actorId,
    decision: request.decision, criteria: request.criteria, coverage: request.coverage,
    allowedUsage: "internal_preview", limits: request.limits, unknownFaces: request.unknownFaces,
    evidenceAssetIds: preparedViewAssets(view), policyVersion: "prepared-review-v1", reviewedAt: new Date().toISOString() });
  const result = await preparedCollections(db).views.updateOne({ organizationId, productId, id: viewId,
    revision: request.expectedRevision, state: view.state }, { $set: {
      review, state: request.decision, geometryFingerprint: current.geometryFingerprint,
      "orientation.estimated": request.estimatedOrientation, "orientation.coverage": request.coverage,
      physicalHeightSegment: request.physicalHeightSegment, updatedAt: new Date().toISOString(),
    }, $inc: { revision: 1 }, $push: { reviewHistory: review } });
  if (!result.matchedCount) throw new AdminProductError("La vue a changé. Rechargez-la avant de la revoir.", 409);
  return getView(db, organizationId, productId, viewId);
}
export async function revokePreparedView(db: Db, organizationId: string, productId: string, viewId: string,
  actorId: string, input: unknown) {
  const request = revokePreparedViewRequestSchema.parse(input);
  await findProduct(db, organizationId, productId);
  const view = await getView(db, organizationId, productId, viewId);
  const result = await preparedCollections(db).views.updateOne({ organizationId, productId, id: viewId,
    revision: request.expectedRevision, state: view.state }, { $set: { state: "revoked",
      revocation: { reason: request.reason, kind: request.kind, actorId, revokedAt: new Date().toISOString() },
      updatedAt: new Date().toISOString() }, $inc: { revision: 1 } });
  if (!result.matchedCount) throw new AdminProductError("La vue a changé. Rechargez-la.", 409);
  return getView(db, organizationId, productId, viewId);
}
function approved(view: PreparedProductView) {
  return view.state === "approved" && view.review?.decision === "approved" && view.review.kind === "human" &&
    view.image && view.alpha && view.anchor && view.visibleBounds && view.physicalHeightSegment &&
    view.orientation.estimated && view.orientation.coverage && Object.values(view.review.criteria).every(v => v === "pass") &&
    (view.origin !== "generated" || view.review.unknownFaces.length > 0);
}
export async function admitPreparedViews(db: Db, organizationId: string, product: ProductDocument,
  variantId: string | null = null): Promise<RenderViewSnapshot[]> {
  if (product.organizationId !== organizationId) throw new AdminProductError("Produit introuvable.", 404);
  const latest = await findProduct(db, organizationId, product.id);
  assertPreparedProduct(latest, variantId);
  const current = await preparedSources(db, latest, variantId);
  const candidates = (await listPreparedViews(db, organizationId, product.id)).filter(view => view.variantId === variantId && approved(view));
  const snapshots: RenderViewSnapshot[] = [];
  for (const view of candidates) {
    if (view.sourceFingerprint !== current.sourceFingerprint || view.geometryFingerprint !== current.geometryFingerprint) continue;
    await verifyPreparedViewAssets(db, view);
    snapshots.push(renderViewSnapshotSchema.parse({ schemaVersion: 1, view, sourceAssetIds: preparedViewAssets(view),
      admittedAt: new Date().toISOString(), snapshotFingerprint: preparedHash(JSON.stringify(view)) }));
  }
  if (!snapshots.length) throw new AdminProductError("Aucune vue approuvée compatible avec cette variante et ces dimensions.", 422);
  return snapshots;
}
export async function assertSnapshotDeliverable(db: Db, input: RenderViewSnapshot,
  options: { session?: ClientSession } = {}): Promise<void> {
  const snapshot = renderViewSnapshotSchema.parse(input);
  const view = snapshot.view;
  if (!approved(view) || snapshot.snapshotFingerprint !== preparedHash(JSON.stringify(view)))
    throw new AdminProductError("Snapshot de vue invalide.", 409);
  if (JSON.stringify([...snapshot.sourceAssetIds].sort()) !== JSON.stringify(preparedViewAssets(view).sort()))
    throw new AdminProductError("Dépendances du snapshot incomplètes.", 409);
  const current = await getView(db, view.organizationId, view.productId, view.id, options.session);
  if (current.revocation?.kind === "identity_incident")
    throw new AdminProductError("Vue révoquée pour incident d’identité : livraison bloquée.", 409);
  const products = db.collection<ProductDocument & { orientedDeliveryFence?: number }>("products");
  const product = options.session
    ? await products.findOne({ organizationId: view.organizationId, id: view.productId }, { session: options.session })
    : await findProduct(db, view.organizationId, view.productId);
  if (!product) throw new AdminProductError("Produit introuvable.", 404);
  assertPreparedProduct(product, view.variantId);
  // A replacement or dimensions update does not rewrite an admitted snapshot.
  await verifyPreparedViewAssets(db, view);
  if (options.session) {
    // The delivery transaction writes this document: a concurrent revocation
    // conflicts and forces the transaction to re-read the revocation before commit.
    const result = await preparedCollections(db).views.updateOne({ organizationId: view.organizationId,
      productId: view.productId, id: view.id, revision: current.revision,
      "revocation.kind": { $ne: "identity_incident" } }, { $inc: { deliveryFence: 1 } }, { session: options.session });
    if (!result.matchedCount) throw new AdminProductError("La vue a changé avant livraison.", 409);
    const productFence = await products.updateOne({ organizationId: view.organizationId, id: view.productId,
      updatedAt: product.updatedAt, status: { $ne: "archived" },
      visualizationBlockedReason: product.visualizationBlockedReason === undefined ? { $exists: false } : product.visualizationBlockedReason,
    }, { $inc: { orientedDeliveryFence: 1 } }, { session: options.session });
    if (!productFence.matchedCount) throw new AdminProductError("Le produit a changé avant livraison.", 409);
  }
}
