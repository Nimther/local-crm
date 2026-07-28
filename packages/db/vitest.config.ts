import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

// Load the repo-root .env for local runs (Node >=20.6 native loader), mirroring
// apps/worker and packages/delivery-core. Optional -- shell and CI variables
// take precedence.
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, "../../.env"));
} catch {
  // .env not present -- rely on already-exported environment variables
}

// 08-09 (QG-05): packages/db gets a test lane so `npm run test --workspaces`
// picks up the two migration runs.
//
// Both tests provision their OWN ephemeral database via createEphemeralDatabase
// rather than using the one this globalSetup hands them, because they need a
// guaranteed-empty starting point and globalSetup's database has already had
// the whole chain applied. The hook is still registered: it is what guarantees
// no test file in this workspace can reach the dev database, which is the
// property D-14 wants everywhere, not just where a test happens to need a DSN.
export default defineConfig({
  test: {
    watch: false,
    globals: true,
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    globalSetup: ["../test-support/src/global-setup.ts"],
    exclude: [...configDefaults.exclude, "dist/**"],
  },
});
