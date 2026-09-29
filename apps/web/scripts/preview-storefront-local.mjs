import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const dbPath = fileURLToPath(
  new URL("../../../.local-storefront/catalogue-db/", import.meta.url),
);
await mkdir(dbPath, { recursive: true });
const database = await MongoMemoryServer.create({
  instance: { dbPath, storageEngine: "wiredTiger" },
});
const child = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "dev",
    "apps/web",
    "--hostname",
    "127.0.0.1",
    "--port",
    "3105",
  ],
  {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...process.env,
      MONGODB_URI: database.getUri(),
      MONGODB_DB: "lilideco_boutique_local",
      AI_MOCK_MODE: "true",
      DEMO_MODE: "false",
      MERCHANT_SIGNUP_ENABLED: "false",
      ADMIN_CREDENTIALS_MODE: "fixed",
      ADMIN_USERNAME: "",
      ADMIN_PASSWORD: "",
      ADMIN_PASSWORD_HASH: "",
      APP_SESSION_SECRET: randomBytes(32).toString("hex"),
      SITE_URL: "http://127.0.0.1:3105",
      OPENAI_API_KEY: "",
      OPENAI_IMAGE_ENABLED: "false",
      GOOGLE_AI_API_KEY: "",
      GEMINI_API_KEY: "",
      MATTING_URL: "",
      MATTING_TOKEN: "",
      CLOUDINARY_URL: "",
      CLOUDINARY_CLOUD_NAME: "",
      CLOUDINARY_API_KEY: "",
      CLOUDINARY_API_SECRET: "",
      NEXT_PUBLIC_API_URL: "",
      RENDER_EXECUTION_MODE: "web",
      SPATIAL_ORGANIZATION_IDS: "",
      STOREFRONT_ORDERS_ENABLED: "false",
      RESEND_API_KEY: "",
      NEXT_IGNORE_INCORRECT_LOCKFILE: "1",
    },
  },
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  child.kill();
  await database.stop({ doCleanup: false, force: false });
}
process.on("SIGINT", () => {
  void stop();
});
process.on("SIGTERM", () => {
  void stop();
});
child.on("error", async (error) => {
  console.error(error.message);
  await stop();
  process.exitCode = 1;
});
child.on("exit", async (code) => {
  await stop();
  process.exitCode = code ?? 0;
});
