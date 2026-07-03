import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

// Load the repo-root .env for local dev/test runs (Node >=20.6 native loader).
// Optional — CI/shell-exported env vars take precedence when no .env exists.
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, "../../.env"));
} catch {
  // .env not present — rely on already-exported environment variables
}

export default defineConfig({
  test: {
    // Non-watch default per Wave-0 requirement: `vitest run` behavior even
    // when invoked as plain `vitest` from package.json's "test" script.
    watch: false,
    globals: true,
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // `npm run build`'s tsc output (dist/**) mirrors src/**/*.test.ts as
    // compiled .test.js — without this exclude, vitest's default glob picks
    // up BOTH the source and the compiled copy and silently runs every test
    // twice per `vitest run` (with no path filter).
    exclude: [...configDefaults.exclude, "dist/**"],
    env: {
      // Route every test run at the isolated test database, never the dev
      // DATABASE_URL, so tests can never touch real dev data.
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
      // Test-safe platform-mail credentials (never real SendGrid values) --
      // outbound requests are always intercepted by `nock` in tests that
      // exercise platformMail, so these never touch the real network.
      PLATFORM_SENDGRID_API_KEY:
        process.env.PLATFORM_SENDGRID_API_KEY ?? "SG.test_platform_key_0000000000000000",
      PLATFORM_MAIL_FROM: process.env.PLATFORM_MAIL_FROM ?? "noreply@megacrm.test",
    },
  },
});
