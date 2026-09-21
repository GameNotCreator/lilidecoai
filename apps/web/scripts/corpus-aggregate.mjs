/**
 * Turns filled-in verdict sheets into the classified failure list phase 0 asks
 * for — audit PRO-007.
 *
 *   node apps/web/scripts/corpus-aggregate.mjs corpus/runs/<horodatage>
 *
 * Reads every `verdict.md` of a run, counts what a human actually decided, and
 * refuses to average what the audit says must be reported apart. It publishes
 * the population alongside every rate: a rate over three cases is not a rate.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { aggregate, FAILURE_CODES, rankFailures } from "./corpus-signals.mjs";

const runDir = process.argv[2];
if (!runDir) {
  console.error(
    "Usage : node apps/web/scripts/corpus-aggregate.mjs corpus/runs/<horodatage>",
  );
  process.exit(1);
}

const KNOWN_CODES = new Set(FAILURE_CODES.map(([, code]) => code));

/**
 * Reads one sheet. A sheet whose usable line is still blank is UNJUDGED, and
 * counting it as a failure would be as wrong as counting it as a success — so
 * it is reported separately and excluded from every rate.
 */
function parseVerdict(markdown, caseId, stratum) {
  const usableLine = markdown.match(
    /Utilisable sans retouche \?.*?→\s*(.*)/i,
  )?.[1];
  const answer = (usableLine ?? "").trim().toLowerCase();
  const usable = answer.startsWith("oui")
    ? true
    : answer.startsWith("non")
      ? false
      : null;
  const codes = [...markdown.matchAll(/- \[[xX]\]\s*`([a-z_]+)`/g)]
    .map((match) => match[1])
    .filter((code) => KNOWN_CODES.has(code));
  const simulated = markdown.includes("RUN SIMULÉ");
  return { caseId, stratum, usable, codes, simulated };
}

const report = JSON.parse(
  await readFile(join(runDir, "report.json"), "utf8"),
);
const verdicts = [];
const unjudged = [];

for (const entry of report.cases ?? []) {
  if (!entry.caseId || entry.status === "invalid") continue;
  let markdown;
  try {
    markdown = await readFile(join(runDir, entry.caseId, "verdict.md"), "utf8");
  } catch {
    unjudged.push({ caseId: entry.caseId, reason: "aucune fiche de verdict" });
    continue;
  }
  const verdict = parseVerdict(markdown, entry.caseId, entry.stratum);
  if (verdict.simulated) {
    unjudged.push({ caseId: entry.caseId, reason: "run simulé" });
    continue;
  }
  if (verdict.usable === null) {
    unjudged.push({ caseId: entry.caseId, reason: "verdict non rempli" });
    continue;
  }
  verdicts.push(verdict);
}

const totals = aggregate(verdicts);
// The ranking that says "where to put the next effort" is built from the
// supported perimeter only. Folding experimental failures into it would let an
// out-of-scope category steer the roadmap — the audit forbids exactly that.
const ranking = rankFailures(verdicts);
const codeCounts = Object.fromEntries(ranking.supported);
const experimentalCounts = Object.fromEntries(ranking.experimental);

const rate = totals.supported.rate;
const summary = {
  runId: report.runId,
  measures: report.measures,
  judged: verdicts.length,
  unjudged,
  supported: totals.supported,
  experimental: totals.experimental,
  byStratum: totals.byStratum,
  failuresByCode: codeCounts,
  experimentalFailuresByCode: experimentalCounts,
};
await writeFile(
  join(runDir, "aggregate.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
  "utf8",
);

const stageOf = new Map(FAILURE_CODES.map(([stage, code]) => [code, stage]));
const ranked = ranking.supported;

console.log(`\nRun ${report.runId}`);
console.log(`Ce run mesure : ${report.measures}`);
console.log(
  `\nJugés : ${verdicts.length}. Non jugés : ${unjudged.length}${unjudged.length ? ` (${unjudged.map((u) => `${u.caseId} — ${u.reason}`).join(" ; ")})` : ""}`,
);
if (totals.supported.cases === 0) {
  console.log(
    "\nAucun cas jugé sur le périmètre supporté : aucun taux ne peut être calculé.",
  );
} else {
  console.log(
    `\nPérimètre supporté : ${totals.supported.usable}/${totals.supported.cases} utilisables sans retouche` +
      (rate === null ? "" : ` (${(rate * 100).toFixed(0)} %)`),
  );
  if (totals.supported.cases < 20) {
    console.log(
      `  ATTENTION : ${totals.supported.cases} cas. L'audit en demande 20 pour la phase 0 ; ce taux n'engage rien.`,
    );
  }
}
for (const bucket of totals.experimental) {
  console.log(
    `Expérimental (${bucket.stratum}) — rapporté à part : ${bucket.usable}/${bucket.total}`,
  );
}
if (ranked.length) {
  console.log("\nÉchecs par étape, du plus fréquent au moins fréquent :");
  for (const [code, count] of ranked) {
    console.log(`  ${count}× ${code}  [${stageOf.get(code) ?? "?"}]`);
  }
  console.log(
    "\nL'étape la plus haute de cette liste est celle qui mérite l'effort suivant.",
  );
}
const experimentalRanked = ranking.experimental;
if (experimentalRanked.length) {
  console.log("\nHors périmètre (strates expérimentales), rapporté à part :");
  for (const [code, count] of experimentalRanked) {
    console.log(`  ${count}× ${code}  [${stageOf.get(code) ?? "?"}]`);
  }
}
console.log(`\nDétail : ${join(runDir, "aggregate.json")}`);
