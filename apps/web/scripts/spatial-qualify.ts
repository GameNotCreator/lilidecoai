import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  qualifySpatialCorpus,
  spatialQualificationV2Schema,
} from "../lib/spatial-qualification";
import { verifyQualificationFiles } from "../lib/server/spatial-qualification-files";
async function main() {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination)
    throw new Error(
      "Usage: node --import tsx apps/web/scripts/spatial-qualify.ts annotations.json new-report.json",
    );
  const input = JSON.parse(await readFile(source, "utf8"));
  const files =
    input?.version === 2
      ? await verifyQualificationFiles(
          spatialQualificationV2Schema.parse(input),
          dirname(resolve(source)),
        )
      : undefined;
  const result = qualifySpatialCorpus(input, files);
  await writeFile(destination, JSON.stringify(result, null, 2) + "\n", {
    flag: "wx",
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.qualified) process.exitCode = 2;
}
main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Qualification failed",
  );
  process.exitCode = 1;
});
