import { defineConfig } from "vitest/config";
import { AGGREGATE_EXCLUDED_LOAD_TESTS, workerTestBase } from "./vitest.base.config.js";

/**
 * apps/worker's ordinary entrypoint: `npm run test -w apps/worker`, every
 * `npm run failure:*` script EXCEPT `failure:tenant-fairness`, and — through
 * the root aggregate's `projects` list — `npm run coverage` (CI job `test`).
 * `failure:tenant-fairness` is the one exception: it goes through
 * vitest.loadtest.config.ts, because this config is precisely the one that
 * excludes its file.
 *
 * Everything except `exclude` lives in ./vitest.base.config.ts and is shared
 * verbatim with vitest.loadtest.config.ts. See that file for why the split
 * exists and why each excluded path is excluded (debug session
 * `ci-tenant-fairness-double-run`).
 *
 * The exclusion is deliberately set HERE rather than in the root
 * vitest.config.ts: the root lists this file as a project precisely so the
 * project's own settings are inherited, so stating it once here covers both the
 * aggregate and a direct `vitest run --root apps/worker`. Excluding at the root
 * instead would leave the load tests running in the workspace-level run and put
 * the rule somewhere no one editing apps/worker would look.
 */
export default defineConfig({
  test: {
    ...workerTestBase,
    exclude: [...workerTestBase.exclude, ...AGGREGATE_EXCLUDED_LOAD_TESTS],
  },
});
