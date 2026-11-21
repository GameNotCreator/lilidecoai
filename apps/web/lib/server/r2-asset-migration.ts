import "server-only";

import { randomUUID } from "node:crypto";
import { Binary, type Db, type Filter, type WithId } from "mongodb";
import {
  assetChecksum,
  type R2AssetReference,
  type R2Storage,
} from "./r2-storage";
import type { AssetDocument } from "./types";

type Mode = "copy" | "prune" | "restore";
type StoredAsset = WithId<AssetDocument>;

export class MigrationPreflightError extends Error {}

export async function auditMongoStorage(db: Db) {
  const names = await db
    .listCollections(
      { type: "collection" },
      { nameOnly: true, authorizedCollections: true },
    )
    .toArray();
  const collections = [];
  for (const { name } of names) {
    try {
      const stats = await db.command({ collStats: name, maxTimeMS: 30_000 });
      collections.push({
        name,
        documents: Number(stats.count),
        dataBytes: Number(stats.size),
        storageBytes: Number(stats.storageSize),
        indexBytes: Number(stats.totalIndexSize),
      });
    } catch {
      // Some Atlas tiers do not expose collStats.
      const [stats] = await db
        .collection(name)
        .aggregate<{
          documents: number;
          dataBytes: number;
        }>(
          [
            {
              $group: {
                _id: null,
                documents: { $sum: 1 },
                dataBytes: { $sum: { $bsonSize: "$$ROOT" } },
              },
            },
          ],
          { maxTimeMS: 30_000 },
        )
        .toArray();
      collections.push({
        name,
        documents: stats?.documents ?? 0,
        dataBytes: stats?.dataBytes ?? 0,
        storageBytes: null,
        indexBytes: null,
      });
    }
  }

  const binary = { $eq: [{ $type: "$bytes" }, "binData"] };
  const expired = {
    $and: [
      { $eq: [{ $type: "$expiresAt" }, "date"] },
      { $lte: ["$expiresAt", "$$NOW"] },
    ],
  };
  const assets = await db
    .collection("assets")
    .aggregate(
      [
        {
          $group: {
            _id: {
              kind: "$kind",
              visibility: { $ifNull: ["$visibility", "private"] },
            },
            documents: { $sum: 1 },
            inlineDocuments: { $sum: { $cond: [binary, 1, 0] } },
            inlineBytes: {
              $sum: { $cond: [binary, { $binarySize: "$bytes" }, 0] },
            },
            cloudinaryDocuments: {
              $sum: {
                $cond: [
                  { $eq: [{ $type: "$cloudinaryPublicId" }, "string"] },
                  1,
                  0,
                ],
              },
            },
            r2Documents: {
              $sum: {
                $cond: [{ $eq: [{ $type: "$r2.key" }, "string"] }, 1, 0],
              },
            },
            expiredDocuments: { $sum: { $cond: [expired, 1, 0] } },
            expiredInlineBytes: {
              $sum: {
                $cond: [
                  { $and: [binary, expired] },
                  { $binarySize: "$bytes" },
                  0,
                ],
              },
            },
          },
        },
        { $sort: { inlineBytes: -1 } },
      ],
      { maxTimeMS: 30_000 },
    )
    .toArray();
  return {
    collections: collections.sort((a, b) => b.dataBytes - a.dataBytes),
    assets,
  };
}

function activeAssets(): Filter<AssetDocument> {
  return {
    purgeClaimedAt: { $exists: false },
    $or: [
      { expiresAt: { $exists: false } },
      { expiresAt: { $type: "null" } },
      { expiresAt: { $gt: new Date() } },
    ],
  };
}

function unchangedAsset(asset: StoredAsset): Filter<AssetDocument> {
  return {
    ...activeAssets(),
    _id: asset._id,
    createdAt: asset.createdAt,
    contentType: asset.contentType,
    bytes: asset.bytes ?? { $exists: false },
    r2: asset.r2 ?? { $exists: false },
  };
}

async function verifyPublicR2Read(
  db: Db,
  site: string | undefined,
): Promise<void> {
  const origin = site && URL.canParse(site) ? new URL(site) : null;
  if (
    !origin ||
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new MigrationPreflightError(
      "Indiquez l’origine HTTPS du site déployé avec --site.",
    );
  }
  const probe = await db.collection<AssetDocument>("assets").findOne({
    ...activeAssets(),
    visibility: "published",
    r2: { $exists: true },
  });
  if (!probe?.r2) {
    throw new MigrationPreflightError(
      "Aucune image publiée sur R2 pour vérifier la lecture du site.",
    );
  }
  const url = new URL(`/api/assets/${encodeURIComponent(probe.id)}`, origin);
  const expected = probe.r2.sha256;
  url.searchParams.set("r2-check", randomUUID());
  const confirmed = await fetch(url, {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  })
    .then(
      async (response) =>
        response.ok &&
        response.headers.get("X-Lili-Asset-Storage") === "r2" &&
        assetChecksum(Buffer.from(await response.arrayBuffer())) === expected,
    )
    .catch(() => false);
  if (!confirmed) {
    throw new MigrationPreflightError(
      "Le site déployé ne confirme pas la lecture de l’image depuis R2.",
    );
  }
}

export async function migrateR2Assets(
  db: Db,
  storage: R2Storage,
  { mode, limit, site }: { mode: Mode; limit: number; site?: string },
) {
  if (mode === "prune") await verifyPublicR2Read(db, site);

  const assets = db.collection<AssetDocument>("assets");
  const filter: Filter<AssetDocument> = {
    ...activeAssets(),
    bytes: mode === "restore" ? { $exists: false } : { $type: "binData" },
    r2: { $exists: mode !== "copy" },
  };
  const report = {
    mode,
    inspected: 0,
    changed: 0,
    bytes: 0,
    skipped: 0,
    failed: 0,
    cleanupFailures: 0,
  };
  const cursor = assets
    .find(filter)
    .sort({ _id: 1 })
    .limit(limit)
    .batchSize(20);
  try {
    for await (const asset of cursor) {
      report.inspected++;
      const inline = asset.bytes ? Buffer.from(asset.bytes.value()) : null;
      let uploaded: R2AssetReference | undefined;
      let mustKeepUpload = false;
      try {
        if (mode === "copy" && inline) {
          uploaded = await storage.put(inline, asset.contentType);
        }
        const ref = uploaded ?? asset.r2;
        if (!ref) throw new Error("Référence R2 manquante.");
        const remote = await storage.read(ref);
        if (!remote || (inline && !remote.equals(inline))) {
          throw new Error("Copie R2 manquante ou différente.");
        }
        // A write error can follow a committed update. Leave its verified object
        // in place unless MongoDB confirms that the snapshot did not match.
        mustKeepUpload = true;
        const result = await assets.updateOne(
          unchangedAsset(asset),
          mode === "copy"
            ? { $set: { r2: ref } }
            : mode === "prune"
              ? { $unset: { bytes: "" } }
              : { $set: { bytes: new Binary(remote) } },
        );
        mustKeepUpload = result.modifiedCount > 0;
        if (mustKeepUpload) {
          report.changed++;
          report.bytes += remote.length;
        } else {
          report.skipped++;
        }
      } catch {
        report.failed++;
      } finally {
        if (uploaded && !mustKeepUpload) {
          await storage.delete(uploaded).catch(() => {
            report.cleanupFailures++;
          });
        }
      }
    }
  } finally {
    await cursor.close();
  }
  return report;
}
