import { spawn } from "node:child_process";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { fileURLToPath } from "node:url";

const repl = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: "wiredTiger" },
});
try {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url),
      ),
      "run",
      "tests/durable-integration.test.ts",
    ],
    {
      cwd: new URL("../", import.meta.url),
      stdio: "inherit",
      windowsHide: true,
      env: {
        ...process.env,
        DURABLE_TEST_MONGODB_URI: repl.getUri(),
        AI_MOCK_MODE: "true",
        OPENAI_API_KEY: "",
        GOOGLE_AI_API_KEY: "",
        GEMINI_API_KEY: "",
        CLOUDINARY_URL: "",
        CLOUDINARY_CLOUD_NAME: "",
        CLOUDINARY_API_KEY: "",
        CLOUDINARY_API_SECRET: "",
      },
    },
  );
  process.exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
} finally {
  await repl.stop();
}
