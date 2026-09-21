import assert from "node:assert/strict";
import { createHash, randomInt } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SPLITS = ["pilot", "tuning", "holdout"];
export function eligibleSplit(item, split) {
  assert.ok(SPLITS.includes(split), "Split attendu : pilot, tuning ou holdout");
  return (item.split ?? "pilot") === split;
}

/** Same JSON plus exact photo bytes; never pair runs merely by case name. */
export async function sourceDigest(item, directory) {
  const manifest = { ...item };
  delete manifest.__file;
  const hash = createHash("sha256").update(JSON.stringify(manifest));
  for (const file of [
    item.room?.file,
    item.product?.file,
    item.groundTruth?.referencePhoto,
  ].filter(Boolean)) {
    const path = resolve(directory, file);
    assert.ok(
      path.startsWith(resolve(directory) + "/") ||
        path.startsWith(resolve(directory) + "\\"),
      "Source hors du dossier corpus",
    );
    hash.update(await readFile(path));
  }
  return hash.digest("hex");
}

export function pairReports(baseline, candidate, coin = () => randomInt(2)) {
  assert.equal(
    baseline.server?.mockMode,
    false,
    "La référence doit être réelle",
  );
  assert.equal(
    candidate.server?.mockMode,
    false,
    "La candidate doit être réelle",
  );
  assert.equal(
    baseline.split,
    candidate.split,
    "Les splits doivent correspondre",
  );
  assert.ok(SPLITS.includes(candidate.split), "Split manquant");
  const left = new Map(baseline.cases.map((c) => [c.caseId, c]));
  const right = new Map(candidate.cases.map((c) => [c.caseId, c]));
  assert.equal(
    left.size,
    baseline.cases.length,
    "Identifiants de référence dupliqués",
  );
  assert.equal(
    right.size,
    candidate.cases.length,
    "Identifiants candidats dupliqués",
  );
  assert.ok(
    left.size > 0 && left.size === right.size,
    "Les populations doivent être identiques et non vides",
  );
  return [...left].map(([caseId, a], index) => {
    const b = right.get(caseId);
    assert.ok(
      b && a.sourceDigest && a.sourceDigest === b.sourceDigest,
      `Sources différentes ou absentes : ${caseId}`,
    );
    assert.ok(
      [a, b].every(
        (r) => r.status !== "succeeded" || r.engineVersions?.mockMode === false,
      ),
      `Mode réel non attesté : ${caseId}`,
    );
    assert.equal(a.stratum, b.stratum, `Strate différente : ${caseId}`);
    const swap = coin() === 1;
    return {
      id: `pair-${String(index + 1).padStart(3, "0")}`,
      caseId,
      stratum: b.stratum,
      sourceDigest: a.sourceDigest,
      arms: swap
        ? { A: "candidate", B: "baseline" }
        : { A: "baseline", B: "candidate" },
      records: { baseline: a, candidate: b },
    };
  });
}

const judgementFields = [
  "usable",
  "identityCritical",
  "occlusionCritical",
  "realism",
];
function validVerdict(v) {
  return (
    v &&
    typeof v.usable === "boolean" &&
    typeof v.identityCritical === "boolean" &&
    typeof v.occlusionCritical === "boolean" &&
    Number.isInteger(v.realism) &&
    v.realism >= 1 &&
    v.realism <= 5
  );
}
function sameVerdict(a, b) {
  return judgementFields.every((key) => a[key] === b[key]);
}

export function compareVerdicts(
  key,
  first,
  second,
  arbitration = { items: [] },
) {
  assert.ok(
    first.evaluator && second.evaluator && first.evaluator !== second.evaluator,
    "Deux évaluateurs distincts sont requis",
  );
  if (arbitration.items?.length)
    assert.ok(
      arbitration.evaluator &&
        ![first.evaluator, second.evaluator].includes(arbitration.evaluator),
      "L'arbitre doit être distinct des deux évaluateurs",
    );
  const lookup = (sheet) => {
    const map = new Map();
    for (const item of sheet.items ?? []) {
      const id = `${item.pair}:${item.arm}`;
      assert.ok(!map.has(id), `Verdict dupliqué : ${id}`);
      map.set(id, item);
    }
    return map;
  };
  const a = lookup(first),
    b = lookup(second),
    arb = lookup(arbitration);
  const totals = Object.fromEntries(
    ["supported", "experimental"].map((scope) => [
      scope,
      Object.fromEntries(
        ["baseline", "candidate"].map((arm) => [
          arm,
          {
            inputs: 0,
            delivered: 0,
            judged: 0,
            usable: 0,
            criticalIdentity: 0,
            criticalOcclusion: 0,
            realismTotal: 0,
            unknown: 0,
          },
        ]),
      ),
    ]),
  );
  const unresolved = [];
  for (const pair of key.pairs)
    for (const arm of ["A", "B"]) {
      const engine = pair.arms[arm];
      const source = pair.records[engine];
      const total =
        totals[pair.stratum === "experimental" ? "experimental" : "supported"][
          engine
        ];
      total.inputs++;
      const delivered =
        source.status === "succeeded" && source.signals?.quality === "accepted";
      if (!delivered) {
        if (["unknown", "processing", "queued"].includes(source.status))
          total.unknown++;
        continue;
      }
      total.delivered++;
      const id = `${pair.id}:${arm}`;
      const v1 = a.get(id),
        v2 = b.get(id);
      let verdict;
      if (validVerdict(v1) && validVerdict(v2)) {
        verdict = sameVerdict(v1, v2)
          ? v1
          : validVerdict(arb.get(id))
            ? arb.get(id)
            : undefined;
      }
      if (!verdict) {
        unresolved.push(id);
        continue;
      }
      total.judged++;
      const critical = verdict.identityCritical || verdict.occlusionCritical;
      total.usable += Number(verdict.usable && !critical);
      total.criticalIdentity += Number(verdict.identityCritical);
      total.criticalOcclusion += Number(verdict.occlusionCritical);
      total.realismTotal += verdict.realism;
    }
  for (const scope of Object.values(totals))
    for (const total of Object.values(scope)) {
      total.usefulInputRate = total.inputs ? total.usable / total.inputs : null;
      total.usefulDeliveryRate =
        total.delivered && total.judged === total.delivered
          ? total.usable / total.delivered
          : null;
      total.meanRealism = total.judged
        ? total.realismTotal / total.judged
        : null;
    }
  return {
    split: key.split,
    pairCount: key.pairs.length,
    unresolved,
    totals,
    complete:
      unresolved.length === 0 &&
      Object.values(totals).every((scope) =>
        Object.values(scope).every((t) => t.unknown === 0),
      ),
    productionValidated: false,
  };
}

async function main(args) {
  const [command, ...paths] = args;
  const json = async (file) => JSON.parse(await readFile(file, "utf8"));
  if (command === "prepare") {
    const [baselineDir, candidateDir, outputDir] = paths;
    assert.ok(
      baselineDir && candidateDir && outputDir,
      "prepare <baseline-run> <candidate-run> <new-output-directory>",
    );
    const baseline = await json(join(baselineDir, "report.json"));
    const candidate = await json(join(candidateDir, "report.json"));
    const pairs = pairReports(baseline, candidate);
    // Fail if the destination exists: never overwrite completed assessments.
    await mkdir(outputDir);
    await mkdir(join(outputDir, "blind"));
    const items = [];
    for (const pair of pairs) {
      assert.ok(
        /^[a-zA-Z0-9_-]+$/.test(pair.caseId),
        "Identifiant de cas invalide",
      );
      const referenceEngine = pair.records.baseline.referenceFiles
        ? "baseline"
        : "candidate";
      for (const [role, file] of Object.entries(
        pair.records[referenceEngine].referenceFiles ?? {},
      )) {
        assert.ok(/^[a-zA-Z0-9_.-]+$/.test(file), "Nom de référence invalide");
        await copyFile(
          join(
            referenceEngine === "baseline" ? baselineDir : candidateDir,
            pair.caseId,
            file,
          ),
          join(
            outputDir,
            "blind",
            `${pair.id}-${role}${file.slice(file.lastIndexOf("."))}`,
          ),
        );
      }
      for (const arm of ["A", "B"]) {
        const engine = pair.arms[arm];
        const record = pair.records[engine];
        const delivered =
          record.status === "succeeded" &&
          record.signals?.quality === "accepted";
        if (delivered) {
          await copyFile(
            join(
              engine === "baseline" ? baselineDir : candidateDir,
              pair.caseId,
              "result.webp",
            ),
            join(outputDir, "blind", `${pair.id}-${arm}.webp`),
          );
          items.push({
            pair: pair.id,
            arm,
            usable: null,
            identityCritical: null,
            occlusionCritical: null,
            realism: null,
            defects: [],
            comment: "",
          });
        }
      }
    }
    await writeFile(
      join(outputDir, "answer-key.json"),
      JSON.stringify({ split: candidate.split, pairs }, null, 2),
    );
    for (const evaluator of ["reviewer-1", "reviewer-2"])
      await writeFile(
        join(outputDir, "blind", `${evaluator}.json`),
        JSON.stringify({ evaluator: "", items }, null, 2),
      );
    await writeFile(
      join(outputDir, "blind", "README.txt"),
      "Comparez les images sans consulter answer-key.json. Chaque évaluateur travaille séparément. Réalisme : 1 à 5. Utilisable : oui/non. Une identité ou occlusion critique invalide l'utilité. Les entrées sans image restent au dénominateur du rapport.\n",
    );
    console.log(
      `Comparaison préparée : ${pairs.length} paires dans ${outputDir}`,
    );
  } else if (command === "score") {
    const [directory, arbitrationFile] = paths;
    assert.ok(directory, "score <comparison-directory> [arbitration.json]");
    const report = compareVerdicts(
      await json(join(directory, "answer-key.json")),
      await json(join(directory, "blind", "reviewer-1.json")),
      await json(join(directory, "blind", "reviewer-2.json")),
      arbitrationFile ? await json(arbitrationFile) : undefined,
    );
    await writeFile(
      join(directory, "comparison.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
    if (!report.complete) process.exitCode = 2;
  } else throw new Error("Usage : corpus-comparison.mjs prepare|score ...");
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main(process.argv.slice(2));
