import path from "node:path";
import { defineConfig } from "vitest/config";

// Load the repo-root .env for local dev/test runs (Node >=20.6 native loader).
// Optional — CI/shell-exported env vars take precedence when no .env exists.
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, "../../.env"));
} catch {
  // .env not present — rely on already-exported environment variables
}

export default defineConfig({
  test: {
    // Non-watch default per Wave-0 requirement: `vitest run` behavior even
    // when invoked as plain `vitest` from package.json's "test" script.
    watch: false,
    globals: true,
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 20_000,
    env: {
      // Route every test run at the isolated test database, never the dev
      // DATABASE_URL, so tests can never touch real dev data.
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
    },
  },
});
