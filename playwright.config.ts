import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["html", { open: "never" }], ["list"]],
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 14"] } },
  ],
  webServer: {
    command: "node node_modules/next/dist/bin/next dev apps/web --port 3100",
    url: "http://127.0.0.1:3100/v1/health",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NEXT_IGNORE_INCORRECT_LOCKFILE: "1",
      DEMO_MODE: "true",
      AI_MOCK_MODE: "true",
      RENDER_EXECUTION_MODE: "web",
      GOOGLE_AI_API_KEY: "",
      GEMINI_API_KEY: "",
      OPENAI_API_KEY: "",
      OPENAI_IMAGE_ENABLED: "false",
      NEXT_PUBLIC_API_URL: "",
      CLOUDINARY_URL: "",
      CLOUDINARY_CLOUD_NAME: "",
      CLOUDINARY_API_KEY: "",
      CLOUDINARY_API_SECRET: "",
      MONGODB_URI:
        process.env.E2E_MONGODB_URI ??
        "mongodb://127.0.0.1:27017/lilidecoai_e2e",
      MONGODB_DB: "lilidecoai_e2e",
    },
  },
});
