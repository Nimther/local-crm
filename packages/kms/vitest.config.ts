import { configDefaults, defineConfig } from "vitest/config";

// 08-16 (QG-03): packages/kms gets its own test lane.
//
// No database, no live KMS, no globalSetup: the local provider is a static-KEK
// dev path and that is exactly what makes envelope encryption unit-testable.
// Provisioning an ephemeral database here would create and drop one for nothing.
//
// The two values below are copied verbatim from apps/api/vitest.config.ts so
// the two lanes cannot drift. The KEK is a test-only constant, never a real key.
export default defineConfig({
  test: {
    watch: false,
    globals: true,
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 20_000,
    exclude: [...configDefaults.exclude, "dist/**"],
    env: {
      KMS_PROVIDER: "local",
      KMS_LOCAL_KEK: "grdVCb1fxmhPzylKEPqafcPW4xOMaynE0UwaFUo2OUE=",
    },
  },
});
