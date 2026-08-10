import { configDefaults, defineConfig } from "vitest/config";

// Phase 12 (WRK-11, D-10): packages/queue-core gets its own test lane, same
// shape as packages/redaction's and packages/kms's.
//
// No database, no live service, no globalSetup -- connection.ts/
// queue-options.ts are pure functions over plain data (URL parsing, constant
// arithmetic). `@mega-crm/delivery-core` is imported ONLY by the timing
// invariant test (a devDependency, not a runtime one) to assert against the
// real exported SendGrid timeout constant.
export default defineConfig({
  test: {
    watch: false,
    globals: true,
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 20_000,
    exclude: [...configDefaults.exclude, "dist/**"],
  },
});
