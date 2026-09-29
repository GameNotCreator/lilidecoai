import "server-only";
import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import type { CutoutMetadata } from "@lili/types";
import { AdminProductError, findProduct, syncProductAssetVisibility } from "./admin-products";
import { CUTOUT_VERSION, deleteAsset, prepareCutout, readAsset, storeAsset } from "./assets";
import { cutoutVerdict } from "./cutout-identity";
import { hasSeparatedSubjects } from "./mask-topology";
import { collections } from "./mongodb";
import { productAssetVisibility } from "./product-visibility";
import { spatialPreparationForCatalog } from "./spatial-policy";
import { adminPreparationConfiguration, currentProductCutoutPreparation,
  preparationHash, productPreparationGeometryFingerprint,
  type CompletedProductPreparation } from "./product-preparation";

/** One local preparation per product; no image generation or vision API calls. */
export async function prepareAdminProduct(db: Db, organizationId: string, productId: string) {
  const c = collections(db);
  const product = await findProduct(db, organizationId, productId);
  if (product.status === "archived") throw new AdminProductError("Restaurez le produit avant de le préparer.", 409);
  if (product.visualizationBlockedReason?.trim())
    throw new AdminProductError(`Visualisation désactivée : ${product.visualizationBlockedReason}`, 422);
  if (!product.assetId) throw new AdminProductError("Ajoutez d’abord une photo de face.");
  const token = randomUUID();
  const lease = { token, sourceAssetId: product.assetId, expiresAt: new Date(Date.now() + 150_000) };
  const claimed = await c.products.updateOne({
    id: productId, organizationId, assetId: product.assetId, updatedAt: product.updatedAt,
    $or: [{ "productPreparation.lease.expiresAt": { $exists: false } },
      { "productPreparation.lease.expiresAt": { $lte: new Date() } }],
  }, { $set: { "productPreparation.lease": lease }, $unset: { "productPreparation.failure": "" } });
  if (!claimed.matchedCount) throw new AdminProductError("La préparation est déjà en cours ou la fiche a changé. Rechargez le produit.", 409);
  const owned = { id: productId, organizationId, "productPreparation.lease.token": token };
  let createdAssetId: string | undefined;
  let committed = false;
  try {
    const source = await readAsset(db, product.assetId);
    if (!source || source.asset.organizationId !== organizationId || source.asset.kind !== "product")
      throw new AdminProductError("Photo produit introuvable", 404);
    const sourceSha256 = preparationHash(source.buffer);
    const prior = currentProductCutoutPreparation(product);
    const previousAsset = product.cutoutAssetId ? await readAsset(db, product.cutoutAssetId) : null;
    const ownedPrevious = previousAsset?.asset.organizationId === organizationId && previousAsset.asset.kind === "cutout";
    const reusable = prior && prior.sourceSha256 === sourceSha256 && ownedPrevious &&
      preparationHash(previousAsset.buffer) === prior.cutoutSha256;
    let cutout = product.cutout;
    let cutoutAssetId = product.cutoutAssetId;
    let cutoutSha256 = prior?.cutoutSha256;
    if (!reusable) {
      const matte = await prepareCutout(source.buffer);
      // A catalog image must identify one product, not a group of objects.
      // This alpha-only check is local and does not invoke a provider.
      matte.quality.multipleSubjects = await hasSeparatedSubjects(matte.buffer);
      if (matte.quality.hollowed) {
        // Catalogue photos tested for this store lost large pale areas while
        // the legacy global verdict only warned. Do not admit that local mask
        // into the public store; keep the original photo and any earlier proof.
        throw new AdminProductError(
          "Le détourage local laisse des zones transparentes dans le produit. Ajoutez une photo sur un fond uni contrasté, puis relancez la préparation.",
          422,
        );
      }
      const verdict = cutoutVerdict(matte.quality);
      if (!verdict.usable) throw new AdminProductError(verdict.detail, 422);
      cutout = {
        widthPx: matte.widthPx, heightPx: matte.heightPx,
        baseRowFraction: matte.baseRowFraction, source: "heuristic", synthetic: false,
        shadowRemoved: matte.shadowRemoved, warnings: matte.warnings,
        cutoutVersion: CUTOUT_VERSION, verdict,
      } satisfies CutoutMetadata;
      const asset = await storeAsset(db, {
        organizationId, kind: "cutout",
        visibility: productAssetVisibility({ ...product, status: "draft" }),
        ...(product.expiresAt ? { expiresAt: product.expiresAt } : {}),
        buffer: matte.buffer, contentType: "image/webp",
      });
      createdAssetId = asset.id;
      cutoutAssetId = asset.id;
      cutoutSha256 = preparationHash(matte.buffer);
    }
    if (!cutout || !cutoutAssetId || !cutoutSha256) throw new Error("Incomplete prepared product");
    // Re-read the catalog after local processing: changed dimensions need only
    // cheap geometry refresh, while a new photo/lease cannot accept old pixels.
    const latest = await findProduct(db, organizationId, productId);
    if (latest.status === "archived") throw new AdminProductError("Le produit a été archivé pendant la préparation.", 409);
    if (latest.visualizationBlockedReason?.trim())
      throw new AdminProductError(`Visualisation désactivée : ${latest.visualizationBlockedReason}`, 422);
    if (latest.assetId !== product.assetId || latest.productPreparation?.lease?.token !== token ||
      latest.productPreparation.lease.expiresAt.getTime() <= Date.now())
      throw new AdminProductError("La photo a changé pendant la préparation. Relancez-la.", 409);
    const prepared = { ...latest, cutoutAssetId, cutout };
    const geometryFingerprint = productPreparationGeometryFingerprint(prepared);
    const unchanged = Boolean(reusable && prior.geometryFingerprint === geometryFingerprint);
    const completed: CompletedProductPreparation = unchanged ? prior! : {
      version: 1, configuration: adminPreparationConfiguration(),
      sourceAssetId: product.assetId, sourceSha256, cutoutAssetId, cutoutSha256,
      metadataSha256: preparationHash(JSON.stringify(cutout)), geometryFingerprint,
      preparedAt: new Date(),
    };
    const update = await c.products.updateOne({ ...owned, assetId: product.assetId,
      updatedAt: latest.updatedAt, widthCm: latest.widthCm, heightCm: latest.heightCm,
      depthCm: latest.depthCm, status: latest.status,
      visualizationBlockedReason: latest.visualizationBlockedReason === undefined
        ? { $exists: false } : latest.visualizationBlockedReason,
      "productPreparation.lease.expiresAt": { $gt: new Date() } }, {
      $set: {
        cutoutAssetId, cutout, productPreparation: { completed },
        spatialPreparation: spatialPreparationForCatalog(prepared),
        ...(reusable ? {} : { status: "draft" as const, archivedAt: null,
          anchor: latest.anchor ?? { anchorType: "bottom_center", xNormalized: 0.5, yNormalized: 1 } }),
        ...(unchanged ? {} : { updatedAt: new Date() }),
      },
    });
    if (!update.matchedCount) throw new AdminProductError("La fiche a changé pendant la préparation. Rechargez-la.", 409);
    committed = true;
    const updated = await findProduct(db, organizationId, productId);
    if (!reusable) {
      await syncProductAssetVisibility(db, updated);
      if (ownedPrevious && product.cutoutAssetId && product.cutoutAssetId !== cutoutAssetId)
        // Durable renders admitted before this replacement can still reference
        // these bytes. Retain their existing expiry, but retire public access.
        await c.assets.updateOne({ id: product.cutoutAssetId, organizationId, kind: "cutout" },
          { $set: { visibility: "private" } });
    }
    return updated;
  } catch (reason) {
    if (createdAssetId && !committed) await deleteAsset(db, createdAssetId).catch(() => undefined);
    await c.products.updateOne({ ...owned, status: { $ne: "archived" } }, { $set: { "productPreparation.failure": {
      sourceAssetId: product.assetId,
      detail: reason instanceof AdminProductError ? reason.message : "La préparation a échoué. Réessayez.", at: new Date(),
    } } });
    throw reason;
  } finally {
    await c.products.updateOne(owned, { $unset: { "productPreparation.lease": "" } });
  }
}
