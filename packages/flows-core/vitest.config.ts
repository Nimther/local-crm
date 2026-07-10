import { configDefaults, defineConfig } from "vitest/config";

// flows-core is a pure, DB-free package (segments-core sibling) -- no real
// Postgres/Redis connection is ever opened by its tests, so this config
// only needs the standard node test environment (mirrors delivery-core's
// vitest.config.ts minus the .env/DATABASE_URL wiring, which is not needed
// here since there is no integration-test lane in this package).
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
