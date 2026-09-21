import { spawn } from "node:child_process";
import { MongoMemoryServer } from "mongodb-memory-server";
import { fileURLToPath } from "node:url";

const database = await MongoMemoryServer.create();
try {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL(
          "../../../node_modules/@playwright/test/cli.js",
          import.meta.url,
        ),
      ),
      "test",
      ...process.argv.slice(2),
    ],
    {
      cwd: new URL("../../../", import.meta.url),
      stdio: "inherit",
      windowsHide: true,
      env: {
        ...process.env,
        E2E_MONGODB_URI: database.getUri(),
        RENDER_EXECUTION_MODE: "web",
      },
    },
  );
  process.exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
} finally {
  await database.stop();
}
