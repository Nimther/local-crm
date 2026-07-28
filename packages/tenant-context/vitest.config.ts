import { configDefaults, defineConfig } from "vitest/config";
import { resolveEnvPath } from "../../scripts/env-path.mjs";

// Load this machine's configuration for local runs, at the path resolveEnvPath()
// decides (08-15). Optional -- shell and CI variables take precedence.
try {
  process.loadEnvFile(resolveEnvPath());
} catch {
  // No configuration file -- rely on already-exported environment variables
}

// 08-16 (QG-03): packages/tenant-context gets its own test lane.
//
// This package needs a LIVE Postgres, unlike packages/kms: the session variable
// and the RLS behaviour it feeds only exist in the database. globalSetup gives
// it its own ephemeral one, the same hook apps/api, apps/worker and
// packages/delivery-core use (08-06).
//
// Note the module under test binds its Pool to process.env.DATABASE_URL at
// module load, and globalSetup rewrites that before the test workers fork —
// which is why the pool lands on the ephemeral database rather than dev.
export default defineConfig({
  test: {
    watch: false,
    globals: true,
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    globalSetup: ["../test-support/src/global-setup.ts"],
    exclude: [...configDefaults.exclude, "dist/**"],
  },
});
