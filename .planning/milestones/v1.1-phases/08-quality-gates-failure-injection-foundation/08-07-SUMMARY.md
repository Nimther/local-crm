---
phase: 08-quality-gates-failure-injection-foundation
plan: 07
subsystem: testing
tags: [eslint, typescript-eslint, lint, async, promises, react-hook-form, react-router, vitest]

requires:
  - phase: 08-03
    provides: the ESLint 10 flat config, the type-aware tier, the lint file-count floor, and the blanket-disable scan
provides:
  - Zero lint violations repo-wide; `npm run lint` can be made a blocking gate without a permanent red
  - docs/lint-rule-exceptions.md — the register of rules disabled repo-wide, with counts and reasons
  - A rule-level exception scoping no-unsafe-* to source only, and a no-unused-vars option honouring the underscore convention
  - TEST_ADMIN_DATABASE_URL wired so the full workspace suite runs locally
affects: [08-18, 08-11, 08-14]

tech-stack:
  added: [vitest@4.1.9 declared in apps/web]
  patterns:
    - "Rule-level exceptions are scoped, never global: no-unsafe-* is off in tests and on in source, because the two cases differ in kind"
    - "`void` marks a deliberately unobserved promise; line-scoped directives carry `-- reason` and never appear at file level"

key-files:
  created:
    - docs/lint-rule-exceptions.md
  modified:
    - eslint.config.js
    - packages/test-support/vitest.config.ts
    - packages/kms/src/env.ts
    - packages/delivery-core/src/send-status.ts
    - apps/web/package.json
    - SPECIFICATION.md

key-decisions:
  - "no-unsafe-* turned off for test files only. 238 of 243 violations came from one third-party signature — light-my-request types inject().json() as `<T = any>() => T` — so the rule was reporting the harness's typing, not lost safety in shipped code. Source keeps the rule; the 5 source violations were fixed individually"
  - "The four type-aware async rules were not excepted, per plan. All 87 sites resolved individually: 36 line-scoped directives with reasons on contract-fixed signatures, the rest fixed"
  - "res.json() as T became res.json<T>() rather than deleting the assertion — the same zero, but the value stays typed"
  - "no-unused-vars configured to honour the leading-underscore convention rather than suppressing per site. A rule option, not an exception, so it lives at the config and not in the register"

patterns-established:
  - "Exception register (docs/lint-rule-exceptions.md) records what IS disabled; the prohibition on excepting the async class lives in the config comment where an editor will meet it"
  - "Every rule-level exception carries its violation count at the time of the decision, so a reviewer can ask whether it still holds"

requirements-completed: [QG-02]

coverage:
  - id: D1
    description: "`npm run lint` exits 0 across the whole repository at --max-warnings=0"
    requirement: QG-02
    verification:
      - kind: automated_ui
        ref: "npm run lint — exit 0"
        status: pass
      - kind: automated_ui
        ref: "npx eslint . --format json — 403 files, 0 violations"
        status: pass
    human_judgment: false
  - id: D2
    description: "The zero was not reached by shrinking the checked set — file count held above the recorded floor and above 08-03's measurement"
    requirement: QG-02
    verification:
      - kind: automated_ui
        ref: "node scripts/check-lint-file-floor.mjs — 403 checked, floor 390, 08-03 measured 396"
        status: pass
      - kind: automated_ui
        ref: "git diff eslint.config.js — no addition inside the global ignores block"
        status: pass
    human_judgment: false
  - id: D3
    description: "No behaviour regression from the cleanup — full workspace suite unchanged"
    requirement: QG-02
    verification:
      - kind: integration
        ref: "npm run test --workspaces --if-present — 97 files, 588 tests, exit 0; diff against the pre-change baseline is empty"
        status: pass
    human_judgment: false
  - id: D4
    description: "No file-level blanket suppression, and every line-scoped directive added names a rule and gives a reason"
    requirement: QG-02
    verification:
      - kind: unit
        ref: "packages/test-support/src/__tests__/lint-gate.test.ts — 9 tests"
        status: pass
      - kind: manual_procedural
        ref: "grep of eslint-disable-next-line across apps/packages/scripts — 36 added by this plan, all with `-- reason`"
        status: pass
    human_judgment: false
  - id: D5
    description: "docs/lint-rule-exceptions.md registers every repo-wide disable with its count and reason, and none is an async type-aware rule"
    requirement: QG-02
    verification:
      - kind: manual_procedural
        ref: "grep -cE 'no-floating-promises|no-misused-promises|await-thenable|require-await' docs/lint-rule-exceptions.md — 0"
        status: pass
    human_judgment: true
    rationale: "Whether each written reason actually justifies its exception is a review judgment; the grep only proves the async class was not among them."
  - id: D6
    description: "Four latent defects the type-aware tier surfaced were fixed rather than suppressed"
    verification:
      - kind: integration
        ref: "npm run test --workspaces — suites green after each fix; monorepo typecheck clean"
        status: pass
    human_judgment: true
    rationale: "The memoization and String(unknown) fixes change rendering behaviour in ways the existing suite does not assert; a human should confirm the contacts list and segment summary still read correctly."

duration: 63 min
completed: 2026-07-28
status: complete
---

# Phase 8 Plan 07: Lint Debt to Zero Summary

**525 violations to zero across 403 files, with the type-aware async rule class untouched and the full test suite byte-identical — plus four latent defects the tier surfaced along the way.**

## Performance

- **Duration:** 63 min
- **Started:** 2026-07-28T07:27:00Z
- **Completed:** 2026-07-28T08:30:00Z
- **Tasks:** 3
- **Files modified:** 127

## The burn-down

Baseline, measured before any change: **403 files checked, 525 violations** (511 error / 14 warning).

| Rule | Total | test | src | Disposition |
|------|------:|-----:|----:|-------------|
| `no-unsafe-member-access` | 160 | 160 | 0 | rule off in tests |
| `no-unnecessary-type-assertion` | 152 | 146 | 6 | fixed (`res.json<T>()`) |
| `no-unsafe-assignment` | 47 | 44 | 3 | off in tests; 3 fixed |
| `require-await` | 36 | 15 | 21 | 35 directives + 1 fixed |
| `no-misused-promises` | 35 | 2 | 33 | fixed |
| `no-unsafe-argument` | 23 | 22 | 1 | off in tests; 1 fixed |
| `no-floating-promises` | 16 | 0 | 16 | fixed (`void`) |
| dead `eslint-disable` directives | 13 | 0 | 13 | removed |
| `no-unsafe-return` | 11 | 10 | 1 | off in tests; 1 fixed |
| `import-x/no-extraneous-dependencies` | 9 | 6 | 3 | vitest declared; allowlist widened |
| `no-redundant-type-constituents` | 7 | 0 | 7 | fixed |
| `no-unused-vars` | 5 | 1 | 4 | fixed + rule option |
| `no-explicit-any` | 4 | 4 | 0 | fixed |
| `no-base-to-string` | 3 | 1 | 2 | fixed |
| `no-unsafe-call` | 2 | 2 | 0 | rule off in tests |
| `react-hooks/exhaustive-deps` | 1 | 0 | 1 | fixed |
| `unbound-method` | 1 | 1 | 0 | directive |

**Final: 403 files, 0 violations.** Floor 390; 08-03 measured 396. The count went *up*, not down — nothing was hidden by widening `ignores`, which was never touched.

## Accomplishments

- **`npm run lint` is green repo-wide at `--max-warnings=0`.** The gate can be made blocking in 08-18 without shipping a permanent red.
- **One rule-level exception, scoped and written down.** 243 `no-unsafe-*` violations split 238 test / 5 source — a split that clean is itself the finding. The cause is a single third-party signature: `light-my-request` types its body reader `json: <T = any>() => T`, so every expression derived from an `app.inject()` response is `any` by construction. Turned off in test files only; source keeps the rule, and its 5 violations were fixed individually.
- **The async rule class was never excepted.** All 87 sites resolved one at a time: 35 line-scoped directives on signatures fixed by a contract (Fastify plugins registered via `app.register()`, test doubles at the `ProcessSendJobDeps` and `fetch` seams, `withTenantTransaction`'s callback, the worker's composition root), and everything else fixed.
- **The full workspace suite is byte-identical to the pre-change baseline** — 97 files, 588 tests, exit 0 — which is the check that matters, because adding an `await` is exactly the change lint cannot see going wrong.

### Four latent defects, not lint ceremony

1. **Every route change in the frontend was an unhandled promise.** React Router v7's `navigate()` returns `Promise<void>`; 16 call sites invoked it as a bare statement and 18 more returned it into a void handler slot.
2. **`packages/kms` — the KMS provider selector was one edit from becoming `string`.** `no-unnecessary-type-assertion` correctly reported `as "local" | "aws"` as redundant *for the expression*, but removing it widened the **property** to `string`. The repo still typechecked, because the only consumer is an `===` comparison. Caught by probing the inferred type after the fixer ran; fixed with a declared `KmsEnv` interface.
3. **`delivery-core` — `CurrentStatus` was exactly `string`.** The union ended in `| string`, which absorbed all seven literals, so a type that looked like a closed set offered no safety at all. Now `(string & {})`.
4. **`ContactsListPage` memoized nothing.** `items` was rebuilt with `?? []` every render, so the `availableTags` `useMemo` keyed on it recomputed every render.

Plus: `String()` over `unknown` in two user-facing renderers (segment condition values and the JSONB timeline detail bag) that would print `[object Object]`; a `Request` stringified via `toString()` in a fetch stub; and `apps/web` running `vitest run` while declaring no test tooling at all, working purely on hoisting from the root.

## Task Commits

1. **Task 1: triage + rule-level exception + register** — `27d7cc6` (feat)
2. **Task 1 (cont.): typed inject() bodies** — `15e654c` (fix)
3. **Blocker removal: TEST_ADMIN_DATABASE_URL** — `29899c5` (fix)
4. **Task 2: require-await + dead directives** — `60d14c9` (fix)
5. **Task 2: backend to zero** — `c98a2fe` (fix)
6. **Task 3: apps/web to zero** — `fb10e36` (fix)

## Files Created/Modified

- `docs/lint-rule-exceptions.md` — the register: what is disabled, where, how many violations prompted it, and why
- `eslint.config.js` — Block 4b (`no-unsafe-*` off in tests), the `no-unused-vars` underscore option, `**/src/test/**` in the import-x devDependencies allowlist
- `packages/test-support/vitest.config.ts` — loads the repo-root `.env` so the admin DSN override has somewhere to be set
- `packages/kms/src/env.ts` — `KmsEnv` interface replacing the inline assertion
- `packages/delivery-core/src/send-status.ts` — `CurrentStatus` as `(string & {})`
- `apps/web/package.json` + `package-lock.json` — `vitest` declared where it is used
- `SPECIFICATION.md` — §1.3 admin-DSN divergence, §3.2 `TEST_ADMIN_DATABASE_URL` / `TEST_APP_DB_PASSWORD`
- 118 source files across `apps/api`, `apps/worker`, `apps/web`, `packages/*`

## Decisions Made

- **Scoped exception over global.** `no-unsafe-*` behaves differently in tests than in source, so the exception says so rather than turning the rules off everywhere.
- **`res.json<T>()` over deleting the assertion.** Both reach zero for that rule; only one keeps the value typed.
- **The prohibition on excepting the async rules lives in the config comment, not the register.** The register is a list of what IS disabled; a reader meets the prohibition where they would try to violate it.
- **`no-unused-vars` got a rule option, not a suppression.** The codebase already writes `_omitted`; the config now recognizes the convention instead of demanding a comment per site.

## Deviations from Plan

### 1. [Rule 3 — Blocker, user-approved] Task 2's acceptance criterion was unrunnable locally

- **Found during:** establishing the verification baseline, before any cleanup.
- **Issue:** Task 2 requires `npm run test --workspaces` to prove no behaviour regression. Two `packages/test-support` files failed locally with `role "postgres" does not exist` — `provision-db.ts`'s admin DSN defaults to the `postgres` superuser, which the compose `db` service has and a Homebrew install does not (the 08-01 divergence). Confirmed pre-existing by running them in a clean worktree at `b99719e`.
- **Resolution:** No code change was needed — `resolveAdminDsn` has read `TEST_ADMIN_DATABASE_URL` since 08-02; the variable simply had nowhere to be set, because this workspace's vitest config deliberately did not load the repo-root `.env`. That decision was right when made (the workspace held only pure tests) but 08-02 and 08-06 added two that open connections. The config now loads `.env` optionally, in the same try/catch shape `apps/worker` uses. User supplied the local value.
- **Effect:** the full workspace suite runs locally for the first time — 97 files, 588 tests — which is what made a real before/after comparison possible for this plan and unblocks the rest of the phase.
- **Committed in:** `29899c5`

### 2. [Rule 1 — Bug] `eslint --fix` produced code that does not compile

- **Found during:** Task 1, acting on the triage.
- **Issue:** ESLint reported all 152 `no-unnecessary-type-assertion` violations as auto-fixable. Its output deletes ` as T`; the expression falls back to `any`, and every downstream callback parameter loses its type — 20+ `TS7006` errors under `noImplicitAny`, in a tree that typechecked cleanly before.
- **Fix:** reverted the whole `--fix` and transformed 139 `res.json() as T` sites to `res.json<T>()` instead, using the fixer's own ranges to locate them precisely. Same zero for that rule, value stays typed.
- **Verification:** 0 TS errors before and after; the remaining 13 assertions were other patterns and were reviewed individually.
- **Committed in:** `15e654c`

### 3. [Rule 1 — Bug] A correct lint report, acted on naively, would have silently widened a security-relevant type

- **Found during:** Task 2.
- **Issue:** see Accomplishments item 2 — removing the `as "local" | "aws"` from `packages/kms/src/env.ts` widened `KMS_PROVIDER` to `string` while the repo continued to typecheck.
- **Fix:** declared a `KmsEnv` interface. Verified by compiling a probe that assigns `env.KMS_PROVIDER` to `"local" | "aws"` — it fails against the widened form and passes against the fixed one.
- **Committed in:** `c98a2fe`

### 4. [Rule 2 — Missing Critical] `apps/web` declared no test tooling

- **Found during:** Task 3, from `import-x/no-extraneous-dependencies`.
- **Issue:** `apps/web/package.json` lists neither `vitest` nor any test dependency, yet its `test` script is `vitest run` and it has 6 test files. It worked only because the root hoists `vitest` into the shared `node_modules`.
- **Fix:** declared `vitest@4.1.9`, matching every other workspace. `package-lock.json` updated with `--package-lock-only`; nothing new was downloaded.
- **Committed in:** `fb10e36`

---

**Total deviations:** 1 blocker (escalated, user-approved), 3 auto-fixed.
**Impact on plan:** No scope reduction. One file beyond `files_modified` (`packages/test-support/vitest.config.ts`) and one manifest (`apps/web/package.json`), both required to satisfy the plan's own acceptance criteria.

## Issues Encountered

- **Four pre-existing line-scoped directives carry a rule name but no reason** — `apps/web/.../SendLogPage.tsx:146`, `CampaignProgress.tsx:42`, `FlowCanvas.tsx:168` (all `react-hooks/exhaustive-deps`) and `apps/api/.../events-api.test.ts:194` (`no-explicit-any`). They date from 02-06, 04-08, 06-11 and 07-05. D-06's policy wants a reason on each, but writing one requires understanding why each dependency was omitted, and a fabricated reason is worse than none. Left as-is and flagged: they are outside this plan's scope and no automated check fails on them.
- The base ESLint recommended set (`no-console`, `no-constant-condition`, `no-empty`, …) is never extended by `eslint.config.js` — only `typescript-eslint`'s tiers are. That is what made 13 disable directives dead. Whether those rules *should* be on is 08-03's design question, not this plan's; noted so it is a decision rather than an oversight.

## User Setup Required

`TEST_ADMIN_DATABASE_URL` must be set in the repo-root `.env` for the full suite to run locally — added during this plan. It is not needed in CI, where the compose `db` service provides the `postgres` role. `.env.example` still lacks the line (the environment files are outside this agent's write access); adding it there with a short comment is a small follow-up.

## Next Phase Readiness

- **08-18 can register `lint` as a blocking required status check.** That was the whole point: a gate that is red on `master` from day one is a gate everyone learns to ignore.
- **The full local suite is a usable baseline now** (97 files, 588 tests), which every remaining plan in this phase benefits from — particularly 08-11 (coverage baseline) and 08-14 (coverage gate), which need a complete run to measure anything meaningful.
- **The lint file floor should be re-measured** once 08-08 through 08-16 add their files; 403 against a floor of 390 leaves little headroom in the wrong direction only, so no action is required, but 08-18 is the natural place to refresh `lint-file-floor.json`.

---
*Phase: 08-quality-gates-failure-injection-foundation*
*Completed: 2026-07-28*
