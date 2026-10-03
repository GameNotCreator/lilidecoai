import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { evaluateProductionConfig } from "./production-preflight-policy.mjs";
import {
  MANIFEST,
  verifyReleaseCandidate,
} from "./prepare-release-candidate.mjs";

function run(command, args, { env, cwd }) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env,
    cwd,
    shell: process.platform === "win32" && command === "npm.cmd",
  });
  if (result.error || result.status !== 0)
    throw new Error("Release build subprocess failed");
}

export async function runVercelBuild({
  env = process.env,
  cwd = process.cwd(),
  execute = run,
  verify = verifyReleaseCandidate,
  manifestExists = async (path) => {
    try {
      await access(path);
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  },
} = {}) {
  if (env.VERCEL_ENV === "production") {
    // Local policy precedes network access. Publishing never migrates.
    const policy = evaluateProductionConfig(env);
    if (!policy.passed)
      throw new Error(
        `Production configuration refused: ${policy.checks
          .filter((check) => !check.passed)
          .map((check) => check.id)
          .join(", ")}`,
      );
    const root = resolve(cwd, "../..");
    const hasManifest = await manifestExists(resolve(root, MANIFEST));
    if (hasManifest) {
      if (!env.RENDER_WORKER_REVISION?.startsWith("sha256:"))
        throw new Error(
          "A packaged release requires its explicit content revision",
        );
      await verify({
        output: root,
        allowBuildOutput: true,
        expectedRevision: env.RENDER_WORKER_REVISION,
      });
    } else if (env.RENDER_WORKER_REVISION?.startsWith("sha256:")) {
      throw new Error("Content revision requires a verified release manifest");
    }
    await execute(
      process.execPath,
      ["scripts/production-preflight.mjs", "--runtime"],
      { env, cwd },
    );
  }
  await execute(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "build"],
    { env, cwd },
  );
  if (env.VERCEL_ENV === "production") {
    // Build time can admit new work on the live revision. Refresh the read-only
    // drainage check after a successful build, while publication can still fail.
    await execute(
      process.execPath,
      ["scripts/production-preflight.mjs", "--runtime"],
      { env, cwd },
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  runVercelBuild().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
