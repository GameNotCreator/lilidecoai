import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [["html", { open: "never" }], ["list"]],
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 14"] } },
  ],
  webServer: [
    {
      command:
        "python -m uvicorn app.main:app --app-dir services/api --host 127.0.0.1 --port 8000",
      port: 8000,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { DEMO_MODE: "true", OPENAI_API_KEY: "" },
    },
    {
      command: "npm run dev --workspace @visualizer/web",
      port: 3000,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { NEXT_PUBLIC_API_URL: "http://127.0.0.1:8000" },
    },
  ],
});

