import path from "node:path";

import { defineConfig } from "@playwright/test";

// Load the repo-root .env into the PLAYWRIGHT process (not into the servers it
// starts), mirroring every vitest.config.ts in the repo. Two things need it:
// TEST_ADMIN_DATABASE_URL, without which provisioning cannot create a database;
// and DATABASE_URL, which is what globalSetup's guard compares the freshly
// provisioned DSN AGAINST — with nothing to compare to, that half of the check
// would pass vacuously. globalSetup overwrites DATABASE_URL with the ephemeral
// DSN before any server starts, so nothing downstream sees the dev value.
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, "../../.env"));
} catch {
  // .env not present — rely on already-exported environment variables
}

/**
 * 08-10 (QG-04): the E2E lane runs against an ephemeral database of its own.
 *
 * `./e2e/global-setup.ts` provisions one through @mega-crm/test-support — the
 * same functions the vitest suites use — applies the schema, guards the
 * resolved DSN, assigns it to process.env.DATABASE_URL and prints it behind the
 * `[e2e:database]` marker. `./e2e/global-teardown.ts` drops it.
 *
 * The two webServer entries run `dev:e2e`, NOT `dev`. The difference is the
 * `--env-file=../../.env` flag that `dev` carries: it loads the developer's own
 * configuration, which points at the dev database by definition. `dev:e2e`
 * carries no such flag, so the API's whole environment comes from the block
 * below plus the DSN globalSetup assigned — and an unprovisioned run fails to
 * boot rather than quietly reaching dev.
 *
 * `reuseExistingServer` is false on both, deliberately. With it true, a
 * developer who happens to have a dev stack listening on 4000/5173 gets those
 * servers reused and their dev database written to, no matter how correctly
 * provisioning ran.
 *
 * Running against built artifacts instead of dev servers is Phase 15 (D-15).
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "npm run dev:e2e -w apps/api",
      cwd: "../..",
      url: "http://localhost:4000/api/auth/ok",
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        // DATABASE_URL is deliberately absent: it is inherited from this
        // process's environment, where globalSetup put the ephemeral DSN.
        // Naming it here would freeze whatever was set at config-load time,
        // which is before globalSetup has run.
        //
        // Everything else is enumerated from apps/api/src/env.ts's boot schema
        // and mirrors apps/api/vitest.config.ts's values so the two test lanes
        // agree. None of these is a real credential.
        NODE_ENV: "development",
        REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://localhost:6379/1",
        BETTER_AUTH_SECRET: "e2e-only-better-auth-secret-value",
        BETTER_AUTH_URL: "http://localhost:4000",
        WEB_URL: "http://localhost:5173",
        PLATFORM_SENDGRID_API_KEY: "SG.test_platform_key_0000000000000000",
        PLATFORM_MAIL_FROM: "noreply@megacrm.test",
        KMS_PROVIDER: "local",
        KMS_LOCAL_KEK: "grdVCb1fxmhPzylKEPqafcPW4xOMaynE0UwaFUo2OUE=",
        UNSUBSCRIBE_TOKEN_SECRET: "test-only-unsubscribe-secret-at-least-32-bytes",
        PUBLIC_APP_URL: "https://api.test.local",
      },
    },
    {
      command: "npm run dev:e2e",
      cwd: ".",
      url: "http://localhost:5173",
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
