import { configDefaults, defineConfig } from "vitest/config";

// 10-13 (SEC-13): packages/redaction gets its own test lane.
//
// No database, no live service, no globalSetup -- rules.ts/scrub.ts/
// pino-redact.ts are pure functions over plain data (mirrors packages/kms's
// lane, copied verbatim below). `pino` is imported ONLY by the parity test
// (a devDependency, not a runtime one) to drive a real Pino instance through
// the compiled PINO_REDACT_OPTIONS and compare its output against scrub() --
// that is the whole point of the parity test, so it needs no test-specific
// env wiring either.
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
