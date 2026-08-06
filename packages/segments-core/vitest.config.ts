import { configDefaults, defineConfig } from "vitest/config";

// segments-core is a pure, DB-free package (flows-core sibling) -- no real
// Postgres/Redis connection is ever opened by its tests, so this config only
// needs the standard node test environment. No globalSetup: provisioning a
// database here would create and drop one for nothing on every run.
//
// 08-13: this file also has to EXIST. Without it `vitest run` from this
// directory walks up, finds the root aggregating vitest.config.ts added in
// 08-11, and resolves its `projects` paths relative to HERE — producing
// packages/segments-core/apps/api/vitest.config.ts and a startup error. The
// root config's bare directory entries still work for the aggregate; a local
// config is what keeps the standalone run working.
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
