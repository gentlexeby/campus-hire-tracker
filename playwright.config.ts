import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:3210",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:3210/api/health",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      CAMPUS_HIRE_TRACKER_DATA_DIR: "./.test-data/e2e",
      NEXT_TELEMETRY_DISABLED: "1"
    }
  }
});
