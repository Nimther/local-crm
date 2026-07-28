import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

// Load the repo-root .env for local dev/test runs (Node >=20.6 native loader).
// Optional — CI/shell-exported env vars take precedence when no .env exists.
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, "../../.env"));
} catch {
  // .env not present — rely on already-exported environment variables
}

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
export default defineConfig({
  test: {
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
    exclude: [...configDefaults.exclude, "dist/**"],
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
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
    },
  },
});
