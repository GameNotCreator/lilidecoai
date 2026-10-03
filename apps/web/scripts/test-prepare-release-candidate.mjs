import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { MANIFEST, VERSION, prepareReleaseCandidate, verifyReleaseCandidate } from "./prepare-release-candidate.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "lili-release-tests-"));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + "/lili-release-tests-".replace("/", process.platform === "win32" ? "\\" : "/")));
    await rm(directory, { recursive: true, force: true });
  });
  const sourceRoot = join(directory, "source");
  await mkdir(sourceRoot);
  const put = async (path, content) => {
    const file = join(sourceRoot, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, typeof content === "object" ? JSON.stringify(content) : content);
  };
  const packages = ["ai-router", "analytics", "geometry", "types", "ui"];
  const root = { name: "fixture-root", version: "1.0.0", workspaces: ["apps/*", "packages/*"], packageManager: "npm@11.17.0" };
  const web = { name: "@visualizer/web", version: "1.0.0", dependencies: Object.fromEntries(packages.map((name) => [`@lili/${name}`, "*"])) };
  const lock = { name: root.name, version: root.version, lockfileVersion: 3, packages: { "": root, "apps/web": web } };
  await put("package.json", root);
  await put("tsconfig.base.json", { compilerOptions: { strict: true } });
  await put(".vercelignore", "services/\nartifacts/\n.env*\n");
  await put("apps/web/package.json", web);
  await put("apps/web/vercel.json", { framework: "nextjs", buildCommand: "node scripts/vercel-build.mjs" });
  await put("apps/web/tsconfig.json", { extends: "../../tsconfig.base.json" });
  for (const path of ["next.config.ts", "next-env.d.ts", "postcss.config.mjs", "eslint.config.mjs"])
    await put(`apps/web/${path}`, "export {};\n");
  for (const path of ["vercel-build.mjs", "migrate-image-pipeline.mjs", "migrate-asset-visibility.mjs",
    "migrate-cutout-provenance.mjs", "production-preflight.mjs", "production-preflight-policy.mjs", "production-smoke.mjs",
    "render-worker.ts", "prepare-release-candidate.mjs", "check-spatial-matting.mjs",
    "migrate-oriented-views.ts", "oriented-readiness.mjs"])
    await put(`apps/web/scripts/${path}`, "export {};\n");
  for (const path of ["apps/web/app/page.tsx", "apps/web/components/example.tsx", "apps/web/lib/example.ts", "apps/web/public/widget.js"])
    await put(path, "export const example = 1;\n");
  for (const name of packages) {
    const pkg = { name: `@lili/${name}`, version: "1.0.0", exports: "./src/index.ts" };
    lock.packages[`packages/${name}`] = pkg;
    lock.packages[`node_modules/@lili/${name}`] = { resolved: `packages/${name}`, link: true };
    await put(`packages/${name}/package.json`, pkg);
    await put(`packages/${name}/tsconfig.json`, { extends: "../../tsconfig.base.json" });
    await put(`packages/${name}/src/index.ts`, "export const example = 1;\n");
  }
  await put("packages/geometry/eslint.config.mjs", "export {};\n");
  await put("package-lock.json", lock);
  return { directory, sourceRoot, put, output: join(directory, "candidate") };
}

test("copies only production sources, preserves dirty bytes and produces reproducible identity", async (t) => {
  const input = await fixture(t);
  for (const path of [".env", ".git/config", "node_modules/example.js", "services/matting/model.onnx",
    "testpratiques/image.jpg", "artifacts/private.png", "photos/room.jpg", "corpus/source.json",
    "apps/web/.next/build.json", "apps/web/tests/example.ts", "packages/geometry/src/example.test.ts"])
    await input.put(path, "PRIVATE_EXCLUDED_SENTINEL");
  await input.put("apps/web/lib/example.ts", "export const dirtyUncommittedValue = 17;\n");
  const original = await readFile(join(input.sourceRoot, "apps/web/lib/example.ts"));
  const first = await prepareReleaseCandidate(input);
  const second = await prepareReleaseCandidate({ ...input, output: join(input.directory, "second") });
  assert.equal(first.workerRevision, second.workerRevision);
  assert.match(first.workerRevision, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(await readFile(join(input.output, MANIFEST)), await readFile(join(input.directory, "second", MANIFEST)));
  assert.deepEqual(await readFile(join(input.sourceRoot, "apps/web/lib/example.ts")), original);
  const manifest = JSON.parse(await readFile(join(input.output, MANIFEST), "utf8"));
  assert.equal(manifest.qualification, "prepared-not-built-or-deployed");
  for (const file of manifest.bootstrapFiles) {
    const bytes = await readFile(join(input.output, file.path));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
    assert.equal(bytes.includes("PRIVATE_EXCLUDED_SENTINEL"), false);
  }
  assert.equal((await verifyReleaseCandidate({ ...input, againstSource: true })).status, "verified");
});

test("never overwrites an existing output or writes into a dangerous source subtree", async (t) => {
  const input = await fixture(t);
  await mkdir(input.output);
  await writeFile(join(input.output, "keep.txt"), "untouched");
  await assert.rejects(prepareReleaseCandidate(input), /already exists/);
  assert.equal(await readFile(join(input.output, "keep.txt"), "utf8"), "untouched");
  await assert.rejects(prepareReleaseCandidate({ ...input, output: join(input.sourceRoot, "apps/web/candidate") }), /Unsafe output nesting/);
  await assert.rejects(prepareReleaseCandidate({ ...input, output: input.sourceRoot }), /already exists/);
});

test("includes only reviewed brand bytes and rejects substitutions or extra images", async (t) => {
  const input = await fixture(t);
  const path = "apps/web/public/brand/lilideco-logo.png";
  await mkdir(join(input.sourceRoot, "apps/web/public/brand"));
  const bytes = await readFile(new URL("../public/brand/lilideco-logo.png", import.meta.url));
  await writeFile(join(input.sourceRoot, path), bytes);
  await prepareReleaseCandidate(input);
  assert.deepEqual(await readFile(join(input.output, path)), bytes);
  assert.equal((await verifyReleaseCandidate(input)).status, "verified");
  await writeFile(join(input.output, path), Buffer.from("substituted photo"));
  await assert.rejects(verifyReleaseCandidate(input), /fingerprint differs/);
  await writeFile(join(input.sourceRoot, path), Buffer.from("substituted photo"));
  await assert.rejects(prepareReleaseCandidate({ ...input, output: join(input.directory, "bad") }), /reviewed bytes/);
  await writeFile(join(input.sourceRoot, path), bytes);
  await input.put("apps/web/public/brand/private-room.png", "private image");
  await assert.rejects(prepareReleaseCandidate({ ...input, output: join(input.directory, "extra") }), /Unlisted source asset/);
});

test("rejects links and junctions in included sources and output ancestry", async (t) => {
  const input = await fixture(t);
  const outside = join(input.directory, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "leak.ts"), "export const privateValue = 7;");
  const link = join(input.sourceRoot, "apps/web/lib/linked");
  await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(prepareReleaseCandidate(input), /link or junction/i);
  await assert.rejects(prepareReleaseCandidate({ ...input, output: join(link, "candidate") }), /link or junction/i);
});

test("rejects secret files, credential literals and unlisted photo/model assets", async (t) => {
  for (const [name, content, expected] of [
    [".env.local", "KEY=value", /Forbidden source filename/],
    ["credentials.json", "{}", /Forbidden source filename/],
    ["unsafe.ts", `export const key = '${"sk-" + "a".repeat(40)}';`, /Possible credential/],
    ["room.jpg", "fake-photo", /Unlisted source asset/],
    ["weights.onnx", "fake-model", /Unlisted source asset/],
  ]) {
    const input = await fixture(t);
    await input.put(`apps/web/lib/${name}`, content);
    await assert.rejects(prepareReleaseCandidate(input), expected);
    assert.equal((await readdir(input.directory)).includes("candidate"), false);
  }
});

test("rejects dependency drift and imports from excluded tests", async (t) => {
  const input = await fixture(t);
  await input.put("apps/web/lib/example.ts", "import '../tests/helper';\n");
  await input.put("apps/web/tests/helper.ts", "export {};\n");
  await assert.rejects(prepareReleaseCandidate(input), /Missing local import/);
  await input.put("apps/web/lib/example.ts", "export {};\n");
  const pkg = JSON.parse(await readFile(join(input.sourceRoot, "apps/web/package.json"), "utf8"));
  pkg.dependencies.unlocked = "1.0.0";
  await input.put("apps/web/package.json", pkg);
  await assert.rejects(prepareReleaseCandidate(input), /Lockfile dependencies differs/);
});

test("accepts only the two exact production Next declarations without copying build files or changing source hashes", async (t) => {
  const input = await fixture(t);
  const declaration = 'import "./.next/types/routes.d.ts";\nimport "./.next/types/root-params.d.ts";\n';
  await input.put("apps/web/next-env.d.ts", declaration);
  for (const name of ["routes", "root-params"])
    await input.put(`apps/web/.next/types/${name}.d.ts`, "OLD_BUILD_MUST_NOT_BE_COPIED");
  const result = await prepareReleaseCandidate(input);
  const manifestBytes = await readFile(join(input.output, MANIFEST));
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.bootstrapFiles.some((file) => file.path.includes("/.next/")), false);
  const recorded = manifest.bootstrapFiles.find((file) => file.path === "apps/web/next-env.d.ts");
  assert.equal(recorded.sha256, createHash("sha256").update(declaration).digest("hex"));
  assert.equal(await readFile(join(input.output, recorded.path), "utf8"), declaration);
  await mkdir(join(input.output, "apps/web/.next/types"), { recursive: true });
  for (const name of ["routes", "root-params"])
    await writeFile(join(input.output, `apps/web/.next/types/${name}.d.ts`), "NEW_GENERATED_DECLARATION");
  await verifyReleaseCandidate({ ...input, allowBuildOutput: true, expectedRevision: result.workerRevision });
  assert.deepEqual(await readFile(join(input.output, MANIFEST)), manifestBytes);
  await writeFile(join(input.output, recorded.path), declaration + "// Build changed source\n");
  await assert.rejects(verifyReleaseCandidate({ ...input, allowBuildOutput: true }), /fingerprint differs/);
});

test("rejects arbitrary Next declarations, dev declarations and the production exception outside next-env", async (t) => {
  for (const [file, spec] of [
    ["apps/web/next-env.d.ts", "./.next/types/arbitrary.d.ts"],
    ["apps/web/next-env.d.ts", "./.next/dev/types/routes.d.ts"],
    ["apps/web/next-env.d.ts", "./.next/dev/types/root-params.d.ts"],
    ["apps/web/lib/example.ts", "../.next/types/routes.d.ts"],
  ]) {
    const input = await fixture(t);
    await input.put(file, `import "${spec}";\n`);
    await assert.rejects(prepareReleaseCandidate(input), /Missing local import/);
    assert.equal((await readdir(input.directory)).includes("candidate"), false);
  }
});

test("verification detects modified, missing and additional source files", async (t) => {
  for (const variant of ["changed", "missing", "added"]) {
    const input = await fixture(t);
    await prepareReleaseCandidate(input);
    const target = join(input.output, "apps/web/lib/example.ts");
    if (variant === "changed") await writeFile(target, "export const changed = true;");
    if (variant === "missing") await rm(target);
    if (variant === "added") await writeFile(join(input.output, "private.txt"), "not-allowed");
    await assert.rejects(verifyReleaseCandidate(input), /fingerprint differs|Missing release|Unexpected release/);
  }
});

test("verify ignores only explicitly allowed generated build output when requested", async (t) => {
  const input = await fixture(t);
  const result = await prepareReleaseCandidate(input);
  await mkdir(join(input.output, "node_modules/package"), { recursive: true });
  await writeFile(join(input.output, "node_modules/package/generated.js"), "installed");
  await mkdir(join(input.output, "apps/web/.next"));
  await writeFile(join(input.output, "apps/web/.next/build.json"), "{}");
  await writeFile(join(input.output, "apps/web/tsconfig.tsbuildinfo"), "cache");
  await assert.rejects(verifyReleaseCandidate(input), /Unexpected release/);
  const checked = await verifyReleaseCandidate({ ...input, allowBuildOutput: true, expectedRevision: result.workerRevision });
  assert.deepEqual(checked.ignoredBuildOutputs, ["apps/web/.next", "apps/web/tsconfig.tsbuildinfo", "node_modules"]);
  await writeFile(join(input.output, ".env"), "MUST_NOT_EXIST=true");
  await assert.rejects(verifyReleaseCandidate({ ...input, allowBuildOutput: true }), /Unexpected release/);
});

test("verification can bind an external expected identity and recheck the source checkout", async (t) => {
  const input = await fixture(t);
  await prepareReleaseCandidate(input);
  await assert.rejects(verifyReleaseCandidate({ ...input, expectedRevision: `sha256:${"0".repeat(64)}` }), /identity differs/);
  await input.put("apps/web/lib/example.ts", "export const laterSourceChange = 18;\n");
  await assert.rejects(verifyReleaseCandidate({ ...input, againstSource: true }), /Source checkout differs/);
});

test("Vercel-injected metadata is accepted only during the bound hosted production build", async (t) => {
  const input = await fixture(t);
  const release = await prepareReleaseCandidate(input);
  const manifest = await readFile(join(input.output, MANIFEST));
  await mkdir(join(input.output, ".vercel/cache/corepack"), { recursive: true });
  await mkdir(join(input.output, ".vercel/output"));
  await writeFile(join(input.output, ".vercel/project.json"), JSON.stringify({ projectId: "prj_test", orgId: "team_test" }));
  await writeFile(join(input.output, ".vercel/README.txt"), "Generated Vercel project metadata.\n");
  await writeFile(join(input.output, ".vercel/cache/corepack/generated.js"), "package-manager-cache");
  await writeFile(join(input.output, ".vercel/output/config.json"), '{"version":3}');
  const options = { ...input, allowBuildOutput: true, expectedRevision: release.workerRevision,
    env: { VERCEL: "1", VERCEL_ENV: "production" } };
  for (const override of [
    { env: {} }, { env: { VERCEL_ENV: "production" } },
    { env: { VERCEL: "1", VERCEL_ENV: "preview" } },
    { env: { VERCEL: "1", VERCEL_ENV: "development" } },
    { allowBuildOutput: false }, { againstSource: true }, { expectedRevision: undefined },
  ]) await assert.rejects(verifyReleaseCandidate({ ...options, ...override }), /Unexpected release directory/);
  const checked = await verifyReleaseCandidate(options);
  assert.deepEqual(checked.ignoredBuildOutputs,
    [".vercel/README.txt", ".vercel/cache", ".vercel/output", ".vercel/project.json"]);
  assert.deepEqual(await readFile(join(input.output, MANIFEST)), manifest);
  await writeFile(join(input.output, "apps/web/lib/example.ts"), "export const changed = true;\n");
  await assert.rejects(verifyReleaseCandidate(options), /fingerprint differs/);
});

test("Vercel metadata does not admit extra files, secrets, nested roots or symlinks", async (t) => {
  for (const variant of ["unknown", "secret", "literal", "nested", "root-link", "cache-link"]) {
    const input = await fixture(t);
    const release = await prepareReleaseCandidate(input);
    const options = { ...input, allowBuildOutput: true, expectedRevision: release.workerRevision,
      env: { VERCEL: "1", VERCEL_ENV: "production" } };
    const metadata = join(input.output, variant === "nested" ? "apps/web/.vercel" : ".vercel");
    if (variant === "root-link" || variant === "cache-link") {
      const external = join(input.directory, "outside");
      await mkdir(external);
      if (variant === "cache-link") await mkdir(metadata);
      await symlink(external, variant === "root-link" ? metadata : join(metadata, "cache"),
        process.platform === "win32" ? "junction" : "dir");
      await assert.rejects(verifyReleaseCandidate(options), /link/i);
    } else {
      await mkdir(metadata);
      if (variant === "unknown") await writeFile(join(metadata, "private-photo.jpg"), "not-generated");
      if (variant === "secret") await writeFile(join(metadata, ".env.production"), "SECRET_SENTINEL");
      if (variant === "literal") await writeFile(join(metadata, "project.json"),
        JSON.stringify({ apiKey: "sk-" + "a".repeat(40) }));
      await assert.rejects(verifyReleaseCandidate(options), /Unexpected Vercel build metadata path|Unexpected release directory|Possible credential/);
    }
  }
});

test("root Vercel configuration must match the verified app configuration in the bound hosted build", async (t) => {
  const input = await fixture(t);
  const configuration = { framework: "nextjs", buildCommand: "node scripts/vercel-build.mjs",
    crons: [{ path: "/api/cron/purge", schedule: "0 3 * * *" }] };
  await input.put("apps/web/vercel.json", configuration);
  const release = await prepareReleaseCandidate(input);
  const manifest = await readFile(join(input.output, MANIFEST));
  // Formatting and property order may change when Vercel relocates the configuration.
  await writeFile(join(input.output, "vercel.json"), JSON.stringify({
    crons: [{ schedule: "0 3 * * *", path: "/api/cron/purge" }],
    buildCommand: configuration.buildCommand, framework: configuration.framework,
  }, null, 2));
  const options = { ...input, allowBuildOutput: true, expectedRevision: release.workerRevision,
    env: { VERCEL: "1", VERCEL_ENV: "production" } };
  for (const override of [
    { env: {} }, { env: { VERCEL_ENV: "production" } },
    { env: { VERCEL: "1", VERCEL_ENV: "preview" } },
    { allowBuildOutput: false }, { againstSource: true }, { expectedRevision: undefined },
  ]) await assert.rejects(verifyReleaseCandidate({ ...options, ...override }), /Unexpected release file/);
  const checked = await verifyReleaseCandidate(options);
  assert.deepEqual(checked.ignoredBuildOutputs, ["vercel.json"]);
  assert.deepEqual(await readFile(join(input.output, MANIFEST)), manifest);
  for (const name of ["lilidecoai", "lilidecoai-web"]) {
    await writeFile(join(input.output, "vercel.json"), JSON.stringify({ ...configuration, name, version: 2 }));
    assert.equal((await verifyReleaseCandidate(options)).status, "verified");
  }
  const modified = JSON.stringify({ ...configuration, crons: [] });
  await writeFile(join(input.output, "apps/web/vercel.json"), modified);
  await writeFile(join(input.output, "vercel.json"), modified);
  await assert.rejects(verifyReleaseCandidate(options), /Release file fingerprint differs: apps\/web\/vercel.json/);
});

test("root Vercel configuration rejects differences, invalid JSON, secrets, directories and links without exposing values", async (t) => {
  for (const variant of ["changed", "added", "version", "name", "invalid", "secret", "directory", "link"]) {
    const input = await fixture(t);
    const release = await prepareReleaseCandidate(input);
    const path = join(input.output, "vercel.json");
    const options = { ...input, allowBuildOutput: true, expectedRevision: release.workerRevision,
      env: { VERCEL: "1", VERCEL_ENV: "production" } };
    const sentinel = "PRIVATE_VALUE_MUST_NOT_APPEAR";
    if (variant === "directory") await mkdir(path);
    else if (variant === "link") {
      const outside = join(input.directory, "outside");
      await mkdir(outside);
      await symlink(outside, path, process.platform === "win32" ? "junction" : "dir");
    } else if (variant === "invalid") await writeFile(path, `{${sentinel}`);
    else {
      const configuration = JSON.parse(await readFile(join(input.output, "apps/web/vercel.json"), "utf8"));
      if (variant === "changed") configuration.buildCommand = sentinel;
      if (variant === "version") configuration.version = 3;
      if (variant === "name") configuration.name = sentinel;
      if (variant === "added") configuration.crons = [{ path: sentinel, schedule: "* * * * *" }];
      if (variant === "secret") configuration.token = "sk-" + "a".repeat(40);
      await writeFile(path, JSON.stringify(configuration));
    }
    await assert.rejects(verifyReleaseCandidate(options), (error) => {
      assert.match(error.message, /differs from verified app configuration|Invalid root Vercel configuration JSON|Possible credential|Unexpected release directory|cannot be a link/);
      assert.equal(error.message.includes(sentinel), false);
      assert.equal(error.message.includes("sk-" + "a".repeat(40)), false);
      return true;
    });
  }
});

test("a forged manifest cannot admit a forbidden bootstrap path even with recomputed identity", async (t) => {
  const input = await fixture(t);
  await prepareReleaseCandidate(input);
  const path = join(input.output, MANIFEST);
  const manifest = JSON.parse(await readFile(path, "utf8"));
  const content = Buffer.from("excluded private content");
  await writeFile(join(input.output, "private.txt"), content);
  manifest.bootstrapFiles.push({ path: "private.txt", sizeBytes: content.length, sha256: createHash("sha256").update(content).digest("hex") });
  manifest.bootstrapFiles.sort((a, b) => a.path.localeCompare(b.path, "en"));
  manifest.workerRevision = `sha256:${createHash("sha256").update(JSON.stringify({ version: VERSION, files: manifest.bootstrapFiles })).digest("hex")}`;
  await writeFile(path, JSON.stringify(manifest));
  await assert.rejects(verifyReleaseCandidate(input), /Invalid release file records/);
});
