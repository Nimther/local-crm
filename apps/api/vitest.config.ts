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
    // 08-06 (QG-04): the same setup hook apps/worker got in 08-01 — provisions a
    // per-workspace ephemeral database, runs the fail-closed guard, and drops
    // it on teardown even when the suite fails.
    globalSetup: ["../../packages/test-support/src/global-setup.ts"],
    // `npm run build`'s tsc output (dist/**) mirrors src/**/*.test.ts as
    // compiled .test.js — without this exclude, vitest's default glob picks
    // up BOTH the source and the compiled copy and silently runs every test
    // twice per `vitest run` (with no path filter).
    exclude: [...configDefaults.exclude, "dist/**"],
    env: {
      // 08-06: deliberately NOT set here. This config module evaluates BEFORE
      // the setup hook runs, so an eager read would freeze an empty string and the
      // per-run ephemeral DSN would never reach the test workers. The forked
      // processes inherit the value that hook writes into process.env — the
      // same mechanism 08-02 established for apps/worker.
      // 02-05: REDIS_URL is boot-required by env.ts; tests never open a real
      // Redis connection (no test in apps/api exercises BullMQ/ioredis
      // directly), so a placeholder value just satisfies the Zod schema.
      REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://localhost:6379/1",
      // Test-safe platform-mail credentials (never real SendGrid values) --
      // outbound requests are always intercepted by `nock` in tests that
      // exercise platformMail, so these never touch the real network.
      PLATFORM_SENDGRID_API_KEY:
        process.env.PLATFORM_SENDGRID_API_KEY ?? "SG.test_platform_key_0000000000000000",
      PLATFORM_MAIL_FROM: process.env.PLATFORM_MAIL_FROM ?? "noreply@megacrm.test",
      // Test-safe local-KMS envelope-encryption config (01-05, RESEARCH.md
      // Pitfall 3) -- a static, test-only KEK, never used past this test
      // suite. KMS_PROVIDER defaults to "local" so envelope.test.ts and
      // sendgrid-key-connect.test.ts never require real AWS credentials.
      KMS_PROVIDER: process.env.KMS_PROVIDER ?? "local",
      KMS_LOCAL_KEK: process.env.KMS_LOCAL_KEK ?? "grdVCb1fxmhPzylKEPqafcPW4xOMaynE0UwaFUo2OUE=",
      // 04-03: delivery-core reads these directly from process.env (no zod
      // schema, matching the KMS/tenant-context pattern) -- test-only values,
      // never real platform secrets.
      UNSUBSCRIBE_TOKEN_SECRET:
        process.env.UNSUBSCRIBE_TOKEN_SECRET ?? "test-only-unsubscribe-secret-at-least-32-bytes",
      // 05-12: unlike the credential-shaped vars above (any value satisfies
      // their schema and every outbound call is nock-intercepted regardless
      // of the value), PUBLIC_APP_URL's *scheme* is now behavior-determining
      // (provisionEventWebhook's https pre-flight guard). Falling back to
      // the real dev .env's PUBLIC_APP_URL (which is exactly the kind of
      // developer-machine-dependent http value the round-4 UAT gap was
      // about) made the test suite's pass/fail outcome depend on the
      // machine it ran on. Mirrors the TEST_DATABASE_URL/TEST_REDIS_URL
      // pattern above -- only an explicit TEST_PUBLIC_APP_URL can override
      // the deterministic https default.
      PUBLIC_APP_URL: process.env.TEST_PUBLIC_APP_URL ?? "https://api.test.local",
    },
  },
});
