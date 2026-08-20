import { defineConfig } from "vitest/config";
import { workerTestBase } from "./vitest.base.config.js";

/**
 * Debug session `ci-tenant-fairness-double-run` (2026-08-20): the quiet lane
 * for apps/worker's two throughput-RATIO measurements.
 *
 * Identical to vitest.config.ts in every respect except one — it does NOT add
 * `AGGREGATE_EXCLUDED_LOAD_TESTS` to `exclude`, so it is the only entrypoint
 * that can still collect them. Selected explicitly:
 *
 *   npm run failure:tenant-fairness   (CI job `failure-injection`, REQUIRED)
 *   npm run loadtest:tenant-rps       (on-demand only, D-04)
 *
 * both of which pass `--root apps/worker --config vitest.loadtest.config.ts`.
 * `--config` is resolved relative to `--root`, NOT to the working directory:
 * spelling it `apps/worker/vitest.loadtest.config.ts` there resolves to
 * `apps/worker/apps/worker/...` and the run dies. Verified empirically, and the
 * reason both scripts read the way they do.
 *
 * A config split rather than an env-var gate (`RUN_LOAD_TESTS=1`) because this
 * shape has no silent-failure direction. A dropped or misspelled `--config`
 * makes the dedicated job exit 1 with "No test files found" — loud, and on a
 * required status check. A dropped env var would just run zero tests and exit
 * 0, deleting the fairness gate while CI stayed green. It also adds no new
 * environment variable, so there is nothing to register in SPECIFICATION.md §3.
 *
 * scripts/__tests__/aggregate-loadtest-exclusion.test.mjs asserts BOTH halves
 * of the split against `vitest list`'s real collection output: not collected by
 * the aggregate, and STILL collected here. The second half is what stops this
 * fix from ever degrading into a silent gate removal.
 */
export default defineConfig({
  test: {
    ...workerTestBase,
  },
});
