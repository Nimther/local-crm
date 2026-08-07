import { defineConfig } from "vitest/config";

/**
 * 08-11 (QG-03) — the aggregated backend coverage run.
 *
 * ONE run over every backend project, producing ONE report with ONE
 * denominator. The aggregation shape matters more than the provider does:
 * `packages/kms`, `packages/tenant-context` and `packages/contacts-core` have
 * no tests of their own but are executed constantly by `apps/api`'s and
 * `apps/worker`'s. Merging per-workspace reports would show all three at 0% and
 * drag the threshold down to a number that means nothing (D-16).
 *
 * `apps/web` is deliberately absent. It is outside the coverage scope by
 * decision, and folding a React/jsdom project into a node-environment aggregate
 * would mix two different denominators anyway.
 *
 * Each entry points at the project's own config so its settings are inherited,
 * not restated — in particular `apps/worker`'s `fileParallelism: false`, set in
 * 06-12 because flow-run-advance-integration.test.ts registers a real BullMQ
 * Worker against a globally-shared queue. Losing that flag reintroduces a test
 * that steals sibling files' jobs mid-assertion, and the failures look like
 * flakiness rather than a config regression.
 *
 * 08-11 originally listed `packages/segments-core` and
 * `packages/shared-schemas` as bare directory entries, having verified that
 * Vitest 4.1.9 accepts a directory for a config-less package. That was true of
 * the AGGREGATE and missed the converse: with no local config, `vitest run`
 * inside those packages walks up, finds THIS file, and resolves the paths below
 * relative to itself — producing `packages/segments-core/apps/api/...` and a
 * startup error. 08-13 gave both packages a minimal config, and they are
 * referenced here like every other project.
 *
 * A project whose tests fail, or fail to run, fails the whole aggregated run.
 * That is what stops a workspace from silently dropping out of the denominator
 * (D-17, SPEC R3 concurrency edge).
 */
export default defineConfig({
  test: {
    projects: [
      "apps/api/vitest.config.ts",
      "apps/worker/vitest.config.ts",
      "packages/db/vitest.config.ts",
      "packages/delivery-core/vitest.config.ts",
      "packages/flows-core/vitest.config.ts",
      "packages/test-support/vitest.config.ts",
      "packages/kms/vitest.config.ts",
      "packages/tenant-context/vitest.config.ts",
      "packages/segments-core/vitest.config.ts",
      "packages/shared-schemas/vitest.config.ts",
      "scripts/vitest.config.ts",
    ],
    coverage: {
      provider: "v8",
      // `text` for a human reading CI output; `json-summary` is what 08-14's
      // gate script parses.
      reporter: ["text", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["apps/api/src/**", "apps/worker/src/**", "packages/*/src/**"],
      exclude: [
        "**/__tests__/**",
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/dist/**",
        "**/*.config.*",
        "**/*.d.ts",
        "packages/db/migrations/**",
        "tools/**",
      ],
      // `all` stays at its default, so the denominator is the files actually
      // loaded during the run (D-17). With a single aggregated run that is
      // nearly the whole backend; turning it on would drag in code no test
      // imports at all and make the number describe the wrong thing.
    },
  },
});
