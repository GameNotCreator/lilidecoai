import { spawnSync } from "node:child_process";

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
if (process.env.VERCEL_ENV === "production") {
  if (process.env.APPLY_IMAGE_PIPELINE_MIGRATION === "true")
    run(process.execPath, ["scripts/migrate-image-pipeline.mjs", "--apply"]);
  run(process.execPath, [
    "scripts/migrate-asset-visibility.mjs",
    ...(process.env.APPLY_ASSET_VISIBILITY_MIGRATION === "true"
      ? ["--apply"]
      : []),
  ]);
  run(process.execPath, ["scripts/production-preflight.mjs", "--runtime"]);
}
run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"]);
