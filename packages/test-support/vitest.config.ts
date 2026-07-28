import { configDefaults, defineConfig } from "vitest/config";
import { resolveEnvPath } from "../../scripts/env-path.mjs";

// 08-01 set no `globalSetup` and no `env.DATABASE_URL` block here (unlike
// apps/worker and packages/delivery-core) on the grounds that this workspace's
// own tests were pure — guard.ts is a pure function over two DSN strings and
// never opens a connection — so requiring a provisioned test database would
// have made the guard's own suite depend on the provisioning it exists to
// police. That still holds and neither is added below.
//
// 08-07: the "pure" premise no longer covers the whole workspace. 08-02 and
// 08-06 added provision-db.test.ts and db-fixture-isolation.test.ts, which do
// open real connections, and they reach Postgres through provision-db.ts's
// admin DSN. That DSN defaults to the `postgres` superuser role, which exists
// in the docker-compose `db` service but not in a Homebrew install, so both
// files failed locally with `role "postgres" does not exist` while passing in
// CI. provision-db.ts already reads TEST_ADMIN_DATABASE_URL as an override;
// it simply had nowhere to be set. Loading this machine's configuration here gives it
// one, and is the same optional/try-catch shape apps/worker uses — shell and
// CI environment variables still take precedence.
try {
  process.loadEnvFile(resolveEnvPath());
} catch {
  // No configuration file — rely on already-exported environment variables
}

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
