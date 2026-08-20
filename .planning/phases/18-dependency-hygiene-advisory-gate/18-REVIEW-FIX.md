---
phase: 18-dependency-hygiene-advisory-gate
fixed_at: 2026-08-20T16:35:32Z
review_path: .planning/phases/18-dependency-hygiene-advisory-gate/18-REVIEW.md
iteration: 1
findings_in_scope: 3
fixed: 3
skipped: 0
status: all_fixed
---

# Phase 18: Code Review Fix Report

**Fixed at:** 2026-08-20T16:35:32Z
**Source review:** .planning/phases/18-dependency-hygiene-advisory-gate/18-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope (critical + warning): 3
- Fixed: 3
- Skipped: 0

## Fixed Issues

### CR-01: `selectBlockingFindings` expires accept-list entries a full day before `validateAcceptListEntry` says they lapse

**Status:** fixed — requires human verification (logic-correctness fix; see note below)
**Files modified:** `scripts/check-dependency-advisories.mjs`, `scripts/__tests__/check-dependency-advisories.test.mjs`
**Commit:** 86b38ad
**Applied fix:** Extracted shared `parseExpiryUtcDayMs`/`toUtcDayMs` helpers and rewired `selectBlockingFindings` to use the same UTC-day-inclusive expiry comparison `validateAcceptListEntry` already used, so the two functions can no longer disagree on the expiry boundary. The secondary defect (an unparseable `expiry` previously defaulting to "covers forever") is also fixed -- it now fails closed ("does not cover"), matching `validateAcceptListEntry`'s rejection of the same malformed entry. `selectBlockingFindings`'s JSDoc was rewritten to describe the corrected UTC-day-inclusive contract instead of the old (buggy) millisecond-precision description. Added four regression tests pinned to non-midnight UTC `now` values (noon, 23:59:59 on the expiry day, and the day after) plus one for the unparseable-expiry fail-closed path -- the exact scenario the prior all-midnight test fixture could not exercise.

**Verification:** 79→82 (after WR-01)→91 (after WR-02, unchanged) tests pass in `__tests__/check-dependency-advisories.test.mjs`; `node -c` syntax check clean; `npm run check:dependency-advisories` exits 0 against the current tree both before and after the fix.

**Note:** REVIEW.md classifies this as a logic-correctness fix (a date-comparison boundary condition), not a pure syntax change. Per the fixer's verification charter, this is flagged `fixed: requires human verification` despite passing tests -- a human should confirm the UTC-day-inclusive semantics genuinely match the intended D-05 contract (entry valid through end of expiry day, inclusive) by inspection, not only by the passing regression suite.

### WR-01: `BLOCKING_SEVERITIES.has(a.severity)` has no normalization

**Files modified:** `scripts/check-dependency-advisories.mjs`, `scripts/__tests__/check-dependency-advisories.test.mjs`
**Commit:** a4a3148
**Applied fix:** Added a `normalizedSeverity(value)` helper (lower-cases strings, returns `""` for non-string values) and applied it to the `BLOCKING_SEVERITIES.has(...)` lookup in `selectBlockingFindings`, so a differently-cased (`"High"`, `"CRITICAL"`) or non-string severity value can no longer silently fall through to "non-blocking". Added regression tests for cased and non-string severity values.

**Verification:** 82 tests pass; `node -c` syntax check clean; live gate still exits 0.

### WR-02: The captured "advisory gate findings" issue body can silently diverge from the actual failing gate run

**Files modified:** `.github/workflows/advisory-scan.yml`, `.github/workflows/ci.yml`, `SPECIFICATION.md`
**Commit:** c42decb
**Applied fix:** Removed the second, re-run invocation of `npm run check:dependency-advisories` entirely. The gate step's own output is now captured once via `2>&1 | tee /tmp/advisory-gate-output.txt` with an explicit `shell: bash` (for pipefail, so a failing gate piped into `tee` still fails the step -- same precedent already documented at `ci.yml`'s E2E step). Because the drift test (`scripts/__tests__/advisory-scan-workflow.test.mjs`) requires this gate step's `run:` line to stay byte-identical between `advisory-scan.yml` and `ci.yml`, **`ci.yml`'s equivalent step was changed in lockstep** with the same tee + `shell: bash` -- this is a deliberate two-file, single-finding change, not scope creep; the drift test (re-run after the change) confirms the two lines are still equal. Separately, the issue-creation step's condition was narrowed from job-wide `if: failure()` to `if: failure() && steps.gate.outcome == 'failure'`, so an unrelated `actions/checkout`/`actions/setup-node`/`npm ci` flake no longer files or comments on the `dependency-advisory` issue with content unrelated to an advisory finding. The literal substring `if: failure()` is preserved (as part of the combined condition) since the existing drift test asserts its presence. `SPECIFICATION.md`'s prose description of both workflows was updated to match the new single-invocation, outcome-scoped behavior.

**Verification:** `npx vitest run --root scripts __tests__/advisory-scan-workflow.test.mjs` -- 9/9 pass (including the byte-identity drift assertion and the `if: failure()` presence assertion). Both YAML files parse successfully (`yaml` package). Locally simulated the exact `shell: bash` invocation (`bash --noprofile --norc -eo pipefail {0}`) against the real gate script -- exits 0, output correctly captured to file.

## Skipped Issues

None -- all in-scope findings (CR-01, WR-01, WR-02) were fixed.

**Out of scope (fix_scope = critical_warning):** IN-01 (`GHSA_PATTERN` looseness), IN-02 (`cancel-in-progress` narrow issue-filing gap), IN-03 (pre-existing missing `ci.yml` `permissions:` block) were left untouched per scope -- none are critical or warning severity.

---

_Fixed: 2026-08-20T16:35:32Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
