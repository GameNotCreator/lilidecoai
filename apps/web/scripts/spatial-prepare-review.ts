import { prepareSpatialBlindReview } from "../lib/server/spatial-blind-review";

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2)
    throw new Error(
      "Usage: node --import tsx apps/web/scripts/spatial-prepare-review.ts annotations.json nouveau-dossier",
    );
  const result = await prepareSpatialBlindReview(args[0]!, args[1]!);
  console.log(
    JSON.stringify(
      {
        ...result,
        qualification: "not-qualified",
        instructions:
          "Transmettre uniquement le sous-dossier reviewer. Les grilles restent vierges.",
      },
      null,
      2,
    ),
  );
}
main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Préparation de revue impossible",
  );
  process.exitCode = 1;
});
