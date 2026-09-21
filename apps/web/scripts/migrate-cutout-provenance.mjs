/**
 * Drops cutouts that a generative model produced — audit finding A03, ticket
 * PRO-008.
 *
 * A synthetic cutout is not a lesser cutout. Its pixels are composited into the
 * room and re-stamped over the model's output as the last operation before
 * encoding, so it is what the customer is shown as their product. Every product
 * still holding one keeps a generated object as its fidelity reference for
 * every future render.
 *
 *   node apps/web/scripts/migrate-cutout-provenance.mjs
 *   node apps/web/scripts/migrate-cutout-provenance.mjs --apply
 *
 * It is deliberately DESTRUCTIVE-ONLY: it expires the cutout (the purge cron
 * destroys it, storage object included), clears the
 * metadata and sends the product back to `processing`. It does NOT re-prepare
 * inside the script. Re-preparing here would write width, height and base row
 * describing a freshly computed image while the stored asset is still the old
 * one — a product whose geometry and pixels come from two different images,
 * which is a worse defect than the one being fixed. The owner re-prepares
 * through /prepare, where both are written together.
 *
 * Products with no cutout metadata at all are reported but NOT touched: their
 * provenance is unknown, not known-bad, and `cutoutTrust` already refuses them
 * at render time with a message telling the owner to prepare again.
 */
import { MongoClient } from "mongodb";

const apply = process.argv.includes("--apply");
const uri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DB ?? "lilidecoai";

if (!uri) {
  console.error("MONGODB_URI est requise pour inspecter la migration.");
  process.exit(1);
}

const client = new MongoClient(uri);

try {
  await client.connect();
  const database = client.db(databaseName);
  const products = database.collection("products");
  const assets = database.collection("assets");

  const synthetic = await products
    .find({
      $or: [{ "cutout.synthetic": true }, { "cutout.source": "model" }],
    })
    .project({ id: 1, name: 1, organizationId: 1, cutoutAssetId: 1 })
    .toArray();

  // Known-good, known-bad and unknown are three different populations and are
  // counted as three. Folding the unknown into either would misstate the work.
  const unknown = await products.countDocuments({
    cutoutAssetId: { $exists: true },
    $or: [
      { cutout: { $exists: false } },
      { "cutout.cutoutVersion": { $exists: false } },
    ],
  });

  console.log(
    JSON.stringify(
      {
        database: databaseName,
        syntheticCutouts: synthetic.length,
        unknownProvenance: unknown,
        sample: synthetic.slice(0, 10).map((p) => ({ id: p.id, name: p.name })),
        apply,
      },
      null,
      2,
    ),
  );

  if (!apply) {
    console.log(
      "\nExécution à blanc. Relancez avec --apply pour supprimer ces détourages.",
    );
    console.log(
      `${synthetic.length} produit(s) perdront leur détourage et devront être re-préparés par leur propriétaire.`,
    );
    if (unknown) {
      console.log(
        `${unknown} produit(s) ont un détourage de provenance inconnue. Ils ne sont PAS touchés ici : le rendu les refuse déjà et invite à re-préparer.`,
      );
    }
  } else {
    let removed = 0;
    for (const product of synthetic) {
      if (product.cutoutAssetId) {
        // Not deleted here: this script cannot reach the storage adapter, and
        // deleting only the row would orphan the Cloudinary object behind it.
        // Stamping an expiry hands the asset to the purge cron, whose
        // `deleteExpiredAsset` destroys the object and the row together — the
        // one deletion path that is tested.
        await assets.updateOne(
          { id: product.cutoutAssetId },
          { $set: { expiresAt: new Date() } },
        );
      }
      await products.updateOne(
        { id: product.id, organizationId: product.organizationId },
        {
          $set: { status: "processing", updatedAt: new Date() },
          $unset: { cutoutAssetId: "", cutout: "" },
        },
      );
      removed += 1;
    }
    console.log(
      `
${removed} détourage(s) synthétique(s) retiré(s) ; la purge détruira les images.`,
    );
    console.log(
      "Ces produits sont en statut `processing` : leur propriétaire doit relancer la préparation.",
    );
  }
} finally {
  await client.close();
}
