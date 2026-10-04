import { defineConfig, devices } from "@playwright/test"
import { APP_URL, HARNESS_URL, SANDBOX_URL } from "./tests/browser/urls.ts"

// Browser tests run against production builds: the app built against a
// stand-in Supabase URL (`bun run build:browser-test`, see .env.browser-test),
// the test harness (`bun run build:harness`, which also writes its frame page
// for a sandbox domain), and the app's next version for the update journey
// (`bun run build:next-version`). Build all three first.
export default defineConfig({
  testDir: "tests/browser",
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  // Service workers are blocked except in offline.spec.ts, which allows them:
  // `page.route` does not see requests a worker answers, and each test would
  // otherwise download the whole app into its cache.
  use: { trace: "retain-on-failure", serviceWorkers: "block" },
  // Pages load the full editor; on busy CI runners the first checks after a
  // load can take longer than the 5 second default.
  expect: { timeout: 10_000 },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // Firefox on CI runners now and then drops a click made right after a page
    // loads (never reproduced elsewhere), so CI gives Firefox one retry. A test
    // that passes on retry is still reported as flaky.
    { name: "firefox", use: { ...devices["Desktop Firefox"] }, retries: process.env.CI ? 1 : 0 },
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
    // The harness's frame page on a second origin, through the sandbox
    // domain's Worker (rendered-sandbox.spec.ts). Every path but the frame's
    // files is not found, so it waits for the port.
    {
      command: "node tests/browser/sandbox-server.ts",
      port: Number(new URL(SANDBOX_URL).port),
      reuseExistingServer: !process.env.CI,
    },
  ],
})
