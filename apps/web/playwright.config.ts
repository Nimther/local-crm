
import { defineConfig } from "@playwright/test";
import { resolveEnvPath } from "../../scripts/env-path.mjs";

import { provisionE2eDatabase } from "./e2e/provision-database.js";

// Load this machine's configuration into the PLAYWRIGHT process (not into the servers it
// starts), mirroring every vitest.config.ts in the repo. Two things need it:
// TEST_ADMIN_DATABASE_URL, without which provisioning cannot create a database;
// and DATABASE_URL, which is what the provisioning guard compares the freshly
// provisioned DSN AGAINST — with nothing to compare to, that half of the check
// would pass vacuously.
try {
  process.loadEnvFile(resolveEnvPath());
} catch {
  // No configuration file — rely on already-exported environment variables
}

// 08-18: awaited HERE, at module scope, and not in a globalSetup hook. Every
// Playwright startup task — including the one that starts the webServers —
// runs after this module has been evaluated, which is the only point in the
// lifecycle early enough to decide what database the API server boots against.
// See e2e/provision-database.ts for the ordering this replaced and the
// evidence that it was wrong.
const { databaseUrl: e2eDatabaseUrl, authDatabaseUrl: e2eAuthDatabaseUrl } =
  await provisionE2eDatabase();

/**
 * 08-10 (QG-04): the E2E lane runs against an ephemeral database of its own.
 *
 * `./e2e/provision-database.ts` provisions one through @mega-crm/test-support —
 * the same functions the vitest suites use — applies the schema, guards the
 * resolved DSN and prints it behind the `[e2e:database]` marker.
 * `./e2e/run-e2e.ts` — the `test:e2e` entrypoint, which spawns this runner —
 * drops it once the runner has exited.
 *
 * There is deliberately NO `globalTeardown` here. It used to hold the drop, and
 * that was wrong for the same class of reason provisioning could not be a
 * `globalSetup`: teardown tasks are `unshift`ed, so they run in reverse of setup
 * order, which puts `globalTeardown` BEFORE the webServer plugin stops the
 * servers. The drop's `pg_terminate_backend` therefore killed the live API
 * server's pool connections and every run — green ones included — ended in
 * `57P01: terminating connection due to administrator command`. The drop had to
 * move outside Playwright's lifecycle entirely; see `./e2e/run-e2e.ts` for the
 * source-level evidence. Run the suite through `npm run test:e2e`, not through
 * `playwright test` directly, or nothing will drop the database.
 *
 * It is awaited above rather than registered as `globalSetup`, and that is the
 * whole correctness argument: 08-10 used the hook, and the hook runs AFTER the
 * webServer plugin, so the server it was meant to redirect had already read
 * DATABASE_URL. 08-18 moved it and passes the DSN to the server by name.
 *
 * The two webServer entries run `dev:e2e`, which is where the API's whole
 * environment comes from — the block below plus the DSN named in it. The
 * server has no other source for a connection string, so an unprovisioned run
 * fails to boot rather than quietly reaching dev.
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
        // 08-18: named EXPLICITLY, reversing 08-10's decision to let it be
        // inherited. Inheritance was the defect: the server starts before
        // globalSetup, so it inherited the value that was in the environment
        // at that moment — the developer's dev DSN — and 08-10's ephemeral
        // assignment arrived too late to matter. Freezing the config-load
        // value is now correct precisely because provisioning happens at
        // config load.
        DATABASE_URL: e2eDatabaseUrl,
        // Phase 10 split better-auth onto its own least-privilege login role.
        // Point that role at the SAME ephemeral database explicitly; inheriting
        // a developer/CI AUTH_DATABASE_URL would split auth rows away from the
        // application data and make the isolation check fail.
        AUTH_DATABASE_URL: e2eAuthDatabaseUrl,
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
        OPERATOR_ALERT_EMAIL: "ops@megacrm.test",
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
