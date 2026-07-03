import { defineConfig } from "@playwright/test";

/**
 * Starts the full stack (API on :4000, web on :5173) against the local dev
 * database (SKELETON.md / 01-01-SUMMARY.md: `mega_crm_app`/`mega_crm`, or
 * `docker compose up -d db`) and drives the register -> create-workspace ->
 * Owner happy path through a real browser (Task 1's failing RED test).
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "npm run dev -w apps/api",
      cwd: "../..",
      url: "http://localhost:4000/api/auth/ok",
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: "npm run dev",
      cwd: ".",
      url: "http://localhost:5173",
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
