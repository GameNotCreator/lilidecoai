import { importSpatialBlindReview } from "../lib/server/spatial-blind-review-import";

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4)
    throw new Error(
      "Usage: node --import tsx apps/web/scripts/spatial-import-review.ts dossier-revue grille-retournee.json dossier-preuves-originales nouveau-manifeste.json",
    );
  console.log(
    JSON.stringify(
      await importSpatialBlindReview(args[0]!, args[1]!, args[2]!, args[3]!),
      null,
      2,
    ),
  );
}
main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Import de revue impossible",
  );
  process.exitCode = 1;
});
