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
  },
});
