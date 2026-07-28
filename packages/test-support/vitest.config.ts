import { configDefaults, defineConfig } from "vitest/config";

// 08-01: deliberately does NOT load the repo-root .env and does NOT set an
// `env.DATABASE_URL` block (unlike apps/worker and packages/delivery-core).
// This workspace's own tests are pure — guard.ts is a pure function over two
// DSN strings and never opens a connection — so requiring a provisioned test
// database here would make the guard's own test suite depend on the very
// provisioning the guard exists to police.
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
