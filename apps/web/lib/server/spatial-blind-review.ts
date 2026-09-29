import { createHash, randomInt, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import sharp from "sharp";
import { spatialQualificationV2Schema } from "../spatial-qualification";
import { verifyQualificationFiles } from "./spatial-qualification-files";

type Role = "room" | "product" | "candidate";
type PublicEntry = {
  reviewId: string;
  images: Partial<Record<Role, string>>;
};

export type SpatialBlindReviewGrid = {
  version: 1;
  bundleId: string;
  reviews: Array<{ reviewId: string; human: null }>;
};

const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[character]!;
  });
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

const instructions = `# Revue visuelle

Ouvrir index.html dans un navigateur, sans serveur ni connexion Internet. Le dossier contient les images de référence et, lorsqu'elle existe, une image à examiner. Leur ordre et leurs identifiants sont tirés au hasard. Ne pas rechercher leur origine ni demander la correspondance avant de rendre les observations.

Conserver l'intégralité de ce dossier. Compléter une COPIE de review-grid.json : ne modifier ni version, ni bundleId, ni reviewId, ni le nombre d'entrées. Remplacer human: null uniquement après une revue effectivement réalisée. Sans image à examiner, conserver human: null. Aucun avis n'est prérempli.

Pour chaque image examinée, remplacer null par un objet ayant exactement cette structure, en renseignant toutes les valeurs null ci-dessous. Utiliser true ou false pour les critères, un identifiant réel d'évaluateur, la date réelle au format ISO UTC et une observation textuelle non vide. Ne pas recopier des valeurs par défaut : un doute doit être décrit dans notes. blind doit refléter les conditions effectives de la revue.

\`\`\`json
{
  "acceptable": null,
  "majorDesignDefect": null,
  "majorBackgroundDefect": null,
  "reviewer": null,
  "reviewedAt": null,
  "blind": null,
  "checks": {
    "design": null,
    "perspective": null,
    "scale": null,
    "contactLighting": null,
    "background": null
  },
  "notes": null
}
\`\`\`

Critères : design = forme, proportions, matière et détails fidèles au produit ; perspective = orientation cohérente ; scale = taille visuellement plausible ; contactLighting = contact avec le support, lumière, ombres et occultations cohérents ; background = décor préservé. majorDesignDefect et majorBackgroundDefect signalent une altération majeure, indépendamment de l'avis global. acceptable exprime l'avis global, sans remplacer ces critères.

Cette revue visuelle ne mesure aucune dimension physique et ne démontre aucune qualification. L'indépendance de l'évaluateur ne peut pas être attestée par ce dossier. Ne pas renseigner de mesures supposées. Une inscription visible dans les pixels peut révéler l'origine d'une image : le signaler dans notes et indiquer blind: false si l'aveugle est compromis.

Retourner la copie complétée de review-grid.json à l'organisateur. La correspondance et le manifeste source restent chez lui ; ne pas les consulter avant la fin de la revue.
`;

function gallery(entries: PublicEntry[]) {
  const labels: Record<Role, string> = {
    room: "Pièce de référence",
    product: "Produit de référence",
    candidate: "Image à examiner",
  };
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer"><title>Revue visuelle</title>
<style>body{font:16px system-ui;margin:2rem;background:#f6f4ef;color:#242424}main{max-width:1400px;margin:auto}article{background:white;padding:1.5rem;margin:2rem 0;border:1px solid #d4d0c8;border-radius:12px}h2{font-size:1rem;overflow-wrap:anywhere}.images{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:1rem}figure{margin:0}img{width:100%;height:440px;object-fit:contain;background:#eee}figcaption{margin:.5rem 0}a{color:#234f75}</style>
</head><body><main><h1>Revue visuelle</h1>
<p>Lire <a href="instructions.md">les instructions</a>, puis compléter une copie de <a href="review-grid.json" download>la grille vierge</a>. Aucun avis n'est prérempli. Cette galerie ne démontre aucune qualification.</p>
${entries.map((entry) => `<article><h2>Repère ${escapeHtml(entry.reviewId)}</h2><div class="images">${(["room", "product", "candidate"] as const).map((role) => `<figure><figcaption>${labels[role]}</figcaption>${entry.images[role] ? `<a href="${escapeHtml(entry.images[role]!)}"><img src="${escapeHtml(entry.images[role]!)}" alt="${labels[role]}" loading="lazy"></a>` : "<p>Aucune image fournie.</p>"}</figure>`).join("")}</div></article>`).join("\n")}
</main></body></html>\n`;
}

/** Local preparation only: every observation stays empty. The public folder
 * intentionally excludes source identifiers, outcomes and prior annotations. */
export async function prepareSpatialBlindReview(
  source: string,
  destination: string,
) {
  const sourcePath = await realpath(source);
  const sourceBytes = await readFile(sourcePath);
  const data = spatialQualificationV2Schema.parse(
    JSON.parse(sourceBytes.toString("utf8")),
  );
  if (
    !data.cases.length ||
    data.cases.length > 300 ||
    !data.cases.some((entry) => entry.evidence)
  )
    throw new Error(
      "La revue exige 1 à 300 cas et au moins une preuve image ; un modèle vide ne constitue pas une campagne.",
    );
  const root = await realpath(dirname(sourcePath));
  const verification = await verifyQualificationFiles(data, root);
  if (verification.errors.length)
    throw new Error(`Preuves invalides : ${verification.errors.join("; ")}`);

  // Re-read and hash the very bytes used for export. A prior successful check
  // must not allow a modified file to slip into the reviewer bundle.
  const images = new Map<string, { bytes: Buffer; sha256: string }>();
  let bytesTotal = 0;
  for (const asset of verification.verified) {
    const key = JSON.stringify([asset.path, asset.sha256]);
    const path = await realpath(resolve(root, asset.path));
    if (!inside(root, path)) throw new Error("Lien hors du dossier de preuves");
    const bytes = await readFile(path);
    if (hash(bytes) !== asset.sha256)
      throw new Error(`Preuve modifiée : ${asset.path}`);
    const decoder = sharp(bytes, { limitInputPixels: 25_000_000 });
    const metadata = await decoder.metadata();
    if ((metadata.pages ?? 1) !== 1)
      throw new Error(
        "Les images animées ou multipages ne sont pas admises dans la revue",
      );
    // Canonical PNG strips EXIF/XMP/ICC/comments that could expose source names.
    // Honor display orientation before removing EXIF; originals stay untouched.
    const decoded = await decoder
      .rotate()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const png = await sharp(decoded.data, {
      raw: {
        width: decoded.info.width,
        height: decoded.info.height,
        channels: decoded.info.channels,
      },
    })
      .png()
      .toBuffer();
    bytesTotal += png.length;
    if (bytesTotal > 512 * 1024 * 1024)
      throw new Error(
        "Export supérieur à 512 Mio : scinder la préparation de revue sans modifier le corpus source",
      );
    images.set(key, { bytes: png, sha256: hash(png) });
  }

  const ordered = data.cases.map((entry) => ({
    entry,
    reviewId: randomUUID(),
  }));
  for (let index = ordered.length - 1; index > 0; index--) {
    const other = randomInt(index + 1);
    [ordered[index], ordered[other]] = [ordered[other]!, ordered[index]!];
  }
  const bundleId = randomUUID();
  const entries: PublicEntry[] = [];
  const files: Array<{ path: string; bytes: Buffer }> = [];
  const exportedPaths = new Map<string, string>();
  const mapping = ordered.map(({ entry, reviewId }) => {
    const exposed: PublicEntry = { reviewId, images: {} };
    const assets = (["room", "product", "candidate"] as const).flatMap(
      (role) => {
        const asset = entry.evidence?.[role];
        if (!asset) return [];
        const key = JSON.stringify([asset.path, asset.sha256]);
        const image = images.get(key)!;
        let path = exportedPaths.get(key);
        if (!path) {
          path = `images/${randomUUID()}.png`;
          exportedPaths.set(key, path);
          // The 512 MiB bound above counts unique encoded images. Export each
          // once even when many cases reuse a room or catalogue photograph.
          files.push({ path, bytes: image.bytes });
        }
        exposed.images[role] = path;
        return [
          {
            role,
            source: asset,
            exportedPath: path,
            exportedSha256: image.sha256,
          },
        ];
      },
    );
    entries.push(exposed);
    return {
      reviewId,
      caseId: entry.id,
      hasCandidate: Boolean(entry.evidence?.candidate),
      assets,
    };
  });
  const grid: SpatialBlindReviewGrid = {
    version: 1,
    bundleId,
    reviews: entries.map(({ reviewId }) => ({ reviewId, human: null })),
  };
  const output = resolve(destination);
  // Require an existing parent and exclusively create the destination: never
  // reuse an existing directory, even when it is empty or a symlink.
  const parent = await realpath(dirname(output));
  const comparable = (path: string) =>
    process.platform === "win32" ? path.toLowerCase() : path;
  if (comparable(parent) !== comparable(dirname(output)))
    throw new Error(
      "Le parent de sortie doit être un chemin réel, sans lien ni alias",
    );
  await mkdir(output);
  const reviewerDirectory = resolve(output, "reviewer");
  await mkdir(reviewerDirectory);
  await mkdir(resolve(reviewerDirectory, "images"));
  for (const file of files)
    await writeFile(resolve(reviewerDirectory, file.path), file.bytes, {
      flag: "wx",
    });
  const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
  await writeFile(
    resolve(output, "source-manifest.private.json"),
    sourceBytes,
    { flag: "wx" },
  );
  await writeFile(
    resolve(output, "mapping.private.json"),
    json({
      version: 1,
      bundleId,
      sourceManifestSha256: hash(sourceBytes),
      campaign: data.campaign,
      engineVersion: data.engineVersion,
      createdAt: new Date().toISOString(),
      cases: mapping,
      qualification: "not-qualified",
      note: "Correspondance privée : transmettre uniquement le sous-dossier reviewer. Aucune revue ni mesure produite.",
    }),
    { flag: "wx" },
  );
  await writeFile(
    resolve(output, "README.private.txt"),
    "Transmettre uniquement le sous-dossier reviewer. Conserver privés mapping.private.json et source-manifest.private.json. Une préparation réussie ne qualifie pas la campagne. Si la commande échoue, ne pas remettre le dossier partiel. Les identifiants et métadonnées sont masqués ; les inscriptions visibles dans les pixels doivent être examinées par l'organisateur avant remise.\n",
    { flag: "wx" },
  );
  await writeFile(resolve(reviewerDirectory, "review-grid.json"), json(grid), {
    flag: "wx",
  });
  await writeFile(resolve(reviewerDirectory, "instructions.md"), instructions, {
    flag: "wx",
  });
  // The entry point is last, so an interrupted export is visibly incomplete.
  await writeFile(resolve(reviewerDirectory, "index.html"), gallery(entries), {
    flag: "wx",
  });
  return {
    reviewerDirectory,
    sourceManifestSha256: hash(sourceBytes),
    bundleId,
    cases: entries.length,
    images: files.length,
  };
}
