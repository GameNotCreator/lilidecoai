import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceDigest, SPLITS } from "./corpus-comparison.mjs";
import { validateCase } from "./corpus-signals.mjs";

const directory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../corpus/cases",
);
const cases = [];
const invalid = [];
const ids = new Set();
for (const name of await readdir(directory)) {
  if (!name.endsWith(".json") || name.startsWith("_")) continue;
  try {
    const item = JSON.parse(await readFile(join(directory, name), "utf8"));
    const issues = validateCase(item);
    if (!/^[a-zA-Z0-9_-]+$/.test(item.id))
      issues.push("Identifiant de cas invalide");
    if (ids.has(item.id)) issues.push("Identifiant dupliqué");
    ids.add(item.id);
    if (!SPLITS.includes(item.split ?? "pilot")) issues.push("Split invalide");
    for (const [axis, number] of Object.entries(
      item.product?.dimensionsCm ?? {},
    ))
      if (typeof number !== "number" || !Number.isFinite(number) || number <= 0)
        issues.push(`Dimension invalide : ${axis}`);
    if (issues.length) {
      invalid.push({ file: name, issues });
      continue;
    }
    await sourceDigest(item, directory);
    cases.push(item);
  } catch (reason) {
    invalid.push({ file: name, issues: [reason.message] });
  }
}
const counts = Object.fromEntries(
  SPLITS.map((split) => [
    split,
    cases.filter((c) => (c.split ?? "pilot") === split).length,
  ]),
);
console.log(
  JSON.stringify(
    {
      authorizedCasesWithFiles: cases.length,
      counts,
      invalid,
      pilotPopulationReady: counts.pilot >= 20 && invalid.length === 0,
      finalPopulationReady:
        cases.length >= 120 && counts.holdout >= 30 && invalid.length === 0,
      qualityMeasured: false,
    },
    null,
    2,
  ),
);
if (counts.pilot < 20 || invalid.length) process.exitCode = 2;
