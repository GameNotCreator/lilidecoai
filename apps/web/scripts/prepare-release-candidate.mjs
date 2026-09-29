import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const VERSION = "lili-release-candidate-v1";
export const MANIFEST = "release-candidate.json";
const PACKAGE_NAMES = ["ai-router", "analytics", "geometry", "types", "ui"];
const ROOT_FILES = ["package.json", "package-lock.json", "tsconfig.base.json", ".vercelignore"];
const WEB_FILES = ["package.json", "next.config.ts", "next-env.d.ts", "postcss.config.mjs",
  "tsconfig.json", "eslint.config.mjs", "vercel.json"];
const WEB_SCRIPTS = ["vercel-build.mjs", "migrate-image-pipeline.mjs", "migrate-asset-visibility.mjs",
  "migrate-cutout-provenance.mjs", "production-preflight.mjs", "production-preflight-policy.mjs", "production-smoke.mjs",
  "render-worker.ts", "prepare-release-candidate.mjs", "check-spatial-matting.mjs"];
const SOURCE_TREES = ["apps/web/app", "apps/web/components", "apps/web/lib", "apps/web/public",
  ...PACKAGE_NAMES.map((name) => `packages/${name}/src`)];
const REQUIRED_FILES = [...ROOT_FILES, ...WEB_FILES.map((path) => `apps/web/${path}`),
  ...WEB_SCRIPTS.map((path) => `apps/web/scripts/${path}`),
  ...PACKAGE_NAMES.flatMap((name) => [`packages/${name}/package.json`, `packages/${name}/tsconfig.json`]),
  "packages/geometry/eslint.config.mjs"];
const EXCLUDED_DIRS = new Set([".git", ".vercel", ".next", ".venv", "node_modules", "__pycache__",
  "tests", "test", "__tests__", "__scratch", "coverage", "dist", "build", "services", "testpratiques",
  "artifacts", "corpus", "photos", "models", "fixtures"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".css", ".svg"]);
// Exact user-supplied public brand assets only. Room photos and arbitrary binaries
// remain excluded, including any replacement hidden behind one of these names.
const PUBLIC_BRAND_ASSETS = new Map([
  ["apps/web/public/brand/visualiser-chez-vous.png", "ac9a900306c6fef28415ea040b7de010eb89aa11e1dce5bbd421f59be80963a8"],
  ["apps/web/public/brand/lilideco-logo.png", "6db512337680869b37f381537abb523d05523a10ba379cc53d0dee07c5f5e2ec"],
  ["apps/web/public/brand/lilideco-monogram.png", "e5e1ab5684f8ff2b3e0870154728e5d90e32b6f035d10d78e6668ae7ee308130"],
  ["apps/web/public/brand/lilideco-signature.png", "18d5be22e4d0bef1e56b2c69900a0ad20b13fcda3ba3fa82fe2da7d3947d3204"],
]);
const BUILD_OUTPUTS = ["**/node_modules/**", "apps/web/.next/**", "apps/web/*.tsbuildinfo", "packages/*/*.tsbuildinfo"];
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const slash = (value) => value.split(sep).join("/");
const sorted = (values) => [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
const sourceDefault = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function contained(root, target) {
  const path = relative(root, target);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

async function noLinks(path) {
  const absolute = resolve(path);
  const parents = [];
  for (let at = absolute; ; at = dirname(at)) {
    parents.push(at);
    if (dirname(at) === at) break;
  }
  for (const parent of parents.reverse()) {
    const info = await lstat(parent);
    if (info.isSymbolicLink()) throw new Error(`Symbolic link or junction refused: ${parent}`);
  }
  return absolute;
}

function safeRelative(path) {
  return typeof path === "string" && path !== "" && !path.includes("\\") && !path.includes(":")
    && !path.includes("\0") && !path.startsWith("/")
    && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function secretFilename(path) {
  const name = path.split("/").at(-1).toLowerCase();
  return name.startsWith(".env") || name.endsWith(".env") || name === ".npmrc"
    || /\.(pem|key|p12|pfx|kdbx|jks|keystore)$/.test(name)
    || /^(credentials|secrets?|service[-_]account)([._-].*)?\.json$/.test(name);
}

function skippedSource(path) {
  return path.split("/").some((part) => EXCLUDED_DIRS.has(part.toLowerCase()))
    || /(?:^|\/)(?:zz-|.*-scratch\.)/.test(path)
    || /\.(?:test|spec)\.[^/]+$/.test(path) || path.endsWith(".tsbuildinfo");
}

function permittedBootstrap(path) {
  return safeRelative(path) && !secretFilename(path) && !skippedSource(path)
    && (REQUIRED_FILES.includes(path) || PUBLIC_BRAND_ASSETS.has(path)
      || (SOURCE_TREES.some((tree) => path.startsWith(`${tree}/`))
        && SOURCE_EXTENSIONS.has(extname(path).toLowerCase())));
}

function inspectText(path, bytes) {
  if (bytes.length > MAX_FILE_BYTES) throw new Error(`Oversized release source: ${path}`);
  if (PUBLIC_BRAND_ASSETS.has(path)) {
    if (sha(bytes) !== PUBLIC_BRAND_ASSETS.get(path)) throw new Error(`Public brand asset differs from reviewed bytes: ${path}`);
    return "";
  }
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error(`Non-text release source refused: ${path}`); }
  if (text.includes("\0")) throw new Error(`Binary release source refused: ${path}`);
  const signatures = [
    /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
    /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/,
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/,
    /\bAKIA[A-Z0-9]{16}\b/,
    /\bAIza[0-9A-Za-z_-]{35}\b/,
    /mongodb(?:\+srv)?:\/\/[^\s/:@"'`]+:[^\s@"'`]+@/,
    /(?:api[_-]?key|session[_-]?secret|api[_-]?secret|password|access[_-]?token)\s*[=:]\s*["'][A-Za-z0-9_+\/=.-]{20,}["']/i,
    /data:image\/[a-z0-9+.-]+;base64,[A-Za-z0-9+/=]{128,}/i,
  ];
  if (signatures.some((pattern) => pattern.test(text)))
    throw new Error(`Possible credential or embedded image refused in ${path}; content suppressed`);
  return text;
}

function identity(files) {
  return `sha256:${sha(Buffer.from(JSON.stringify({ version: VERSION, files })))}`;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(sorted(Object.keys(value)).map((key) => [key, canonical(value[key])]));
  return value;
}

function same(a, b) { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }

function dependencyChecks(contents) {
  const parse = (path) => {
    try { return JSON.parse(contents.get(path).toString("utf8")); }
    catch { throw new Error(`Invalid required JSON: ${path}`); }
  };
  const lock = parse("package-lock.json");
  if (lock.lockfileVersion !== 3 || !lock.packages) throw new Error("Expected npm lockfile version 3");
  const directories = ["", "apps/web", ...PACKAGE_NAMES.map((name) => `packages/${name}`)];
  const manifests = new Map(directories.map((dir) => [dir, parse(dir ? `${dir}/package.json` : "package.json")]));
  const root = manifests.get("");
  if (!same(root.workspaces, ["apps/*", "packages/*"])) throw new Error("Workspace layout differs from release policy");
  const byName = new Map([...manifests].filter(([dir]) => dir).map(([dir, pkg]) => [pkg.name, dir]));
  if (byName.size !== directories.length - 1) throw new Error("Missing or duplicate workspace package names");
  for (const [dir, pkg] of manifests) {
    const row = lock.packages[dir];
    if (!row || pkg.name !== row.name || pkg.version !== row.version)
      throw new Error(`Manifest differs from lockfile: ${dir || "root"}`);
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "engines"])
      if (!same(pkg[field] ?? {}, row[field] ?? {}))
        throw new Error(`Lockfile ${field} differs: ${dir || "root"}`);
    for (const [name, spec] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies })) {
      if (typeof spec !== "string" || /^(?:file:|link:|git|https?:)/i.test(spec))
        throw new Error(`Non-registry dependency refused: ${name}`);
      if (name.startsWith("@lili/") && !byName.has(name)) throw new Error(`Missing local workspace: ${name}`);
    }
    if (dir.startsWith("packages/")) {
      if (typeof pkg.exports !== "string" || !pkg.exports.startsWith("./")
          || !contents.has(`${dir}/${pkg.exports.slice(2)}`))
        throw new Error(`Missing workspace export: ${dir}`);
    }
  }
  for (const [key, row] of Object.entries(lock.packages)) {
    if (row.link && (!directories.includes(row.resolved) || !byName.has(key.slice("node_modules/".length))))
      throw new Error(`Unexpected lockfile workspace link: ${key}`);
    if (row.resolved && !row.link && !/^https:\/\/registry\.npmjs\.org\//.test(row.resolved))
      throw new Error(`Non-registry lockfile source refused: ${key}`);
  }
  const extensions = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json", ".css",
    "/index.ts", "/index.tsx", "/index.js"];
  const available = (path) => extensions.some((extension) => contents.has(path + extension));
  for (const [path, bytes] of contents) {
    if (!/\.(?:[cm]?[jt]sx?)$/.test(path)) continue;
    const text = bytes.toString("utf8");
    const imports = [...text.matchAll(/\b(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s*)["']([^"'\r\n]+)["']/g)].map((match) => match[1]);
    const owner = path.startsWith("apps/web/") ? "apps/web"
      : directories.find((dir) => dir && path.startsWith(`${dir}/`)) ?? "";
    const pkg = manifests.get(owner);
    for (const spec of imports) {
      if (isBuiltin(spec)) continue;
      if (spec.startsWith(".") || spec.startsWith("@/")) {
        // Next creates only these production declarations during build. They
        // are never copied; next-env itself remains a fingerprinted source.
        if (path === "apps/web/next-env.d.ts"
            && ["./.next/types/routes.d.ts", "./.next/types/root-params.d.ts"].includes(spec)) continue;
        const target = spec.startsWith("@/") ? `apps/web/${spec.slice(2)}`
          : slash(relative(sourceDefault, resolve(sourceDefault, dirname(path), spec)));
        if (!safeRelative(target) || !available(target)) throw new Error(`Missing local import in ${path}: ${spec}`);
      } else {
        const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
        if (!Object.hasOwn({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies,
          ...root.dependencies, ...root.devDependencies }, name))
          throw new Error(`Undeclared import in ${path}: ${name}`);
      }
    }
  }
  const vercel = parse("apps/web/vercel.json");
  if (vercel.framework !== "nextjs" || vercel.buildCommand !== "node scripts/vercel-build.mjs")
    throw new Error("Vercel build contract differs from release policy");
  return { lockfileVersion: lock.lockfileVersion, packageManager: root.packageManager,
    workspaces: [...byName].map(([name, path]) => ({ name, path })) };
}

async function snapshot(sourceRoot) {
  const root = await noLinks(sourceRoot);
  const contents = new Map();
  let total = 0;
  async function add(path) {
    if (!safeRelative(path) || secretFilename(path)) throw new Error(`Forbidden source filename: ${path}`);
    const full = join(root, path);
    await noLinks(full);
    const info = await lstat(full);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error(`Invalid release source file: ${path}`);
    const bytes = await readFile(full);
    await noLinks(full);
    inspectText(path, bytes);
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new Error("Release source exceeds byte limit");
    contents.set(path, bytes);
  }
  async function walk(path) {
    await noLinks(join(root, path));
    for (const name of sorted(await readdir(join(root, path)))) {
      const child = `${path}/${name}`;
      if (skippedSource(child)) continue;
      const info = await lstat(join(root, child));
      if (info.isSymbolicLink()) throw new Error(`Symbolic link or junction refused: ${child}`);
      if (secretFilename(child)) throw new Error(`Forbidden source filename: ${child}`);
      if (info.isDirectory()) await walk(child);
      else if (!info.isFile() || (!SOURCE_EXTENSIONS.has(extname(name).toLowerCase()) && !PUBLIC_BRAND_ASSETS.has(child)))
        throw new Error(`Unlisted source asset refused: ${child}`);
      else await add(child);
    }
  }
  for (const path of ROOT_FILES) await add(path);
  for (const path of WEB_FILES) await add(`apps/web/${path}`);
  for (const path of WEB_SCRIPTS) await add(`apps/web/scripts/${path}`);
  for (const name of PACKAGE_NAMES) {
    await add(`packages/${name}/package.json`);
    await add(`packages/${name}/tsconfig.json`);
  }
  await add("packages/geometry/eslint.config.mjs");
  for (const path of SOURCE_TREES) await walk(path);
  // A newly added workspace must not silently disappear from an old allowlist.
  for (const parent of ["apps", "packages"])
    for (const name of await readdir(join(root, parent))) {
      if (skippedSource(`${parent}/${name}`)) continue;
      try {
        const info = await lstat(join(root, parent, name, "package.json"));
        if (info && !contents.has(`${parent}/${name}/package.json`))
          throw new Error(`Unlisted workspace: ${parent}/${name}`);
      } catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }
    }
  const dependencies = dependencyChecks(contents);
  const files = sorted(contents.keys()).map((path) => ({ path, sizeBytes: contents.get(path).length, sha256: sha(contents.get(path)) }));
  return { contents, files, dependencies, workerRevision: identity(files) };
}

export async function inspectReleaseSources({ sourceRoot = sourceDefault } = {}) {
  const { files, dependencies, workerRevision } = await snapshot(sourceRoot);
  return { version: VERSION, files, dependencies, workerRevision };
}

function permittedBuildOutput(path, isDirectory) {
  return (isDirectory && path.split("/").at(-1) === "node_modules")
    || (isDirectory && path === "apps/web/.next")
    || (!isDirectory && /^(?:apps\/web|packages\/(?:ai-router|analytics|geometry|types|ui))\/[^/]+\.tsbuildinfo$/.test(path));
}

export async function verifyReleaseCandidate({ output, sourceRoot = sourceDefault,
  againstSource = false, allowBuildOutput = false, expectedRevision } = {}) {
  const root = await noLinks(output);
  await noLinks(join(root, MANIFEST));
  if ((await lstat(join(root, MANIFEST))).size > MAX_FILE_BYTES) throw new Error("Oversized release manifest");
  const manifest = JSON.parse(await readFile(join(root, MANIFEST), "utf8"));
  if (manifest.version !== VERSION || !Array.isArray(manifest.bootstrapFiles)
      || manifest.sourceSnapshotVerified !== true || manifest.qualification !== "prepared-not-built-or-deployed"
      || !same(sorted(Object.keys(manifest)), sorted(["version", "workerRevision", "bootstrapFiles", "dependencies",
        "allowedBuildOutputs", "qualification", "sourceSnapshotVerified"]))
      || !same(manifest.allowedBuildOutputs, BUILD_OUTPUTS)) throw new Error("Invalid release manifest");
  const files = manifest.bootstrapFiles;
  const names = files.map((file) => file.path);
  if (!same(names, sorted(names)) || new Set(names).size !== names.length
      || REQUIRED_FILES.some((path) => !names.includes(path))
      || files.some((file) => !permittedBootstrap(file.path)
        || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || file.sizeBytes > MAX_FILE_BYTES
        || !/^[a-f0-9]{64}$/.test(file.sha256))) throw new Error("Invalid release file records");
  if (files.reduce((sum, file) => sum + file.sizeBytes, 0) > MAX_TOTAL_BYTES)
    throw new Error("Release source exceeds byte limit");
  if (manifest.workerRevision !== identity(files) || (expectedRevision && manifest.workerRevision !== expectedRevision))
    throw new Error("Release identity differs");
  const expected = new Set([...names, MANIFEST]);
  const found = new Set();
  const ignoredBuildOutputs = [];
  async function walk(path = "") {
    for (const name of sorted(await readdir(join(root, path)))) {
      const child = path ? `${path}/${name}` : name;
      const info = await lstat(join(root, child));
      if (allowBuildOutput && permittedBuildOutput(child, info.isDirectory())) {
        if (info.isSymbolicLink()) throw new Error(`Build root cannot be a link: ${child}`);
        ignoredBuildOutputs.push(child);
        continue;
      }
      if (info.isSymbolicLink()) throw new Error(`Symbolic link or junction refused: ${child}`);
      if (info.isDirectory()) {
        if (![...expected].some((path) => path.startsWith(`${child}/`)))
          throw new Error(`Unexpected release directory: ${child}`);
        await walk(child);
      }
      else if (!info.isFile() || !expected.has(child)) throw new Error(`Unexpected release file: ${child}`);
      else found.add(child);
    }
  }
  await walk();
  if (found.size !== expected.size) throw new Error("Missing release source file");
  const contents = new Map();
  for (const file of files) {
    await noLinks(join(root, file.path));
    const bytes = await readFile(join(root, file.path));
    if (bytes.length !== file.sizeBytes || sha(bytes) !== file.sha256)
      throw new Error(`Release file fingerprint differs: ${file.path}`);
    inspectText(file.path, bytes);
    contents.set(file.path, bytes);
  }
  const dependencies = dependencyChecks(contents);
  if (!same(dependencies, manifest.dependencies)) throw new Error("Release dependency evidence differs");
  if (againstSource) {
    const current = await snapshot(sourceRoot);
    if (current.workerRevision !== manifest.workerRevision) throw new Error("Source checkout differs from release snapshot");
  }
  return { version: VERSION, status: "verified", workerRevision: manifest.workerRevision,
    fileCount: files.length, againstSource, ignoredBuildOutputs };
}

export async function prepareReleaseCandidate({ output, sourceRoot = sourceDefault } = {}) {
  if (typeof output !== "string" || !output.trim()) throw new Error("An output directory is required");
  const source = await noLinks(sourceRoot);
  const destination = resolve(output);
  try { await lstat(destination); throw new Error("Output already exists"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await noLinks(dirname(destination));
  if (contained(destination, source) || (contained(source, destination)
      && (!contained(join(source, "artifacts"), destination) || destination === join(source, "artifacts"))))
    throw new Error("Unsafe output nesting: use an external directory or a new artifacts child");
  const captured = await snapshot(source);
  await mkdir(destination, { recursive: false });
  for (const [path, bytes] of captured.contents) {
    const target = join(destination, path);
    await mkdir(dirname(target), { recursive: true });
    await noLinks(dirname(target));
    await writeFile(target, bytes, { flag: "wx" });
  }
  const after = await snapshot(source);
  if (after.workerRevision !== captured.workerRevision)
    throw new Error("Source changed during preparation; incomplete output has no release manifest");
  const manifest = { version: VERSION, workerRevision: captured.workerRevision,
    bootstrapFiles: captured.files, dependencies: captured.dependencies, allowedBuildOutputs: BUILD_OUTPUTS,
    qualification: "prepared-not-built-or-deployed", sourceSnapshotVerified: true };
  await writeFile(join(destination, MANIFEST), json(manifest), { flag: "wx" });
  const verified = await verifyReleaseCandidate({ output: destination, expectedRevision: captured.workerRevision });
  return { ...verified, status: "prepared", output: destination };
}

async function cli() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--output" || arg === "--expected-revision") {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`Missing value for ${arg}`);
      const key = arg === "--output" ? "output" : "expectedRevision";
      if (options[key] !== undefined) throw new Error(`Duplicate option ${arg}`);
      options[key] = args[++i];
    } else if (["--verify", "--against-source", "--allow-build-output"].includes(arg)) {
      const key = { "--verify": "verify", "--against-source": "againstSource", "--allow-build-output": "allowBuildOutput" }[arg];
      if (options[key]) throw new Error(`Duplicate option ${arg}`);
      options[key] = true;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.output) throw new Error("Usage: prepare-release-candidate.mjs --output NEW-DIRECTORY [--verify [--against-source] [--allow-build-output] [--expected-revision sha256:...]]");
  if (!options.verify && (options.againstSource || options.allowBuildOutput || options.expectedRevision))
    throw new Error("Verification options require --verify");
  console.log(json(await (options.verify ? verifyReleaseCandidate(options) : prepareReleaseCandidate(options))));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  cli().catch((error) => { console.error(error.message); process.exitCode = 1; });
