import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import sharp from "sharp";
import {
  qualificationImages,
  type SpatialQualificationV2,
  type QualificationFileVerification,
} from "../spatial-qualification";

/** Offline only. Bundle-relative paths prevent a manifest from reading files
 * outside its evidence directory (including via symlinks). Nothing is uploaded. */
export async function verifyQualificationFiles(
  data: SpatialQualificationV2,
  directory: string,
): Promise<QualificationFileVerification> {
  const root = await realpath(directory);
  const result: QualificationFileVerification = { verified: [], errors: [] };
  const seen = new Set<string>();
  for (const asset of qualificationImages(data)) {
    const key = JSON.stringify([asset.path, asset.sha256]);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (
        isAbsolute(asset.path) ||
        /^[a-zA-Z]:/.test(asset.path) ||
        asset.path.includes("\\")
      )
        throw new Error("Chemin non relatif au dossier de preuves");
      const inside = (path: string) => {
        const rel = relative(root, path);
        return (
          rel !== ".." &&
          !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
          !isAbsolute(rel)
        );
      };
      const path = resolve(root, asset.path);
      if (!inside(path)) throw new Error("Chemin hors du dossier de preuves");
      const actual = await realpath(path);
      if (!inside(actual)) throw new Error("Lien hors du dossier de preuves");
      const bytes = await readFile(actual);
      if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
        throw new Error("Empreinte différente");
      const metadata = await sharp(bytes, {
        limitInputPixels: 25_000_000,
      }).metadata();
      if (
        !metadata.width ||
        !metadata.height ||
        !["png", "jpeg", "webp"].includes(metadata.format ?? "")
      )
        throw new Error("Image PNG, JPEG ou WebP attendue");
      // Decode as well: a readable header alone does not prove an intact image.
      await sharp(bytes, { limitInputPixels: 25_000_000 }).raw().toBuffer();
      result.verified.push(asset);
    } catch (reason) {
      result.errors.push(
        `${asset.path}: ${reason instanceof Error ? reason.message : "Lecture impossible"}`,
      );
    }
  }
  return result;
}
