import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { prepareSpatialBlindReview } from "../lib/server/spatial-blind-review";
import type { SpatialQualificationV2 } from "../lib/spatial-qualification";

const temporary: string[] = [];
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
afterEach(async () => {
  for (const path of temporary.splice(0)) {
    // Only exact mkdtemp children of the OS temporary directory are removed.
    expect(path.startsWith(join(tmpdir(), "lili-blind-review-"))).toBe(true);
    await rm(path, { recursive: true, force: true });
  }
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "lili-blind-review-"));
  temporary.push(directory);
  const evidenceDirectory = join(directory, "evidence");
  await mkdir(evidenceDirectory);
  const image = await sharp({
    create: { width: 20, height: 10, channels: 3, background: "red" },
  })
    .jpeg()
    .withExif({
      IFD0: {
        Artist: "spatial-v11 secret-model private-case delivered",
        ImageDescription: "private-render",
      },
    })
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const path = "private-case-spatial-v11.jpg";
  await writeFile(join(evidenceDirectory, path), image);
  const asset = { path, sha256: sha(image) };
  const data: SpatialQualificationV2 = {
    version: 2,
    campaign: "private-campaign<script>alert(1)</script>",
    engineVersion: "spatial-v11",
    cases: [
      {
        id: "private-case",
        family: "private-family",
        holdout: false,
        outcome: "delivered",
        durationMs: 25,
        evidence: {
          renderId: "private-render",
          sceneId: "private-scene",
          engineVersion: "spatial-v11",
          source: "synthetic",
          execution: "mock",
          room: asset,
          product: asset,
          candidate: asset,
        },
        human: {
          acceptable: true,
          majorDesignDefect: false,
          majorBackgroundDefect: false,
          reviewer: "previous-private-reviewer",
          reviewedAt: "2026-09-27T10:00:00Z",
          blind: true,
          checks: {
            design: true,
            perspective: true,
            scale: true,
            contactLighting: true,
            background: true,
          },
          notes: "private-note",
        },
        measurement: null,
      },
      {
        id: "private-missing-case",
        family: "private-family",
        holdout: true,
        outcome: "unavailable",
        durationMs: null,
        evidence: null,
        human: null,
        measurement: null,
      },
    ],
  };
  const source = join(evidenceDirectory, "source.json");
  await writeFile(source, JSON.stringify(data));
  return {
    directory,
    evidenceDirectory,
    source,
    output: join(directory, "review"),
    data,
    image,
  };
}

async function publicFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    files.push(...(entry.isDirectory() ? await publicFiles(path) : [path]));
  }
  return files;
}

it("exports only opaque references and empty observations, strips metadata, and binds exact source bytes privately", async () => {
  const { source, output, image } = await fixture();
  const original = await readFile(source);
  const result = await prepareSpatialBlindReview(source, output);
  expect(result.cases).toBe(2);
  const mapping = JSON.parse(
    await readFile(join(output, "mapping.private.json"), "utf8"),
  );
  const grid = JSON.parse(
    await readFile(join(output, "reviewer", "review-grid.json"), "utf8"),
  );
  expect(mapping.sourceManifestSha256).toBe(sha(original));
  expect(await readFile(join(output, "source-manifest.private.json"))).toEqual(
    original,
  );
  expect(await readFile(source)).toEqual(original);
  expect(grid.bundleId).toBe(mapping.bundleId);
  expect(grid.reviews).toHaveLength(2);
  expect(
    new Set(grid.reviews.map((item: { reviewId: string }) => item.reviewId))
      .size,
  ).toBe(2);
  expect(
    grid.reviews.every((item: { human: unknown }) => item.human === null),
  ).toBe(true);
  expect(
    mapping.cases.map((item: { caseId: string }) => item.caseId).sort(),
  ).toEqual(["private-case", "private-missing-case"]);
  const files = await publicFiles(result.reviewerDirectory);
  for (const file of files) {
    const bytes = await readFile(file);
    const exposed = `${file.slice(result.reviewerDirectory.length)}\n${bytes.toString("utf8")}`;
    expect(exposed).not.toMatch(
      /spatial-v11|secret-model|private-case|private-campaign|private-render|private-scene|private-family|private-note|previous-private-reviewer|delivered|unavailable|caseId|engineVersion|outcome|<script>/,
    );
    if (file.endsWith(".png")) {
      const metadata = await sharp(bytes).metadata();
      expect(metadata.exif).toBeUndefined();
      expect(metadata.xmp).toBeUndefined();
      expect(metadata.icc).toBeUndefined();
      expect(metadata.width).toBe(10);
      expect(metadata.height).toBe(20);
      expect(await sharp(bytes).raw().toBuffer()).toEqual(
        await sharp(image).rotate().raw().toBuffer(),
      );
      expect(
        mapping.cases
          .flatMap(
            (item: { assets: Array<{ exportedSha256: string }> }) =>
              item.assets,
          )
          .some(
            (asset: { exportedSha256: string }) =>
              asset.exportedSha256 === sha(bytes),
          ),
      ).toBe(true);
    }
  }
  const html = await readFile(
    join(result.reviewerDirectory, "index.html"),
    "utf8",
  );
  expect(html).toContain("Content-Security-Policy");
  expect(html).not.toMatch(/https?:|<script|\.\.\//);
});

it("retains every case without inventing observations when a candidate is absent", async () => {
  const { source, output, data } = await fixture();
  data.cases[0]!.evidence!.candidate = null;
  data.cases[0]!.human = null;
  data.cases[0]!.outcome = "rejected";
  await writeFile(source, JSON.stringify(data));
  const result = await prepareSpatialBlindReview(source, output);
  expect(result).toMatchObject({ cases: 2, images: 1 });
  const grid = JSON.parse(
    await readFile(join(result.reviewerDirectory, "review-grid.json"), "utf8"),
  );
  expect(grid.reviews.map((item: { human: unknown }) => item.human)).toEqual([
    null,
    null,
  ]);
});

it("creates unrelated opaque identifiers for separate preparations", async () => {
  const { source, output, directory } = await fixture();
  const first = await prepareSpatialBlindReview(source, output);
  const second = await prepareSpatialBlindReview(
    source,
    join(directory, "second"),
  );
  expect(first.bundleId).not.toBe(second.bundleId);
  const one = JSON.parse(
    await readFile(join(first.reviewerDirectory, "review-grid.json"), "utf8"),
  );
  const two = JSON.parse(
    await readFile(join(second.reviewerDirectory, "review-grid.json"), "utf8"),
  );
  expect(
    one.reviews.some((a: { reviewId: string }) =>
      two.reviews.some((b: { reviewId: string }) => a.reviewId === b.reviewId),
    ),
  ).toBe(false);
});

it.each([
  "modified",
  "missing",
  "outside",
  "absolute",
  "not-image",
  "outside-link",
  "empty",
])("refuses %s input before creating the reviewer directory", async (kind) => {
  const { directory, evidenceDirectory, source, output, data, image } =
    await fixture();
  const asset = data.cases[0]!.evidence!.candidate!;
  if (kind === "modified")
    await writeFile(
      join(evidenceDirectory, asset.path),
      Buffer.from("tampered"),
    );
  if (kind === "missing") asset.path = "missing.png";
  if (kind === "outside") asset.path = "../outside.jpg";
  if (kind === "absolute") asset.path = join(evidenceDirectory, asset.path);
  if (kind === "not-image") {
    const invalid = Buffer.from("not an image");
    await writeFile(join(evidenceDirectory, asset.path), invalid);
    asset.sha256 = sha(invalid);
  }
  if (kind === "outside-link") {
    const outside = join(directory, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "image.jpg"), image);
    await symlink(outside, join(evidenceDirectory, "link"), "junction");
    asset.path = "link/image.jpg";
  }
  if (kind === "empty")
    data.cases.forEach((item) => {
      item.evidence = null;
      item.human = null;
    });
  await writeFile(source, JSON.stringify(data));
  await expect(prepareSpatialBlindReview(source, output)).rejects.toThrow();
  await expect(access(output)).rejects.toThrow();
});

it("refuses an existing empty output directory and never overwrites a completed export", async () => {
  const { directory, source, output } = await fixture();
  const empty = join(directory, "empty");
  await mkdir(empty);
  await expect(prepareSpatialBlindReview(source, empty)).rejects.toThrow(
    /EEXIST/,
  );
  await prepareSpatialBlindReview(source, output);
  const before = await readFile(join(output, "mapping.private.json"));
  await expect(prepareSpatialBlindReview(source, output)).rejects.toThrow(
    /EEXIST/,
  );
  expect(await readFile(join(output, "mapping.private.json"))).toEqual(before);
});

it("CLI succeeds offline and reports failure rather than replacing an export", async () => {
  const { source, output } = await fixture();
  const invoke = () =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve("scripts/spatial-prepare-review.ts"),
        source,
        output,
      ],
      { encoding: "utf8" },
    );
  const first = invoke();
  expect(first.status, first.stderr).toBe(0);
  expect(JSON.parse(first.stdout).qualification).toBe("not-qualified");
  const second = invoke();
  expect(second.status).toBe(1);
  expect(second.stderr).toMatch(/EEXIST/);
}, 15000);

it("exports a reused image once even across 900 role references", async () => {
  const { source, output, data } = await fixture();
  const original = data.cases[0]!;
  data.cases = Array.from({ length: 300 }, (_, index) => ({
    ...original,
    id: `private-case-${index}`,
  }));
  await writeFile(source, JSON.stringify(data));
  const result = await prepareSpatialBlindReview(source, output);
  expect(result.cases).toBe(300);
  expect(result.images).toBe(1);
  expect(await readdir(join(result.reviewerDirectory, "images"))).toHaveLength(
    1,
  );
  const mapping = JSON.parse(
    await readFile(join(output, "mapping.private.json"), "utf8"),
  );
  const references = mapping.cases.flatMap(
    (entry: { assets: { exportedPath: string }[] }) =>
      entry.assets.map((asset) => asset.exportedPath),
  );
  expect(references).toHaveLength(900);
  expect(new Set(references).size).toBe(1);
});
