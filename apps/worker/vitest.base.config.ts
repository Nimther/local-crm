import { configDefaults } from "vitest/config";
import type { ViteUserConfig } from "vitest/config";
import { resolveEnvPath } from "../../scripts/env-path.mjs";

/**
 * Debug session `ci-tenant-fairness-double-run` (2026-08-20).
 *
 * NOT a Vitest entrypoint. Vitest never discovers this file by itself — its
 * config discovery matches the exact basenames `vitest.config.*`/`vite.config.*`
 * and nothing else. The `.config.ts` suffix is load-bearing for a different
 * reason: it is what lands this file inside eslint.config.js block 3's
 * per-app config-file glob. A sibling named `vitest.shared.ts` would sit
 * outside EVERY block, fall through to the default espree parser and fail
 * fatally on the first type annotation.
 *
 * It exists because apps/worker now has TWO entrypoints that must agree on
 * everything except which files they collect:
 *
 *   vitest.config.ts           the ordinary one, inherited by the root
 *                              aggregate (`npm run coverage`, CI job `test`).
 *                              Excludes the timing-sensitive load tests.
 *   vitest.loadtest.config.ts  the quiet lane the load tests run in, selected
 *                              explicitly with `--config`.
 *
 * The base below is IMPORTED by both rather than restated in each. Restating it
 * is the failure mode this file prevents: `globalSetup` is the fail-closed
 * test-database guard, `fileParallelism: false` is what stops
 * flow-run-advance-integration.test.ts stealing sibling files' jobs, and the
 * `env` block is what makes the suite deterministic on a clean machine. Any of
 * those silently missing from one entrypoint produces a run that looks fine and
 * is not.
 */

// Load this machine's configuration for local dev/test runs, at the path
// resolveEnvPath() decides (08-15).
// Optional — CI/shell-exported env vars take precedence when no .env exists.
try {
  process.loadEnvFile(resolveEnvPath());
} catch {
  // No configuration file — rely on already-exported environment variables
}

type WorkerTestConfig = NonNullable<ViteUserConfig["test"]>;

/**
 * Debug session `ci-tenant-fairness-double-run` (2026-08-20): the two files
 * that must NOT be collected by the root aggregate entrypoint.
 *
 * Both measure THROUGHPUT RATIOS, and a throughput ratio is only meaningful in
 * the environment it was calibrated in. The aggregate is not that environment:
 * it runs under v8 coverage instrumentation, on top of the Postgres/Redis state
 * ~60 sibling worker test files have already accumulated in the shared
 * ephemeral database. Both slow per-job dispatch, and they penalise the
 * 72-job contended phase more than the 12-job baseline phase — which is
 * precisely the direction of the miss that turned the required `test` check red
 * on runs 32252330419 and 32338805301 while the dedicated `failure-injection`
 * job passed the identical assertion on the identical commit.
 *
 * - `tenant-fairness.test.ts` keeps running, unchanged and mandatory, in the
 *   `failure-injection` job — a REQUIRED status check on master (verified
 *   2026-08-20 against the branch-protection API: contexts are `static`,
 *   `test`, `failure-injection`, `enforce_admins: true`). This relocates the
 *   gate; it does not weaken it. `TENANT_FAIRNESS_MIN_BASELINE_RATIO` stays
 *   at 0.9.
 * - `loadtest/**` is on-demand only (D-04). Its own header and
 *   `fairness-constants.ts` have always CLAIMED it is "deliberately NOT wired
 *   into CI"; nothing ever implemented that claim, so 15 seconds of full-rate
 *   `DEFAULT_TENANT_RPS` load ran on every pull request — immediately
 *   alongside the one measurement it was most able to disturb. This line is
 *   what finally makes the documented intent true.
 *
 * Deliberately NOT the whole `failure-injection/` directory: the other fifteen
 * files there are deterministic correctness tests whose aggregate-run execution
 * feeds the `coverage:gate` denominator. `rate-limit-429.test.ts` is pinned as
 * a positive control in scripts/__tests__/aggregate-loadtest-exclusion.test.mjs
 * so a future widening of these globs fails loudly instead of quietly dropping
 * source coverage.
 *
 * Paths are relative to this project's root (apps/worker), the same basis
 * `dist/**` below already relies on.
 */
export const AGGREGATE_EXCLUDED_LOAD_TESTS = [
  "src/queues/__tests__/failure-injection/tenant-fairness.test.ts",
  "src/queues/__tests__/loadtest/**",
];

/**
 * Test-Redis convention (02-05, RESEARCH.md Validation Architecture):
 *
 * - Pure-unit tests (e.g. connection.test.ts) construct BullMQ/ioredis
 *   connection *config* against a dummy REDIS_URL and never open a real
 *   socket — no live Redis needed, nothing to isolate.
 * - Integration tests that DO need a live Redis (queue/worker round-trip
 *   tests added in 02-06/02-07) must use `TEST_REDIS_URL`, which points at
 *   a dedicated logical DB index (e.g. `redis://localhost:6379/1`, DB 1)
 *   separate from the dev worker's DB 0 — so test runs can never observe or
 *   clobber dev-time queue state. Tests that want full isolation from any
 *   real Redis process at all should reach for `ioredis-mock` instead.
 */
export const workerTestBase = {
  watch: false,
  globals: true,
  environment: "node",
  testTimeout: 20_000,
  hookTimeout: 20_000,
  // 08-01 (QG-04): the fail-closed test-database guard. Runs before vitest
  // collects any test file, so a TEST_DATABASE_URL that is unset, or that
  // resolves to the same physical database as DATABASE_URL, aborts the run
  // before a single test opens a connection. There is no opt-out.
  globalSetup: ["../../packages/test-support/src/global-setup.ts"],
  // 06-12: flow-run-advance-integration.test.ts registers a REAL BullMQ
  // Worker against the SAME shared FLOW_RUN_ADVANCE_QUEUE every other
  // flow-engine test file enqueues onto (real Redis, no per-file
  // namespacing -- that queue is a genuinely global singleton by design).
  // With Vitest's default file-level parallelism, that worker can run
  // concurrently with sibling test files and steal/process their advance
  // jobs mid-test, silently mutating flow_runs rows those tests didn't
  // expect touched (observed: a `waiting` run flipped to `completed`
  // before its own test's assertion ran). Serializing file execution
  // removes the overlap window entirely -- the worker only exists while
  // ITS OWN file's beforeAll/afterAll are active, and no other file's
  // tests execute during that window.
  fileParallelism: false,
  // `npm run build`'s tsc output (dist/**) mirrors src/**/*.test.ts as
  // compiled .test.js — without this exclude, vitest's default glob picks up
  // BOTH the source and the compiled copy and runs every test twice.
  // `precoverage` builds apps/worker, so the aggregate always meets a
  // populated dist/.
  exclude: [...configDefaults.exclude, "dist/**"],
  env: {
    // 08-02: deliberately NOT `process.env.TEST_DATABASE_URL ?? ""`. This
    // config module evaluates BEFORE the setup hook runs, so an eager read here
    // would freeze an empty string and the per-run ephemeral DSN provisioned
    // by the setup hook would never reach the test workers. Omitting the key
    // lets the value that hook writes into process.env be inherited by the
    // forked test processes instead.
    REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://localhost:6379/1",
    // 04-04: send-dispatch.ts pulls in @mega-crm/kms (decryptTenantSecret)
    // and @mega-crm/delivery-core (signUnsubscribeToken/buildListUnsubscribeUrl),
    // both of which read these directly from process.env with no zod
    // schema -- test-only values, mirroring apps/api/vitest.config.ts's
    // identical 04-03 defaults so both apps' test suites stay in lockstep.
    KMS_PROVIDER: process.env.KMS_PROVIDER ?? "local",
    KMS_LOCAL_KEK: process.env.KMS_LOCAL_KEK ?? "grdVCb1fxmhPzylKEPqafcPW4xOMaynE0UwaFUo2OUE=",
    UNSUBSCRIBE_TOKEN_SECRET:
      process.env.UNSUBSCRIBE_TOKEN_SECRET ?? "test-only-unsubscribe-secret-at-least-32-bytes",
    // Deterministic regardless of the repo-root .env: dev/UAT populates a real
    // PUBLIC_APP_URL there, and a plain `process.env.PUBLIC_APP_URL ??` fallback
    // would leak it into unsubscribe-URL assertions. TEST_-prefixed override
    // mirrors the TEST_DATABASE_URL / TEST_REDIS_URL convention above.
    PUBLIC_APP_URL: process.env.TEST_PUBLIC_APP_URL ?? "https://api.test.local",
    // Phase 13's erasure-enqueue failure-injection test imports the API's
    // contact repository as a test-only dependency.  Keep that import
    // deterministic on clean CI machines instead of relying on a developer
    // .env to satisfy the API module's boot-time schema.
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "test-only-better-auth-secret-value",
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? "http://localhost:4000",
    WEB_URL: process.env.WEB_URL ?? "http://localhost:5173",
    PLATFORM_SENDGRID_API_KEY:
      process.env.PLATFORM_SENDGRID_API_KEY ?? "SG.test_platform_key_0000000000000000",
    PLATFORM_MAIL_FROM: process.env.PLATFORM_MAIL_FROM ?? "noreply@megacrm.test",
    OPERATOR_ALERT_EMAIL: process.env.OPERATOR_ALERT_EMAIL ?? "ops@megacrm.test",
  },
} satisfies WorkerTestConfig;
