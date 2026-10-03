import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import sharp from "sharp";
import { expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { prepareCutout } from "../lib/server/assets";
import { prepareViewMatte, PREPARED_MATTE_VERSION } from "../lib/server/prepared-view-matte";
import { hasSeparatedSubjects } from "../lib/server/mask-topology";

/** Opt-in local evidence job: no database, generation, vision or network calls. */
it.skipIf(process.env.QUALIFY_PREPARED_VIEW_LOCAL !== "true")("records local grenade mask evidence without promoting it to approval", async () => {
  const repository = resolve(import.meta.dirname, "../../..");
  const sourcePath = join(repository, "artifacts/myarchitectai-perspective-2026-10-02/novel-view-60/raw.webp");
  const target = join(repository, "artifacts/oriented-implementation-2026-10-03");
  const source = await readFile(sourcePath);
  const hash = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");
  await mkdir(target, { recursive: true });
  const diagnostic = await prepareCutout(source);
  const multipleSubjects = await hasSeparatedSubjects(diagnostic.buffer);
  const alpha = await sharp(diagnostic.buffer).extractChannel("alpha").png().toBuffer();
  const preview = await sharp(diagnostic.buffer).flatten({ background: "#dddfe3" }).png().toBuffer();
  await writeFile(join(target, "grenade-automatic-cutout.webp"), diagnostic.buffer);
  await writeFile(join(target, "grenade-automatic-alpha.png"), alpha);
  await writeFile(join(target, "grenade-automatic-preview.png"), preview);
  let decision: Record<string, unknown>;
  try {
    const admitted = await prepareViewMatte(source);
    decision = { automaticMatteAccepted: true, candidateState: "needs_review",
      anchor: admitted.anchor, visibleBounds: admitted.visibleBounds };
  } catch (error) {
    decision = { automaticMatteAccepted: false, candidateState: "failed",
      error: error instanceof Error ? error.message : String(error) };
  }
  const report = { schemaVersion: 1, executedAt: new Date().toISOString(), operation: "local_prepared_matte_diagnostic",
    version: PREPARED_MATTE_VERSION, source: { path: sourcePath, sha256: hash(source), origin: "generated",
      historicalRequestId: "130228", campaign: "myarchitectai-perspective-2026-10-02", historicalAngle: "prompt-only 60 degrees" },
    providerCalls: 0, costUsd: 0, humanApproval: false, physicalHeightVerified: false, identityVerified: false,
    manualCorrections: 0, widthPx: diagnostic.widthPx, heightPx: diagnostic.heightPx,
    baseRowFraction: diagnostic.baseRowFraction, shadowRemoved: diagnostic.shadowRemoved,
    needsModelIsolation: diagnostic.needsModelIsolation, flags: { ...diagnostic.quality, multipleSubjects },
    warnings: diagnostic.warnings, ...decision,
    outputs: [
      { file: "grenade-automatic-cutout.webp", sha256: hash(diagnostic.buffer) },
      { file: "grenade-automatic-alpha.png", sha256: hash(alpha) },
      { file: "grenade-automatic-preview.png", sha256: hash(preview) },
    ],
    limits: ["Diagnostic de développement uniquement ; les originaux de campagne restent inchangés.",
      "Le candidat reste une reconstruction IA ; détourage déterministe ne signifie pas photographie authentique.",
      "Un échec de masque interdit l’admission. Une réussite locale exigerait encore la revue humaine et la hauteur physique."] };
  await writeFile(join(target, "grenade-automatic-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  expect(report.providerCalls).toBe(0);
  expect(report.humanApproval).toBe(false);
}, 90_000);
