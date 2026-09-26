import { defineConfig, devices } from "@playwright/test"
import { APP_URL, HARNESS_URL } from "./tests/browser/urls.ts"

// Browser tests run against production builds: the app built against a
// stand-in Supabase URL (`bun run build:browser-test`, see .env.browser-test)
// and the test harness (`bun run build:harness`). Build both first.
export default defineConfig({
  testDir: "tests/browser",
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
  webServer: [
    {
      command: "npx vite preview --host 127.0.0.1 --port 4173 --strictPort",
      url: APP_URL,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "npx vite preview --config tests/browser/harness/vite.config.ts --host 127.0.0.1 --port 4174 --strictPort",
      url: HARNESS_URL,
      reuseExistingServer: !process.env.CI,
    },
  ],
})
