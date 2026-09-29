import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { verifyQualificationFiles } from "../lib/server/spatial-qualification-files";
import type { SpatialQualificationV2 } from "../lib/spatial-qualification";
const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "lili-qualification-test-"));
  temporary.push(directory);
  const image = await sharp({
    create: { width: 20, height: 20, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const sha256 = createHash("sha256").update(image).digest("hex");
  await writeFile(join(directory, "image.png"), image);
  const data: SpatialQualificationV2 = {
    version: 2,
    campaign: "test",
    engineVersion: "spatial-v7",
    cases: [
      {
        id: "case",
        family: "rug",
        holdout: true,
        outcome: "delivered",
        durationMs: 20,
        human: null,
        measurement: null,
        evidence: {
          engineVersion: "spatial-v7",
          renderId: "render",
          sceneId: "scene",
          source: "synthetic",
          execution: "mock",
          room: { path: "image.png", sha256 },
          product: { path: "image.png", sha256 },
          candidate: { path: "image.png", sha256 },
        },
      },
    ],
  };
  return { directory, data, sha256 };
}
it("reads, hashes and decodes each distinct file once", async () => {
  const { directory, data, sha256 } = await fixture();
  expect(await verifyQualificationFiles(data, directory)).toEqual({
    verified: [{ path: "image.png", sha256 }],
    errors: [],
  });
});
it("CLI reports non-qualification with exit 2 and never overwrites a prior report", async () => {
  const { directory, data } = await fixture();
  const source = join(directory, "annotations.json"), destination = join(directory, "report.json");
  await writeFile(source, JSON.stringify(data));
  const invoke = () => spawnSync(process.execPath, ["--import", "tsx", resolve("scripts/spatial-qualify.ts"), source, destination], { encoding: "utf8" });
  const first = invoke();
  expect(first.status, first.stderr).toBe(2);
  const report = await readFile(destination, "utf8");
  expect(JSON.parse(report)).toMatchObject({ qualified: false, evidenceVersion: 2, fileErrors: [] });
  const second = invoke();
  expect(second.status).toBe(1);
  expect(second.stderr).toMatch(/EEXIST/);
  expect(await readFile(destination, "utf8")).toBe(report);
}, 15000);
it.each(["missing", "modified", "outside", "absolute", "not-image"])(
  "refuses %s evidence",
  async (kind) => {
    const { directory, data } = await fixture();
    const asset = data.cases[0]!.evidence!.candidate!;
    if (kind === "missing") asset.path = "missing.png";
    if (kind === "modified") asset.sha256 = "a".repeat(64);
    if (kind === "outside") asset.path = "../outside.png";
    if (kind === "absolute") asset.path = join(directory, "image.png");
    if (kind === "not-image") {
      const bytes = Buffer.from("not an image");
      await writeFile(join(directory, "text.png"), bytes);
      asset.path = "text.png";
      asset.sha256 = createHash("sha256").update(bytes).digest("hex");
    }
    const result = await verifyQualificationFiles(data, directory);
    expect(result.errors).toHaveLength(1);
    expect(result.verified).not.toContainEqual(asset);
  },
);
