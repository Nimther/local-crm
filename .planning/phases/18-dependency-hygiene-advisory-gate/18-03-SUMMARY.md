---
phase: 18-dependency-hygiene-advisory-gate
plan: 03
subsystem: ci-quality-gates
tags: [dependency-hygiene, npm-audit, npm-upgrade, ci-gate]
status: complete

requires:
  - phase: 18-dependency-hygiene-advisory-gate
    provides: "scripts/check-dependency-advisories.mjs (check:dependency-advisories gate), full accept-list schema validation (18-01/18-02)"
provides:
  - "postcss@8.5.26, react-router@8.3.0 in apps/web/package.json (direct-pin upgrades)"
  - "concurrently@10.0.5 in root package.json devDependencies (direct-pin upgrade)"
  - "brace-expansion@5.0.9, fast-uri@3.1.5, find-my-way@9.8.0 (transitive, via npm audit fix)"
  - "check:dependency-advisories GREEN baseline -- the DEP-02 clean state all later phase-18 gate failures are judged against"
affects: [18-04]

tech-stack:
  added: []
  patterns:
    - "npm install <pkg>@<version> -w <workspace> adds a caret range by default; this repo's convention is exact pins (verified against every neighboring entry in the same package.json blocks), so each caret was tightened back to an exact version before commit"
    - "npm audit fix without --omit=dev and without --force, as RESEARCH.md Pitfall 1 and this plan's threat model both require -- confirmed empirically to remove zero packages"

key-files:
  created: []
  modified:
    - package.json (concurrently 10.0.3 -> 10.0.5)
    - apps/web/package.json (postcss 8.5.16 -> 8.5.26, react-router 8.1.0 -> 8.3.0)
    - package-lock.json (direct-pin resolution + npm audit fix + two npm-10 regenerations)
    - SPECIFICATION.md (section 2: three direct-pin version cells + new section 2.8 for the transitive set; section 8: mirrored divergence-table version cells)

key-decisions:
  - "Committed in four small commits instead of one, per this attempt's retry_context: direct-pin bumps first (crash-safe checkpoint), then npm audit fix, then the npm-10 lockfile regeneration the first two steps required, then the SPECIFICATION.md filing -- rather than the plan's nominal one-task-one-commit shape. All four commits are Task 1's work except the last (Task 2)."
  - "A large (691-line) lockfile diff appeared after the direct-pin install alone, before npm audit fix ran. Investigated line by line: it was npm deduplicating nested duplicate copies (a second, older esbuild/@vitest-mocker/nanoid resolution tree) into the existing top-level copies once the postcss/react-router/concurrently version bumps changed the dependency graph enough to permit it -- not a real package removal. This dedup is what silently fixed nanoid's two HIGH advisories: the vulnerable nested nanoid@3.3.15 copy was deduped away in favor of the tree's pre-existing safe nanoid@5.1.16, with no npm-audit-fix action needed for it."
  - "The npm-10 lockfile regeneration ran TWICE in this plan (once after the direct-pin commit, once after the npm-audit-fix commit) because each step's own dedup independently dropped optional cross-platform esbuild packages that npm 10's `ci --dry-run` still expects listed. Each regeneration used the plan's prescribed command verbatim and was confirmed additive-only before committing."
  - "npm ls --all --omit=dev | grep -c UNMET is 162, not the plan's literal acceptance-criterion value of 0. Investigated: all 162 are 'UNMET OPTIONAL DEPENDENCY' (cross-platform esbuild binaries for platforms other than this dev machine's, and optional peer adapters for frameworks this project does not use -- Prisma, SvelteKit, etc., pulled in transitively by better-auth's optional integrations). `grep 'UNMET' | grep -v OPTIONAL` is 0 -- zero required/non-optional unmet dependencies. Treated the acceptance criterion's intent (no broken required dependency) as satisfied and the literal grep count as over-broad; recorded here rather than silently overridden."

requirements-completed: [DEP-01]

coverage:
  - id: T1-postcss
    description: "postcss bumped 8.5.16 -> 8.5.26 in apps/web, closing HIGH advisory GHSA-r28c-9q8g-f849"
    requirement: DEP-01
    verification:
      - kind: integration
        ref: "node -e check on apps/web/package.json (plan Task 1 acceptance criterion), re-run at plan end"
        status: pass
    human_judgment: false
  - id: T2-react-router
    description: "react-router bumped 8.1.0 -> 8.3.0 in apps/web, closing HIGH advisory GHSA-qwww-vcr4-c8h2"
    requirement: DEP-01
    verification:
      - kind: integration
        ref: "node -e check on apps/web/package.json (plan Task 1 acceptance criterion), re-run at plan end"
        status: pass
    human_judgment: false
  - id: T3-concurrently
    description: "concurrently bumped 10.0.3 -> 10.0.5 at repo root, the only fix path for HIGH advisory GHSA-395f-4hp3-45gv on nested shell-quote"
    requirement: DEP-01
    verification:
      - kind: integration
        ref: "node -e check on package.json (plan Task 1 acceptance criterion), re-run at plan end"
        status: pass
    human_judgment: false
  - id: T4-transitive
    description: "npm audit fix (no --omit=dev, no --force) bumped brace-expansion, fast-uri, find-my-way, removing zero packages; nanoid's advisories resolved as a side effect of the direct-pin dedup"
    requirement: DEP-01
    verification:
      - kind: integration
        ref: "git diff package-lock.json inspected for removed node_modules/ entries after each step (zero found)"
        status: pass
    human_judgment: false
  - id: T5-gate-green
    description: "check:dependency-advisories exits 0 with 0 blocking findings; raw npm audit reports 0 high / 0 critical across the full tree"
    requirement: DEP-01
    verification:
      - kind: integration
        ref: "npm run check:dependency-advisories; npm audit --json metadata check (plan's own acceptance criteria commands)"
        status: pass
    human_judgment: false
  - id: T6-drizzle-kit-unchanged
    description: "drizzle-kit stays at 0.31.10 (not forced to 0.18.1) -- npm audit fix's --force path was never invoked"
    requirement: DEP-01
    verification:
      - kind: integration
        ref: "npm ls drizzle-kit --json before and after, recursive walk confirming the single resolved version"
        status: pass
    human_judgment: false
  - id: T7-downstream-gates
    description: "check:lockfile-npm10, workspace build, whole-repo lint, and check:web-chunks all pass against the upgraded tree"
    requirement: DEP-01
    verification:
      - kind: integration
        ref: "bash -c 'set -e; npm run check:dependency-advisories; npm run check:lockfile-npm10; npm run build --workspaces --if-present; npm run lint; npm run check:web-chunks; echo UPGRADE-GREEN-OK' (plan Task 1's own <verify> block, re-run at plan end)"
        status: pass
    human_judgment: false
  - id: T8-coverage-no-new-failures
    description: "npm run coverage introduces no new failure signature vs. the two documented pre-existing environmental failures"
    requirement: DEP-01
    verification:
      - kind: integration
        ref: "two full foreground npm run coverage runs -- see Coverage Baseline section below"
        status: pass
    human_judgment: false
  - id: T9-spec-filed
    description: "SPECIFICATION.md sections 2 and 8 both state the installed versions, in the same change"
    requirement: DEP-01
    verification:
      - kind: integration
        ref: "plan Task 2's own <verify> command (version-count grep + check:spec-env-coverage), re-run at commit time"
        status: pass
    human_judgment: false

duration: ~50min
completed: 2026-08-20
---

# Phase 18 Plan 03: Dependency Upgrade to GREEN Gate Summary

**Turned the phase-18 advisory gate from RED (9 blocking HIGH findings across 7 packages) to GREEN (0 blocking findings) purely through upgrades: three direct-pin bumps (postcss, react-router, concurrently) plus a plain `npm audit fix` for three transitive packages, with `nanoid`'s two advisories resolved as an unplanned side effect of npm's dependency-graph dedup; filed every version into SPECIFICATION.md in the same change.**

## Performance

- **Duration:** ~50 min
- **Tasks:** 2/2
- **Files modified:** 4 (`package.json`, `apps/web/package.json`, `package-lock.json`, `SPECIFICATION.md`)

## Before / After

### `check:dependency-advisories` gate

- **Before (phase-start baseline, confirmed live at this plan's start):** `FAILED: 9 blocking advisory finding(s)` across `brace-expansion`, `fast-uri` (x2), `find-my-way`, `nanoid` (x2), `postcss`, `react-router`, `shell-quote`.
- **After:** `check:dependency-advisories -- 1 advisory examined, 0 accept-list entries applied, 0 blocking finding(s).` (the "1 advisory" is the moderate drizzle-kit/@esbuild-kit/esbuild chain, correctly non-blocking).

### Raw `npm audit --json` metadata

| | high | critical | moderate | total |
|---|---|---|---|---|
| Before | 8 | 0 | 4 | 12 |
| After | 0 | 0 | 4 | 4 |

### `drizzle-kit` installed version (must be unchanged, and not 0.18.1)

- **Before:** `0.31.10`
- **After:** `0.31.10` (unchanged; confirmed via a recursive `npm ls --json` walk finding exactly one version string in the whole tree)

### Every changed package's resolved version

| Package | Before | After | Fix path |
|---|---|---|---|
| `postcss` (apps/web) | `8.5.16` | `8.5.26` | direct pin (`npm install postcss@8.5.26 -w apps/web`) |
| `react-router` (apps/web) | `8.1.0` | `8.3.0` | direct pin (`npm install react-router@8.3.0 -w apps/web`) |
| `concurrently` (root) | `10.0.3` | `10.0.5` | direct pin (`npm install concurrently@10.0.5`) |
| `brace-expansion` | `5.0.8` | `5.0.9` | transitive, `npm audit fix` |
| `fast-uri` | `3.1.3` | `3.1.5` | transitive, `npm audit fix` |
| `find-my-way` | `9.6.0` | `9.8.0` | transitive, `npm audit fix` |
| `nanoid` | (vulnerable nested `3.3.15` copy present) | `5.1.16` only | dedup side effect of the direct-pin install, before `npm audit fix` ran |

`npm install <pkg>@<version> -w <workspace>` writes a caret range (`^x.y.z`) by default. Every neighboring entry in the touched `package.json` blocks uses exact pins (no caret), so all three were tightened back to exact versions (`8.5.26`, `8.3.0`, `10.0.5`) before commit, matching the repo's existing convention and the plan's own acceptance-criterion string-equality checks.

## Task Commits

Committed as four small commits rather than one, per this attempt's `retry_context` instruction to commit as soon as each coherent step lands (a prior attempt lost all work to a killed background process):

1. **Task 1, step A — direct pins** — `d9bbebc` (fix) — `postcss`/`react-router` in `apps/web/package.json`, `concurrently` at root, plus the resulting `package-lock.json` dedup (which also silently closed both `nanoid` advisories).
2. **Task 1, step B — transitive fix** — `de81e9a` (fix) — plain `npm audit fix`, zero packages removed, `brace-expansion`/`fast-uri`/`find-my-way` bumped.
3. **Task 1, step E — npm-10 lockfile regeneration** — `5ccd52d` (fix) — `npx --yes npm@10 install --package-lock-only --ignore-scripts`, additive-only, restoring the optional cross-platform esbuild entries npm 10's `ci --dry-run` expects.
4. **Task 2 — SPECIFICATION.md filing** — `efb09eb` (docs) — sections 2 and 8 updated with all six version changes.

## Deviations from Plan

### Auto-fixed Issues (Rule 3 — blocking issue)

**1. [Rule 3] `check:lockfile-npm10` failed twice, once after each dedup step, requiring the plan's own prescribed regeneration**
- **Found during:** Task 1, step E (both after the direct-pin commit and again after the audit-fix commit)
- **Issue:** npm's dependency-graph dedup (triggered by both the direct-pin bumps and by `npm audit fix`) each independently dropped several optional cross-platform `@esbuild/*` packages from `package-lock.json` that npm 10 (the version pinned in `docker/Dockerfile.{api,worker,web}`'s `node:22-slim` base image) still expects listed for its `npm ci --dry-run` compatibility check, even though they are never installed on this arm64 macOS dev machine.
- **Fix:** ran the exact remediation command the guard's own failure report prints: `npx --yes npm@10 install --package-lock-only --ignore-scripts`. Confirmed additive-only both times (the only line-level diff besides new additions was a single `@vitest/mocker` entry's dependents block being repositioned in the JSON, not removed) before committing.
- **Files modified:** `package-lock.json`
- **Commit:** `5ccd52d` (the two regenerations landed in this one commit, since the second regen happened before the audit-fix step's own commit had been finalized in the working tree)

### Investigated, not a deviation — large lockfile diff after the direct-pin install

The direct-pin commit's `package-lock.json` diff was 691 lines before `npm audit fix` even ran. Traced line by line: every removed `resolved`/`version` entry corresponded to a nested duplicate copy of an already-present top-level package (esbuild platform binaries, `@vitest/mocker`, `nanoid@3.3.15`) that npm deduplicated once the version bumps changed the graph enough to allow a single shared copy. Confirmed zero actual package removals via `git diff package-lock.json | grep -E '^-  "node_modules/'` (empty) both after this step and after the subsequent `npm audit fix` step. This is the mechanism that closed `nanoid`'s two HIGH advisories without any `npm audit fix` action on `nanoid` itself — its vulnerable nested `3.3.15` copy was the one deduped away, in favor of the tree's pre-existing safe `nanoid@5.1.16` (already used by `apps/api`'s `tenancy/workspaces.ts`, per SPECIFICATION.md §2.2).

### `npm ls --all --omit=dev | grep -c UNMET` is 162, not the plan's literal `0`

Investigated: `grep 'UNMET' | grep -v OPTIONAL` is `0` -- all 162 matches are `UNMET OPTIONAL DEPENDENCY` lines for cross-platform esbuild binaries (Windows/Linux/BSD variants irrelevant on this arm64 macOS machine) and optional peer adapters for frameworks this project does not use (Prisma, SvelteKit, TanStack Start, etc. -- pulled in transitively as `better-auth`'s optional integration surface). Zero required/non-optional dependencies are unmet. Treated the acceptance criterion's evident intent (no broken required dependency introduced by this plan) as satisfied; the literal `grep -c UNMET` count without excluding `OPTIONAL` over-counts pre-existing, expected cross-platform noise unrelated to this plan's changes.

## Coverage Baseline (pre-upgrade vs. post-upgrade)

No pre-upgrade coverage baseline exists from a prior attempt (the retry_context records the previous attempt was lost with zero commits before any test run completed). Ran the full-suite `npm run coverage` twice, foreground, against the fully upgraded tree, to distinguish deterministic regressions from full-suite-load flakes:

**Run 1:** 3 test files failed, 254 passed, 1 skipped (258 total); 3 tests failed, 2216 passed, 2 skipped (2221 total).
- `apps/worker src/__tests__/sentry.test.ts` — "with no DSN configured, does not throw and leaves the SDK uninitialized" — **known pre-existing environmental failure** (real Sentry DSNs present in this machine's external env file since 2026-08-16 UAT, per project memory).
- `apps/api src/__tests__/sentry.test.ts` — same test name, same cause — **known pre-existing environmental failure**.
- `apps/api src/modules/ops/__tests__/failed-send-share-watchdog.test.ts` — "test 11: readSendStatusCountsSince..." delta-count assertion — **new signature, investigated**.

**Investigation of the watchdog test:** re-ran `npx vitest run src/modules/ops/__tests__/failed-send-share-watchdog.test.ts` in isolation inside `apps/api` — **14/14 passed**, confirming it is not broken by any change this plan made. Re-ran the full `npm run coverage` suite a second time to check for non-determinism.

**Run 2:** 2 test files failed, 255 passed, 1 skipped (258 total); 2 tests failed, 2217 passed, 2 skipped (2221 total).
- Only the two known pre-existing `sentry.test.ts` "no DSN" failures remained. The watchdog test passed this time, confirming Run 1's failure was a full-suite-load flake (contended ephemeral-DB count assertion, consistent with the documented project-memory pattern of full-suite-load test contamination), not a dependency-upgrade regression.

**Conclusion:** across both runs, the only test failures observed are the two documented pre-existing/environmental `sentry.test.ts` "no DSN" cases. No new, reproducible failure signature was introduced by this plan's dependency upgrades. Per the prompt's explicit instruction, the suite is treated as passing.

## Files Created/Modified

- `package.json` — `concurrently` `10.0.3` -> `10.0.5`
- `apps/web/package.json` — `postcss` `8.5.16` -> `8.5.26`, `react-router` `8.1.0` -> `8.3.0`
- `package-lock.json` — all direct-pin and transitive resolution changes, twice regenerated under npm 10 for Docker compatibility
- `SPECIFICATION.md` — section 2 (three version-cell updates in §2.1/§2.4, new §2.8 documenting the transitive bumps and the nanoid dedup side effect) and section 8 (mirrored the three direct-pin version cells in the divergence table); sections 3, 6, 7 untouched

## Threat Flags

None. This plan's own `<threat_model>` (T-18-SC, T-18-11, T-18-12, T-18-13, T-18-14) is the exhaustive register for this change, and every mitigation named there was applied and verified: zero new packages introduced (T-18-SC), `--force` never invoked and `drizzle-kit` confirmed unchanged (T-18-11), full build/lint/test/chunk-boundary re-verification (T-18-12), `check:lockfile-npm10` re-run and regenerated twice as needed (T-18-13), and the gate reached green exclusively through actual upgrades — no threshold, scope, or accept-list weakening (T-18-14, confirmed by the unmodified `.advisory-accept-list.json` and the raw `npm audit` high/critical-count-is-zero acceptance criterion).

## Known Stubs

None.

## Auth Gates

None encountered.

## Self-Check: PASSED

- `package.json` (`concurrently: "10.0.5"`) — FOUND
- `apps/web/package.json` (`postcss: "8.5.26"`, `react-router: "8.3.0"`) — FOUND
- `SPECIFICATION.md` sections 2 and 8 updated — FOUND
- Commit `d9bbebc` — FOUND
- Commit `de81e9a` — FOUND
- Commit `5ccd52d` — FOUND
- Commit `efb09eb` — FOUND

---
*Phase: 18-dependency-hygiene-advisory-gate*
*Completed: 2026-08-20*
