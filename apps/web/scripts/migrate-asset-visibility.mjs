/**
 * Stamps `visibility` (and `ownerSessionId`) on assets written before those
 * fields existed — audit finding A16.
 *
 * Readability used to be inferred from the asset kind, so every `product` and
 * `cutout` was world-readable. `asset-access.ts` now reads a missing
 * `visibility` as private, which fails closed: without this migration a
 * catalogue image answers 403 instead of leaking an upload. Run it once per
 * database, dry by default, with `--apply` to write.
 *
 * Ownership is reconstructed from the documents that reference each asset,
 * never from the kind:
 *
 * - product / product_view / cutout → the product that points at it. Created
 *   by a visitor session (a prefixed `createdByUserId`) → private to that
 *   session; otherwise published only when the product status is `ready`.
 * - scene → the scene document, private to its `publicSessionId` when it has
 *   one, to the organization otherwise.
 * - render → the render document, same rule.
 * - mask → the segmentation, then its scene, same rule.
 *
 * An asset no document references is left private and reported: guessing a
 * scope for an orphan would be inventing an owner.
 */
import { MongoClient } from "mongodb";

const apply = process.argv.includes("--apply");
const uri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DB ?? "lilidecoai";

if (!uri) {
  console.error("MONGODB_URI est requise pour inspecter la migration.");
  process.exit(1);
}

/**
 * Two different fields carry the session, and they are NOT interchangeable.
 *
 * `publicSessionId` on a scene, render or segmentation is the session id
 * itself: `guest:<uuid>` for a guest editor session (auth.ts createGuestSession)
 * but a BARE uuid for a widget session (auth.ts createPublicSession). Reading
 * it through a prefix test would classify every widget visitor's room photo as
 * organization-owned — that is, readable by the shared demo identity, which is
 * the very leak this migration closes.
 */
function scopeFromOwner(owner) {
  const candidate = owner?.publicSessionId;
  return typeof candidate === "string" && candidate ? candidate : undefined;
}

/**
 * `createdByUserId` on a product is a user id, and only a prefixed one belongs
 * to a session. Guests are the only sessions that may create products
 * (`requireProductEditor`), and for them user id and session id are the same
 * `guest:<uuid>`; the `public:` branch is defensive.
 */
function scopeFromCreator(owner) {
  const candidate = owner?.createdByUserId;
  if (typeof candidate !== "string") return undefined;
  if (candidate.startsWith("guest:")) return candidate;
  if (candidate.startsWith("public:")) return candidate.slice("public:".length);
  return undefined;
}

const client = new MongoClient(uri);

try {
  await client.connect();
  const database = client.db(databaseName);
  const assets = database.collection("assets");
  const products = database.collection("products");
  const scenes = database.collection("scenes");
  const renders = database.collection("renders");
  const segmentations = database.collection("segmentations");

  const pending = await assets
    .find({
      $or: [
        { visibility: { $exists: false } },
        { kind: { $in: ["product", "product_view", "cutout"] } },
      ],
    })
    .project({ id: 1, kind: 1, organizationId: 1 })
    .toArray();

  const plan = [];
  const orphans = [];

  for (const asset of pending) {
    let owner = null;
    let published = false;

    if (["product", "product_view", "cutout"].includes(asset.kind)) {
      owner = await products.findOne(
        {
          $or: [
            { assetId: asset.id },
            { cutoutAssetId: asset.id },
            { "views.assetId": asset.id },
          ],
        },
        { projection: { createdByUserId: 1, status: 1 } },
      );
      published =
        Boolean(owner) &&
        scopeFromCreator(owner) === undefined &&
        owner.status === "ready";
    } else if (asset.kind === "scene") {
      owner = await scenes.findOne(
        { assetId: asset.id },
        { projection: { publicSessionId: 1 } },
      );
    } else if (asset.kind === "render") {
      owner = await renders.findOne(
        {
          $or: [
            { resultAssetId: asset.id },
            { compositeAssetId: asset.id },
            { selectedResultAssetId: asset.id },
          ],
        },
        { projection: { publicSessionId: 1 } },
      );
    } else if (asset.kind === "mask") {
      owner =
        (await segmentations.findOne(
          { maskAssetId: asset.id },
          { projection: { publicSessionId: 1 } },
        )) ??
        (await renders.findOne(
          { targetMaskAssetId: asset.id },
          { projection: { publicSessionId: 1 } },
        ));
    }

    if (!owner) {
      orphans.push({ id: asset.id, kind: asset.kind });
      plan.push({ id: asset.id, visibility: "private" });
      continue;
    }
    if (published) {
      plan.push({ id: asset.id, visibility: "published" });
      continue;
    }
    const ownerSessionId =
      asset.kind === "product" ||
      asset.kind === "product_view" ||
      asset.kind === "cutout"
        ? scopeFromCreator(owner)
        : scopeFromOwner(owner);
    plan.push({
      id: asset.id,
      visibility: "private",
      ...(ownerSessionId ? { ownerSessionId } : {}),
    });
  }

  const counts = plan.reduce((totals, item) => {
    const key = item.visibility === "published"
      ? "published"
      : item.ownerSessionId
        ? "private_session"
        : "private_organization";
    totals[key] = (totals[key] ?? 0) + 1;
    return totals;
  }, {});

  console.log(
    JSON.stringify(
      {
        database: databaseName,
        pending: pending.length,
        counts,
        orphans: orphans.length,
        orphanSample: orphans.slice(0, 10),
        apply,
      },
      null,
      2,
    ),
  );

  if (!apply) {
    console.log("Exécution à blanc. Relancez avec --apply pour écrire.");
    // On a database that has served widget or demo traffic, zero
    // session-scoped assets is the signature of a scoping bug, not of a clean
    // database. Check before writing.
    if (pending.length > 0 && !counts.private_session) {
      console.warn(
        "AUCUNE image rattachée à une session : vérifiez le rattachement avant --apply.",
      );
    }
  } else {
    for (const item of plan) {
      await assets.updateOne(
        { id: item.id },
        {
          $set: {
            visibility: item.visibility,
            ...(item.ownerSessionId
              ? { ownerSessionId: item.ownerSessionId }
              : {}),
          },
          ...(!item.ownerSessionId ? { $unset: { ownerSessionId: "" } } : {}),
        },
      );
    }
    console.log(`${plan.length} images mises à jour.`);
  }
} finally {
  await client.close();
}
