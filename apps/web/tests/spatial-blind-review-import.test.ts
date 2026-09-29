import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { prepareSpatialBlindReview } from "../lib/server/spatial-blind-review";
import { importSpatialBlindReview } from "../lib/server/spatial-blind-review-import";
import { verifyQualificationFiles } from "../lib/server/spatial-qualification-files";
import type { SpatialQualificationV2 } from "../lib/spatial-qualification";

const temporary: string[] = [];
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
afterEach(async () => {
  for (const directory of temporary.splice(0)) {
    expect(directory.startsWith(join(tmpdir(), "lili-review-import-"))).toBe(
      true,
    );
    await rm(directory, { recursive: true, force: true });
  }
});
type Human = NonNullable<SpatialQualificationV2["cases"][number]["human"]>;
type Mapping = {
  version: number;
  bundleId: string;
  sourceManifestSha256: string;
  cases: Array<{
    reviewId: string;
    caseId: string;
    hasCandidate: boolean;
    assets: Array<{
      role: "room" | "product" | "candidate";
      source: { path: string; sha256: string };
      exportedPath: string;
      exportedSha256: string;
    }>;
  }>;
};
type Grid = {
  version: number;
  bundleId: string;
  reviews: Array<{ reviewId: string; human: Human | null }>;
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "lili-review-import-"));
  temporary.push(directory);
  const evidence = join(directory, "campaign");
  await mkdir(evidence);
  const makeImage = (background: string) =>
    sharp({ create: { width: 20, height: 10, channels: 3, background } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
  const first = await makeImage("red"),
    second = await makeImage("blue");
  await writeFile(join(evidence, "first.jpg"), first);
  await writeFile(join(evidence, "second.jpg"), second);
  const one = { path: "first.jpg", sha256: sha(first) },
    two = { path: "second.jpg", sha256: sha(second) };
  const oldReview: Human = {
    acceptable: true,
    majorDesignDefect: false,
    majorBackgroundDefect: false,
    reviewer: "old-reviewer",
    reviewedAt: "2026-09-27T10:00:00Z",
    blind: false,
    checks: {
      design: true,
      perspective: true,
      scale: true,
      contactLighting: true,
      background: true,
    },
    notes: "Previous declared review",
  };
  const data: SpatialQualificationV2 = {
    version: 2,
    campaign: "synthetic-fixture",
    engineVersion: "spatial-v11",
    cases: [
      {
        id: "one",
        family: "vase",
        holdout: false,
        outcome: "delivered",
        durationMs: 250,
        human: oldReview,
        evidence: {
          renderId: "render-one",
          sceneId: "scene-one",
          engineVersion: "spatial-v11",
          source: "synthetic",
          execution: "mock",
          room: one,
          product: two,
          candidate: one,
        },
        measurement: {
          reference: "declared-test-only",
          referenceLengthCm: 10,
          expectedPx: 100,
          observedPx: 99,
        },
      },
      {
        id: "two",
        family: "basket",
        holdout: true,
        outcome: "rejected",
        durationMs: 123,
        human: null,
        evidence: {
          renderId: "render-two",
          sceneId: "scene-two",
          engineVersion: "spatial-v11",
          source: "synthetic",
          execution: "mock",
          room: one,
          product: two,
          candidate: two,
        },
        measurement: null,
      },
      {
        id: "missing",
        family: "lamp",
        holdout: true,
        outcome: "unavailable",
        durationMs: null,
        evidence: null,
        human: null,
        measurement: null,
      },
    ],
  };
  const source = join(evidence, "source.json"),
    bundle = join(directory, "review");
  await writeFile(source, JSON.stringify(data));
  await prepareSpatialBlindReview(source, bundle);
  const mappingPath = join(bundle, "mapping.private.json");
  const mapping: Mapping = JSON.parse(await readFile(mappingPath, "utf8"));
  const grid: Grid = JSON.parse(
    await readFile(join(bundle, "reviewer/review-grid.json"), "utf8"),
  );
  const firstId = mapping.cases.find(
    (entry) => entry.caseId === "one",
  )!.reviewId;
  const review: Human = {
    ...oldReview,
    reviewer: "declared-new-reviewer",
    blind: true,
    acceptable: false,
    checks: { ...oldReview.checks, scale: false },
    notes: "Synthetic review fixture; scale appears wrong",
  };
  grid.reviews.find((entry) => entry.reviewId === firstId)!.human = review;
  const returned = join(directory, "returned.json"),
    output = join(evidence, "reviewed.json");
  const saveGrid = () => writeFile(returned, JSON.stringify(grid));
  const saveMapping = () => writeFile(mappingPath, JSON.stringify(mapping));
  await saveGrid();
  return {
    directory,
    evidence,
    source,
    bundle,
    mapping,
    grid,
    returned,
    output,
    data,
    review,
    saveGrid,
    saveMapping,
    run: () => importSpatialBlindReview(bundle, returned, evidence, output),
  };
}

it("imports only human in a new manifest with working original image paths and preserves every input", async () => {
  const f = await fixture();
  const watched = [
    f.source,
    join(f.evidence, "first.jpg"),
    join(f.evidence, "second.jpg"),
    join(f.bundle, "source-manifest.private.json"),
    join(f.bundle, "mapping.private.json"),
    f.returned,
  ];
  const original = await Promise.all(watched.map((path) => readFile(path)));
  const result = await f.run();
  expect(result).toMatchObject({
    cases: 3,
    importedReviews: 1,
    qualification: "not-qualified",
    bundleId: f.mapping.bundleId,
  });
  const updated = JSON.parse(await readFile(f.output, "utf8"));
  expect(updated).toEqual({
    ...f.data,
    cases: f.data.cases.map((entry) => ({
      ...entry,
      human: entry.id === "one" ? f.review : null,
    })),
  });
  expect((await verifyQualificationFiles(updated, f.evidence)).errors).toEqual(
    [],
  );
  for (const [index, path] of watched.entries())
    expect(await readFile(path)).toEqual(original[index]);
});

it("imports an incomplete all-null grid without carrying forward any previous review", async () => {
  const f = await fixture();
  f.grid.reviews.forEach((entry) => {
    entry.human = null;
  });
  await f.saveGrid();
  expect((await f.run()).importedReviews).toBe(0);
  const output = JSON.parse(await readFile(f.output, "utf8"));
  expect(output.cases.map((entry: { human: unknown }) => entry.human)).toEqual([
    null,
    null,
    null,
  ]);
});

it.each([
  "foreign-bundle",
  "duplicate",
  "omitted",
  "unknown-id",
  "invalid-human",
  "blank-reviewer",
  "without-candidate",
])("rejects %s returned grid before writing", async (kind) => {
  const f = await fixture();
  const filled = f.grid.reviews.find((entry) => entry.human)!;
  if (kind === "foreign-bundle")
    f.grid.bundleId = "5dd7a880-a914-4d28-8acd-663b6629d151";
  if (kind === "duplicate") f.grid.reviews[1] = f.grid.reviews[0]!;
  if (kind === "omitted") f.grid.reviews.pop();
  if (kind === "unknown-id")
    f.grid.reviews[0]!.reviewId = "5dd7a880-a914-4d28-8acd-663b6629d151";
  if (kind === "invalid-human")
    filled.human = { ...filled.human!, reviewedAt: "invented date" };
  if (kind === "blank-reviewer")
    filled.human = { ...filled.human!, reviewer: " " };
  if (kind === "without-candidate") {
    const id = f.mapping.cases.find(
      (entry) => entry.caseId === "missing",
    )!.reviewId;
    f.grid.reviews.find((entry) => entry.reviewId === id)!.human = f.review;
  }
  await f.saveGrid();
  await expect(f.run()).rejects.toThrow();
  await expect(access(f.output)).rejects.toThrow();
});

it.each([
  "duplicate-review",
  "duplicate-case",
  "omitted",
  "foreign-case",
  "candidate-status",
  "wrong-image",
  "missing-role",
  "duplicated-role",
  "bad-source-hash",
])("rejects %s private mapping before writing", async (kind) => {
  const f = await fixture();
  const first = f.mapping.cases.find((entry) => entry.caseId === "one")!;
  const second = f.mapping.cases.find((entry) => entry.caseId === "two")!;
  if (kind === "duplicate-review") second.reviewId = first.reviewId;
  if (kind === "duplicate-case") second.caseId = first.caseId;
  if (kind === "omitted") f.mapping.cases.pop();
  if (kind === "foreign-case") first.caseId = "other";
  if (kind === "candidate-status") first.hasCandidate = false;
  if (kind === "wrong-image")
    first.assets.find((entry) => entry.role === "candidate")!.source =
      second.assets.find((entry) => entry.role === "candidate")!.source;
  if (kind === "missing-role") first.assets.pop();
  if (kind === "duplicated-role") first.assets[1] = first.assets[0]!;
  if (kind === "bad-source-hash")
    f.mapping.sourceManifestSha256 = "a".repeat(64);
  await f.saveMapping();
  await expect(f.run()).rejects.toThrow();
  await expect(access(f.output)).rejects.toThrow();
});

it("rejects even whitespace changes in the exact private source bytes", async () => {
  const f = await fixture();
  await writeFile(
    join(f.bundle, "source-manifest.private.json"),
    JSON.stringify(f.data, null, 2),
  );
  await expect(f.run()).rejects.toThrow(/Manifeste source modifié/);
  await expect(access(f.output)).rejects.toThrow();
});

it("rejects a permutation of mapping review IDs against the actual gallery", async () => {
  const f = await fixture();
  const first = f.mapping.cases.find((entry) => entry.caseId === "one")!;
  const second = f.mapping.cases.find((entry) => entry.caseId === "two")!;
  [first.reviewId, second.reviewId] = [second.reviewId, first.reviewId];
  await f.saveMapping();
  await expect(f.run()).rejects.toThrow(/images présentées/);
  await expect(access(f.output)).rejects.toThrow();
});

it("rejects source image changes", async () => {
  const f = await fixture();
  await writeFile(join(f.evidence, "first.jpg"), "corrupt");
  await expect(f.run()).rejects.toThrow(/Preuves invalides/);
  await expect(access(f.output)).rejects.toThrow();
});

it("rejects an altered reviewer image even if its mapping hash is recalculated", async () => {
  const f = await fixture();
  const asset = f.mapping.cases.find((entry) => entry.caseId === "one")!
    .assets[0]!;
  const image = await sharp({
    create: { width: 10, height: 20, channels: 3, background: "green" },
  })
    .png()
    .toBuffer();
  await writeFile(join(f.bundle, "reviewer", asset.exportedPath), image);
  f.mapping.cases.forEach((entry) =>
    entry.assets.forEach((item) => {
      if (item.exportedPath === asset.exportedPath)
        item.exportedSha256 = sha(image);
    }),
  );
  await f.saveMapping();
  await expect(f.run()).rejects.toThrow(/Pixels exportés différents/);
  await expect(access(f.output)).rejects.toThrow();
});

it("rejects exported file traversal and symlinks outside the private bundle", async () => {
  const f = await fixture();
  const asset = f.mapping.cases.find((entry) => entry.caseId === "one")!
    .assets[0]!;
  const originalPath = asset.exportedPath;
  asset.exportedPath = "../outside.png";
  await f.saveMapping();
  await expect(f.run()).rejects.toThrow();
  await expect(access(f.output)).rejects.toThrow();
  asset.exportedPath = originalPath;
  await f.saveMapping();
  const images = join(f.bundle, "reviewer/images"),
    outside = join(f.directory, "outside-images");
  await rename(images, outside);
  await symlink(outside, images, "junction");
  await expect(f.run()).rejects.toThrow(/Lien hors/);
  await expect(access(f.output)).rejects.toThrow();
});

it("refuses an output elsewhere and refuses to overwrite a source or previous import", async () => {
  const f = await fixture();
  await expect(
    importSpatialBlindReview(
      f.bundle,
      f.returned,
      f.evidence,
      join(f.directory, "wrong.json"),
    ),
  ).rejects.toThrow(/dossier original/);
  const original = await readFile(f.source);
  await expect(
    importSpatialBlindReview(f.bundle, f.returned, f.evidence, f.source),
  ).rejects.toThrow(/EEXIST/);
  expect(await readFile(f.source)).toEqual(original);
  await f.run();
  const first = await readFile(f.output);
  await expect(f.run()).rejects.toThrow(/EEXIST/);
  expect(await readFile(f.output)).toEqual(first);
});

it("CLI imports offline and reports refusal on a repeated destination", async () => {
  const f = await fixture();
  const invoke = () =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve("scripts/spatial-import-review.ts"),
        f.bundle,
        f.returned,
        f.evidence,
        f.output,
      ],
      { encoding: "utf8" },
    );
  const first = invoke();
  expect(first.status, first.stderr).toBe(0);
  expect(JSON.parse(first.stdout)).toMatchObject({
    importedReviews: 1,
    qualification: "not-qualified",
  });
  const again = invoke();
  expect(again.status).toBe(1);
  expect(again.stderr).toMatch(/EEXIST/);
}, 15000);
