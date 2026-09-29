import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { spatialQualificationV2Schema } from "../spatial-qualification";
import { verifyQualificationFiles } from "./spatial-qualification-files";

const caseSchema = spatialQualificationV2Schema.shape.cases.element;
const humanSchema = caseSchema.shape.human;
const imageSchema = caseSchema.shape.evidence.unwrap().shape.room;
const roleSchema = z.enum(["room", "product", "candidate"]);
const gridSchema = z
  .object({
    version: z.literal(1),
    bundleId: z.uuid(),
    reviews: z
      .array(z.object({ reviewId: z.uuid(), human: humanSchema }).strict())
      .min(1)
      .max(300),
  })
  .strict();
const mappingSchema = z
  .object({
    version: z.literal(1),
    bundleId: z.uuid(),
    sourceManifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    campaign: z.string().min(1),
    engineVersion: z.string(),
    createdAt: z.iso.datetime(),
    cases: z
      .array(
        z
          .object({
            reviewId: z.uuid(),
            caseId: z.string().min(1),
            hasCandidate: z.boolean(),
            assets: z
              .array(
                z
                  .object({
                    role: roleSchema,
                    source: imageSchema,
                    exportedPath: z.string().regex(/^images\/[a-f0-9-]+\.png$/),
                    exportedSha256: z.string().regex(/^[a-f0-9]{64}$/),
                  })
                  .strict(),
              )
              .max(3),
          })
          .strict(),
      )
      .min(1)
      .max(300),
    qualification: z.literal("not-qualified"),
    note: z.string(),
  })
  .strict();

const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
const comparable = (path: string) =>
  process.platform === "win32" ? path.toLowerCase() : path;

async function confined(root: string, name: string) {
  if (isAbsolute(name) || /^[a-zA-Z]:/.test(name) || name.includes("\\"))
    throw new Error("Chemin non relatif au dossier de preuves");
  const path = resolve(root, name);
  if (!inside(root, path)) throw new Error("Chemin hors du dossier de preuves");
  const actual = await realpath(path);
  if (!inside(root, actual)) throw new Error("Lien hors du dossier de preuves");
  return actual;
}

async function jsonBytes(path: string) {
  if ((await stat(path)).size > 8 * 1024 * 1024)
    throw new Error("Document de revue supérieur à 8 Mio");
  const bytes = await readFile(path);
  if (bytes.length > 8 * 1024 * 1024)
    throw new Error("Document de revue supérieur à 8 Mio");
  return bytes;
}

function sameUniqueIds(actual: string[], expected: string[], label: string) {
  if (
    new Set(actual).size !== actual.length ||
    new Set(expected).size !== expected.length
  )
    throw new Error(`Identifiants dupliqués : ${label}`);
  assert.deepEqual(
    [...actual].sort(),
    [...expected].sort(),
    `Identifiants manquants ou étrangers : ${label}`,
  );
}

/** Imports declarations, never an attestation of reviewer identity or quality.
 * Output must be a NEW file beside the original evidence so that every original
 * image path, hash, outcome and measurement remains byte-for-byte in its field.
 */
export async function importSpatialBlindReview(
  bundle: string,
  returnedGrid: string,
  evidenceDirectory: string,
  destination: string,
) {
  const bundleRoot = await realpath(bundle);
  const evidenceRoot = await realpath(evidenceDirectory);
  const output = resolve(destination);
  const outputParent = await realpath(dirname(output));
  if (
    comparable(outputParent) !== comparable(evidenceRoot) ||
    comparable(outputParent) !== comparable(dirname(output))
  )
    throw new Error(
      "Le nouveau manifeste doit être dans le dossier original des preuves, sans lien ni alias",
    );
  const [sourceBytes, mappingBytes, gridBytes, blankBytes, galleryBytes] =
    await Promise.all([
      confined(bundleRoot, "source-manifest.private.json").then(jsonBytes),
      confined(bundleRoot, "mapping.private.json").then(jsonBytes),
      realpath(returnedGrid).then(jsonBytes),
      confined(bundleRoot, "reviewer/review-grid.json").then(jsonBytes),
      confined(bundleRoot, "reviewer/index.html").then(jsonBytes),
    ]);
  const data = spatialQualificationV2Schema.parse(
    JSON.parse(sourceBytes.toString("utf8")),
  );
  const mapping = mappingSchema.parse(
    JSON.parse(mappingBytes.toString("utf8")),
  );
  const grid = gridSchema.parse(JSON.parse(gridBytes.toString("utf8")));
  const blank = gridSchema.parse(JSON.parse(blankBytes.toString("utf8")));
  assert.equal(
    hash(sourceBytes),
    mapping.sourceManifestSha256,
    "Manifeste source modifié",
  );
  assert.equal(
    data.campaign,
    mapping.campaign,
    "Campagne de correspondance différente",
  );
  assert.equal(
    data.engineVersion,
    mapping.engineVersion,
    "Moteur de correspondance différent",
  );
  assert.equal(
    grid.bundleId,
    mapping.bundleId,
    "Grille appartenant à une autre revue",
  );
  assert.equal(
    blank.bundleId,
    mapping.bundleId,
    "Grille vierge appartenant à une autre revue",
  );
  assert.ok(
    blank.reviews.every((entry) => entry.human === null),
    "La grille vierge privée doit rester vide",
  );
  sameUniqueIds(
    mapping.cases.map((entry) => entry.caseId),
    data.cases.map((entry) => entry.id),
    "cas",
  );
  const reviewIds = mapping.cases.map((entry) => entry.reviewId);
  sameUniqueIds(
    blank.reviews.map((entry) => entry.reviewId),
    reviewIds,
    "grille vierge",
  );
  sameUniqueIds(
    grid.reviews.map((entry) => entry.reviewId),
    reviewIds,
    "grille retournée",
  );
  // Bind opaque IDs to the images actually presented in this version-1 gallery.
  // A permutation of mapping reviewIds alone must not reassign observations.
  const html = galleryBytes.toString("utf8");
  const articles = [
    ...html.matchAll(
      /<article><h2>Repère ([a-f0-9-]+)<\/h2><div class="images">([\s\S]*?)<\/div><\/article>/g,
    ),
  ];
  assert.equal(
    (html.match(/<article>/g) ?? []).length,
    articles.length,
    "Galerie non reconnue",
  );
  sameUniqueIds(
    articles.map((entry) => entry[1]!),
    reviewIds,
    "galerie",
  );
  const galleryById = new Map(articles.map((entry) => [entry[1]!, entry[2]!]));
  const labels = {
    room: "Pièce de référence",
    product: "Produit de référence",
    candidate: "Image à examiner",
  };
  for (const entry of mapping.cases) {
    const expected = (["room", "product", "candidate"] as const)
      .map((role) => {
        const path = entry.assets.find(
          (asset) => asset.role === role,
        )?.exportedPath;
        return `<figure><figcaption>${labels[role]}</figcaption>${path ? `<a href="${path}"><img src="${path}" alt="${labels[role]}" loading="lazy"></a>` : "<p>Aucune image fournie.</p>"}</figure>`;
      })
      .join("");
    assert.equal(
      galleryById.get(entry.reviewId),
      expected,
      "Correspondance différente des images présentées dans la galerie",
    );
  }
  const reviews = new Map(
    grid.reviews.map((entry) => [entry.reviewId, entry.human]),
  );
  const byCase = new Map(mapping.cases.map((entry) => [entry.caseId, entry]));
  for (const entry of data.cases) {
    const mapped = byCase.get(entry.id)!;
    assert.equal(
      mapped.hasCandidate,
      Boolean(entry.evidence?.candidate),
      "Présence de candidat incohérente",
    );
    const expectedRoles = (["room", "product", "candidate"] as const).filter(
      (role) => entry.evidence?.[role],
    );
    sameUniqueIds(
      mapped.assets.map((asset) => asset.role),
      expectedRoles,
      "rôles des images",
    );
    for (const asset of mapped.assets)
      assert.deepEqual(
        asset.source,
        entry.evidence?.[asset.role],
        "Image source de correspondance différente",
      );
    const human = reviews.get(mapped.reviewId)!;
    if (human && !entry.evidence?.candidate)
      throw new Error("Avis humain sans image candidate");
    if (human && (!human.reviewer.trim() || !human.notes.trim()))
      throw new Error("Évaluateur et observations ne peuvent être vides");
  }
  const verification = await verifyQualificationFiles(data, evidenceRoot);
  if (verification.errors.length)
    throw new Error(`Preuves invalides : ${verification.errors.join("; ")}`);
  // Read and verify the bytes actually used below, independently of prior file checks.
  const originals = new Map<string, Buffer>();
  let bytesTotal = 0;
  for (const asset of verification.verified) {
    const bytes = await readFile(await confined(evidenceRoot, asset.path));
    assert.equal(
      hash(bytes),
      asset.sha256,
      "Image source modifiée pendant l’import",
    );
    bytesTotal += bytes.length;
    if (bytesTotal > 512 * 1024 * 1024)
      throw new Error("Preuves supérieures à 512 Mio");
    originals.set(JSON.stringify([asset.path, asset.sha256]), bytes);
  }
  const checked = new Set<string>();
  const exports = new Map<string, Buffer>();
  for (const mapped of mapping.cases) {
    for (const asset of mapped.assets) {
      const checkKey = JSON.stringify([
        asset.source,
        asset.exportedPath,
        asset.exportedSha256,
      ]);
      if (checked.has(checkKey)) continue;
      checked.add(checkKey);
      let exported = exports.get(asset.exportedPath);
      if (!exported) {
        exported = await readFile(
          await confined(bundleRoot, `reviewer/${asset.exportedPath}`),
        );
        bytesTotal += exported.length;
        if (bytesTotal > 512 * 1024 * 1024)
          throw new Error("Preuves supérieures à 512 Mio");
        exports.set(asset.exportedPath, exported);
      }
      assert.equal(
        hash(exported),
        asset.exportedSha256,
        "Image exportée modifiée",
      );
      const original = originals.get(
        JSON.stringify([asset.source.path, asset.source.sha256]),
      )!;
      const decode = async (bytes: Buffer) => {
        const image = sharp(bytes, { limitInputPixels: 25_000_000 });
        const metadata = await image.metadata();
        assert.equal(metadata.pages ?? 1, 1, "Image multipage interdite");
        return image
          .rotate()
          .toColourspace("srgb")
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
      };
      const [sourcePixels, exportPixels] = await Promise.all([
        decode(original),
        decode(exported),
      ]);
      assert.equal(
        sourcePixels.info.width,
        exportPixels.info.width,
        "Largeur exportée différente",
      );
      assert.equal(
        sourcePixels.info.height,
        exportPixels.info.height,
        "Hauteur exportée différente",
      );
      assert.deepEqual(
        sourcePixels.data,
        exportPixels.data,
        "Pixels exportés différents des preuves originales",
      );
    }
  }
  const updated = spatialQualificationV2Schema.parse({
    ...data,
    cases: data.cases.map((entry) => ({
      ...entry,
      human: reviews.get(byCase.get(entry.id)!.reviewId)!,
    })),
  });
  // Defense against accidental expansion of the import's write scope.
  assert.deepEqual(
    {
      ...updated,
      cases: updated.cases.map((entry) => ({ ...entry, human: null })),
    },
    { ...data, cases: data.cases.map((entry) => ({ ...entry, human: null })) },
  );
  const outputBytes = Buffer.from(JSON.stringify(updated, null, 2) + "\n");
  // Exclusive creation is last: old manifests, grids and evidence are never written.
  await writeFile(output, outputBytes, { flag: "wx" });
  return {
    manifest: output,
    bundleId: mapping.bundleId,
    cases: updated.cases.length,
    importedReviews: updated.cases.filter((entry) => entry.human !== null)
      .length,
    sourceManifestSha256: hash(sourceBytes),
    mappingSha256: hash(mappingBytes),
    gallerySha256: hash(galleryBytes),
    returnedGridSha256: hash(gridBytes),
    manifestSha256: hash(outputBytes),
    qualification: "not-qualified" as const,
    scope:
      "Import de déclarations vérifiées contre les fichiers ; identité, indépendance et vérité des avis non attestées.",
  };
}
