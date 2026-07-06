import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Minimal web unit-test lane (04-18 gap closure) -- vitest is already
 * hoisted for @mega-crm/api and @mega-crm/worker, no new installs needed.
 * The only unit under test today (segmentSaveGate) is a pure function with
 * no DOM dependency, so `environment: "node"` is sufficient -- no jsdom or
 * @testing-library install required. The `@` alias mirrors vite.config.ts
 * so future component tests can import via the same paths as app code.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
