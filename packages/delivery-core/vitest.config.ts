import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

// Load the repo-root .env for local dev/test runs (Node >=20.6 native loader),
// mirroring apps/worker/vitest.config.ts's convention. Optional -- delivery-core's
// own unit tests never open a real DB/Redis connection (pre-send-gate/send-ledger
// tests stub the PoolClient directly), so this is only here for parity/future use.
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, "../../.env"));
} catch {
  // .env not present -- rely on already-exported environment variables
}

export default defineConfig({
  test: {
    watch: false,
    globals: true,
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 20_000,
    exclude: [...configDefaults.exclude, "dist/**"],
    env: {
      // 04-10: send-ledger-integrity.test.ts is delivery-core's first
      // integration test needing a real Postgres connection (RLS-forced
      // fixtures via @mega-crm/tenant-context's withTenant/withTenantTransaction)
      // -- route it at the isolated test database, matching apps/api and
      // apps/worker's vitest.config.ts convention. Every OTHER existing test
      // in this package stubs the PoolClient directly and never opens a real
      // connection, so this is additive and does not change their behavior.
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
    },
  },
});
