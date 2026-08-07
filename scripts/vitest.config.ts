import { configDefaults, defineConfig } from "vitest/config";

// 10-05 (SEC-16): `scripts/` gets its own test lane, the same reason
// packages/segments-core and packages/kms have one (08-13/08-16) -- without a
// local config, `vitest run` from this directory walks up, finds the root
// aggregating vitest.config.ts, and resolves its `projects` paths relative to
// HERE, producing a startup error. Registering this file in the root
// config's `projects` array is what makes `npx vitest run
// scripts/__tests__/lint-session-state.test.mjs` (the plan's own verify
// command) discover anything at all.
//
// No database, no globalSetup: `lint-session-state.mjs` is a pure
// filesystem/string-processing script. `scripts/**` is deliberately absent
// from the root aggregate's `coverage.include` (vitest.config.ts) -- this
// lane runs the tests, it does not fold `scripts/` into the backend coverage
// denominator.
export default defineConfig({
  test: {
    watch: false,
    globals: true,
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 20_000,
    exclude: [...configDefaults.exclude, "__fixtures__/**"],
  },
});
