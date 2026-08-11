import { configDefaults, defineConfig } from "vitest/config";
import { resolveEnvPath } from "../../scripts/env-path.mjs";

// Load the repo-root .env for local dev/test runs (Node >=20.6 native loader),
// mirroring packages/delivery-core and packages/db's own vitest.config.ts.
try {
  process.loadEnvFile(resolveEnvPath());
} catch {
  // No configuration file -- rely on already-exported environment variables
}

// Phase 13, plan 13-08 (CMP-01): contacts-core's first test lane -- its new
// unsubscribe-apply.test.ts is an ephemeral-DB integration test (RLS-forced
// fixtures via @mega-crm/tenant-context's withTenant/withTenantTransaction),
// mirroring packages/delivery-core/vitest.config.ts's identical setup.
export default defineConfig({
  test: {
    watch: false,
    globals: true,
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 20_000,
    globalSetup: ["../test-support/src/global-setup.ts"],
    exclude: [...configDefaults.exclude, "dist/**"],
  },
});
