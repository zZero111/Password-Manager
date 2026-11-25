import { defineConfig, devices } from "@playwright/test";

// UI smoke tests: the built app (vite preview of apps/app/dist) driven by Chromium
// against a throwaway Server started per test (see e2e/harness.ts).
// Run via `pnpm smoke` (from the repo root or apps/app), which builds the Server and the app first.
// Not vite's default 4173, so a running `vite preview` doesn't block the smoke run. Override with SMOKE_PORT.
const PREVIEW_PORT = Number(process.env.SMOKE_PORT ?? 4317);

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 30_000 }, // Argon2id key derivation takes a few seconds
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    baseURL: `http://localhost:${PREVIEW_PORT}`,
    trace: "off",
    // Locally, a pre-installed Chromium can be used instead of `playwright install`.
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx vite preview --port ${PREVIEW_PORT} --strictPort`,
    url: `http://localhost:${PREVIEW_PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
