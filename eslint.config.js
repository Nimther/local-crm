// GSD 08-03 (QG-02): the lint gate.
//
// The type-aware tier is the point of this config. A plain `recommended` tier
// would be substantively empty for this codebase — the bug class the audit
// found in the send pipeline and the BullMQ workers is async misuse
// (no-floating-promises, no-misused-promises, await-thenable, require-await),
// and every one of those rules requires type information (D-05).
//
// Escape-hatch policy (D-06): rule-named line-level disables are allowed;
// blanket file-level disables that name no rule are forbidden and are asserted
// against in packages/test-support/src/__tests__/lint-gate.test.ts.

import vitest from "@vitest/eslint-plugin";
import importX from "eslint-plugin-import-x";
import noOnlyTests from "eslint-plugin-no-only-tests";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Block 1 — global ignores. Every entry here shrinks the checked-file count,
  // so each one needs a reason. The count is floored in lint-file-floor.json
  // precisely so an accidental addition here cannot silently empty the gate.
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "**/blob-report/**",
      // Generated SQL, not source.
      "packages/db/migrations/**",
      // Emitted declarations, not source.
      "**/*.d.ts",
      // 08-03 Task 2: deliberate violations. Ignored for the tree-wide
      // `eslint .` run so they cannot permanently block `npm run lint`, but the
      // rules still apply when a fixture is targeted with --no-ignore, which is
      // exactly how the fail-first assertions drive them.
      "tools/lint-fixtures/**",
    ],
  },


  // Block 2 — type-aware tier, scoped to `*/src/**`.
  //
  // The scoping is the deliberate resolution of RESEARCH Pitfall 2: every
  // tsconfig.json in this repo declares `include: ["src"]`, so the TS project
  // service throws a parser error (not a lint violation) outside src/.
  {
    files: ["apps/*/src/**/*.{ts,tsx}", "packages/*/src/**/*.ts"],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Block 3 — everything outside src/: config files and plain Node scripts.
  // Non-type-aware only, for the Pitfall 2 reason above.
  {
    files: [
      "*.config.{ts,js,mjs}",
      "apps/*/*.config.{ts,mjs}",
      "packages/*/*.config.ts",
      "scripts/**/*.mjs",
      "eslint.config.js",
      // Playwright specs are TypeScript but live outside any tsconfig's
      // `include: ["src"]`, so they need the TS parser from this non-type-aware
      // tier. Without this they hit the default parser and fail fatally on the
      // first type annotation ("Unexpected token Page").
      "apps/web/e2e/**/*.spec.ts",
    ],
    extends: [tseslint.configs.recommended],
  },

  // Block 2b — the lint fixtures, checked by the SAME type-aware tier as real
  // source. Without this the fixtures sit outside every `*/src/**` glob and
  // `eslint --no-ignore tools/lint-fixtures/floating-promise.ts` exits 0,
  // proving nothing. `tools/` is outside every tsconfig's `include: ["src"]`,
  // so allowDefaultProject is typescript-eslint's documented escape hatch for
  // exactly this "a few stray files" case (RESEARCH Pitfall 2).
  {
    files: ["tools/lint-fixtures/**/*.ts"],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["tools/lint-fixtures/*.ts"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Block 4 — vitest.
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    plugins: { vitest },
    rules: {
      // fixable:false is load-bearing (D-07): with the default fixable
      // behavior `eslint --fix` silently strips a forgotten .only, erasing the
      // exact evidence this rule exists to surface.
      "vitest/no-focused-tests": ["error", { fixable: false }],
    },
  },

  // Block 4b — the `no-unsafe-*` family, off for test files ONLY (08-07, D-06).
  //
  // Measured at the 08-07 baseline: 243 violations of these five rules, of which
  // 238 are in test files and 5 in source. The 238 have a single root cause that
  // is not a defect in our code — Fastify's `app.inject()` returns a
  // light-my-request Response whose body reader is typed `json: <T = any>() => T`,
  // so every expression derived from a response body is `any` by construction.
  // The rule is reporting the type of a third-party test helper, not a place
  // where this codebase loses type safety in shipped code.
  //
  // Scoped to tests deliberately: in source these rules stay fully on, which is
  // where an `any` crossing a boundary actually matters. The 5 source violations
  // were fixed individually rather than absorbed by this block.
  //
  // NOT disabled here, in tests or anywhere: no-floating-promises,
  // no-misused-promises, await-thenable, require-await. That rule class is the
  // entire reason D-05 chose the type-aware tier, and an un-awaited promise in a
  // test is a test that can pass before its assertions run.
  // See docs/lint-rule-exceptions.md.
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/__tests__/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-call": "off",
    },
  },

  // Block 5 — Playwright specs. @vitest/eslint-plugin's rule is vitest-specific
  // and does not see these files, but a .only here is the same silent-green risk.
  {
    files: ["apps/web/e2e/**/*.spec.ts"],
    plugins: { "no-only-tests": noOnlyTests },
    rules: {
      "no-only-tests/no-only-tests": "error",
    },
  },

  // Block 6 — React.
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      // warn is still blocking under --max-warnings=0 (D-06).
      "react-hooks/exhaustive-deps": "warn",
    },
  },

  // Block 7 — import hygiene. Deliberately ONE rule: the import-ordering rule
  // and the a11y plugin are both outside this phase's boundary (D-07).
  //
  // 08-03 deviation: eslint-plugin-import caps at ESLint ^9 and has no release
  // supporting ESLint 10, so this is the maintained fork eslint-plugin-import-x,
  // which provides the same rule. Recorded in SPECIFICATION.md §2.1/§8.2.
  {
    files: ["apps/*/src/**/*.{ts,tsx}", "packages/*/src/**/*.ts", "scripts/**/*.mjs"],
    plugins: { "import-x": importX },
    rules: {
      "import-x/no-extraneous-dependencies": [
        "error",
        {
          devDependencies: [
            "**/*.test.ts",
            "**/*.test.tsx",
            "**/__tests__/**",
            "**/*.config.*",
            "scripts/**",
            "apps/web/e2e/**",
          ],
        },
      ],
    },
  },
);
