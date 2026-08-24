---
phase: 18-dependency-hygiene-advisory-gate
plan: 02
subsystem: ci-quality-gates
tags: [dependency-hygiene, npm-audit, accept-list, ci-gate, tdd]

requires:
  - phase: 18-dependency-hygiene-advisory-gate
    provides: "scripts/check-dependency-advisories.mjs (check:dependency-advisories gate), scripts/__fixtures__/dependency-advisories/pre-fix-audit.json, .advisory-accept-list.json (schema shape, empty)"
provides:
  - "validateAcceptListEntry(entry, now) -- full D-04..D-07 accept-list field/expiry validation"
  - "loadAcceptList(filePath) -- file-level accept-list shape validation (missing/malformed/non-array entries/duplicate pairs)"
  - "MAX_EXPIRY_DAYS (90), MIN_JUSTIFICATION_LENGTH (80), ACCEPT_LIST_FILENAME exported constants"
  - "main() wiring: a malformed accept-list fails the gate outright; a missing file prints a notice; a stale entry prints a warning without failing the gate"
affects: [18-03, 18-04]

tech-stack:
  added: []
  patterns:
    - "hand-rolled validation, Node built-ins only (Date.UTC day-unit arithmetic for timezone-independent expiry comparison, no date library)"
    - "own-property reads + Map-based duplicate tracking for prototype-pollution safety on repo-authored JSON (mirrors collectAdvisories' T-18-01/T-18-02 pattern from 18-01)"
    - "loader returns {fileExisted, entries, problems} rather than throwing -- 'absent file' and 'malformed file' are distinct, both non-throwing outcomes"

key-files:
  created: []
  modified:
    - scripts/check-dependency-advisories.mjs
    - scripts/__tests__/check-dependency-advisories.test.mjs

key-decisions:
  - "loadAcceptList validates only FILE-level shape (parse errors, entries-not-array, duplicate advisoryId+package pairs); per-entry field/expiry validation is a separate validateAcceptListEntry call driven by main() over each returned entry. Keeps the two failure classes (file-shape vs. entry-content) independently testable and matches the RED suite's separate loadAcceptList vs. validateAcceptListEntry test blocks."
  - "A stale accept-list entry (valid, unexpired, matching no advisory in the current tree) is a printed warning, not a failure -- carried forward from 18-01's SUMMARY as the plan's own flagged assumption, now implemented in main()'s stale-entry loop after findings are selected."
  - "MIN_JUSTIFICATION_LENGTH = 80: rejects one-line hand-waves ('not reachable', 'internal tool only') while staying cheap enough to not discourage writing a real entry -- documented in the constant's own comment per the plan's action text."

requirements-completed: [DEP-03]

coverage:
  - id: D1
    description: "An accept-list entry missing/empty/wrong-typed in any of the five mandatory fields (advisoryId, package, justification, owner, expiry) is rejected, naming the entry and field (D-04)"
    requirement: DEP-03
    verification:
      - kind: unit
        ref: "scripts/__tests__/check-dependency-advisories.test.mjs#Test 13 -- validateAcceptListEntry mandatory field: * (D-04)"
        status: pass
    human_judgment: false
  - id: D2
    description: "A trivially short justification is rejected (D-06); an owner that is not email-shaped is rejected (D-07)"
    requirement: DEP-03
    verification:
      - kind: unit
        ref: "scripts/__tests__/check-dependency-advisories.test.mjs#Test 14 -- justification length (D-06), Test 15 -- owner is email-shaped (D-07)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Expiry boundaries are enforced in UTC day units: yesterday rejected, today accepted (inclusive), today+90 accepted, today+91 rejected as exceeding the cap, with distinct messages for lapsed vs. over-cap (D-05)"
    requirement: DEP-03
    verification:
      - kind: unit
        ref: "scripts/__tests__/check-dependency-advisories.test.mjs#Test 18 -- expiry boundaries against an injected now (D-05)"
        status: pass
    human_judgment: false
  - id: D4
    description: "A missing accept-list file is treated as empty (never a throw); malformed JSON, a non-array entries, and duplicate (advisoryId, package) pairs each fail loadAcceptList; {\"entries\": []} succeeds with zero problems"
    requirement: DEP-03
    verification:
      - kind: unit
        ref: "scripts/__tests__/check-dependency-advisories.test.mjs#Test 19 -- loadAcceptList file-level shape (D-04 file contract)"
        status: pass
    human_judgment: false
  - id: D5
    description: "A valid, unexpired entry suppresses exactly the finding whose advisoryId and package both match; a mismatch on either field does not suppress; an entry matching no finding does not remove any finding (stale-entry, no failure by itself)"
    requirement: DEP-03
    verification:
      - kind: unit
        ref: "scripts/__tests__/check-dependency-advisories.test.mjs#Test 20 -- end-to-end suppression through selectBlockingFindings"
        status: pass
    human_judgment: false
  - id: D6
    description: "The live gate rejects a deliberately malformed .advisory-accept-list.json (exit non-zero, message names the missing fields) and restores the file byte-identical"
    requirement: DEP-03
    verification:
      - kind: integration
        ref: "npm run check:dependency-advisories against a temporarily-corrupted .advisory-accept-list.json (plan's Task 2 acceptance criterion, re-run during execution)"
        status: pass
    human_judgment: false

duration: ~25min
completed: 2026-08-20
status: complete
---

# Phase 18 Plan 02: Accept-List Schema Validation Summary

**Made the `.advisory-accept-list.json` accept-list self-enforcing: `validateAcceptListEntry` and `loadAcceptList`, wired into the gate's `main()`, so an acceptance without justification, owner, or a bounded/unexpired expiry cannot pass the gate — proven by a 75-test fixture suite, with the accept-list still shipping empty.**

## Performance

- **Duration:** ~25 min
- **Tasks:** 2/2
- **Files modified:** 2 (`scripts/check-dependency-advisories.mjs`, `scripts/__tests__/check-dependency-advisories.test.mjs`)

## Accomplishments

- `validateAcceptListEntry(entry, now)` — checks, in fixed order, all five mandatory fields (D-04), advisoryId GHSA-shape, owner email-shape (D-07), justification length (D-06: the field IS the reachability analysis), and both expiry rules (D-05: inclusive-today, `MAX_EXPIRY_DAYS`-day cap), all computed in UTC day units so no result depends on the runner's timezone (T-18-10).
- `loadAcceptList(filePath)` — a rewritten, exported loader taking an explicit path: absent file → `{fileExisted: false, entries: [], problems: []}`, never a throw; unparseable JSON, a missing/non-array `entries`, or a duplicate (advisoryId, package) pair → file-level `problems`. Own-property reads and a `Map`-based duplicate index (T-18-07) so a `__proto__`-shaped key in the JSON can never reach `Object.prototype`.
- New exported constants: `MAX_EXPIRY_DAYS` (90, D-05), `MIN_JUSTIFICATION_LENGTH` (80, D-06), `ACCEPT_LIST_FILENAME` (now exported, was previously module-private).
- `main()` rewired: loads the accept-list before selecting findings; any file-level or entry-level problem fails the gate outright (three-part failure report naming the entry index, its claimed advisoryId/package, and each offending field with the reason) regardless of the advisory state; an absent file prints an explicit notice before continuing with an empty list; after findings are selected, a valid entry matching no current advisory prints a stale-entry warning without changing the exit code.
- Header comment extended with the full accept-list contract (D-04 through D-07, plus the "proven-unreachable only, never a snooze button for a reachable HIGH" reminder tying back to D-11).
- `.advisory-accept-list.json` stays `{"entries": []}` — SC4 is proven by fixtures, not a manufactured live entry, per the plan's explicit output spec.

## Task Commits

Each task was committed atomically (TDD: RED then GREEN):

1. **Task 1: RED — accept-list rejection fixtures** — `e5f1f97` (test) — 305 lines added to `scripts/__tests__/check-dependency-advisories.test.mjs`; also replaced the pre-existing suite's four bare `new Date()` calls with the new injected `NOW` constant, since Task 1's own acceptance criterion bans any clock read anywhere in the file, not just in the new section.
2. **Task 2: GREEN — accept-list validation wired into the gate** — `043d7cc` (feat) — implementation in `scripts/check-dependency-advisories.mjs`; all 75 tests (13 original + 62 new/expanded) pass.

**Plan metadata:** *(this commit — SUMMARY.md)*

## Files Created/Modified

- `scripts/check-dependency-advisories.mjs` — added `validateAcceptListEntry`, rewrote `loadAcceptList` to take a `filePath` and return a `{fileExisted, entries, problems}` report, added `MAX_EXPIRY_DAYS`/`MIN_JUSTIFICATION_LENGTH`/`ACCEPT_LIST_FILENAME` exports and three internal regex constants (GHSA/email/ISO-date shape), rewired `main()`'s accept-list handling end to end.
- `scripts/__tests__/check-dependency-advisories.test.mjs` — added Tests 12–20 (constants sanity, D-04 mandatory-field matrix via `describe.each`/`it.each`, D-06 justification length, D-07 owner email-shape, GHSA-shape, expiry format, D-05 boundary matrix including a UTC-midnight timezone-independence check, `loadAcceptList` file-contract suite using `mkdtemp`-backed temp files, and end-to-end suppression/mismatch/stale-entry cases against the real committed pre-fix fixture).

## Decisions Made

- `loadAcceptList` validates only file-level shape; per-entry validation is a separate `validateAcceptListEntry` pass driven by `main()`. This keeps the two failure classes independently testable and matches the RED suite's own separation of concerns.
- Stale-entry handling (valid, unexpired, matching no current advisory) is a warning, not a failure — this was flagged as a planner assumption in 18-02-PLAN.md's own `<flagged_assumptions>` block (D-04..D-07 don't cover it; D-05's cap already bounds how long a stale entry can survive) and is now the implemented behavior in `main()`.
- `MIN_JUSTIFICATION_LENGTH = 80` — documented inline as a deliberately low bar (one real sentence, not a paragraph) that still rejects one-word/one-line hand-waves.
- Date arithmetic in the test file's module scope uses `MAX_EXPIRY_DAYS ?? 90` rather than a bare reference to the (pre-implementation-undefined) constant, so the test file can still be *imported* during Task 1's RED phase and surface `TypeError: validateAcceptListEntry is not a function` / `loadAcceptList is not a function` failures — the acceptance criterion requires the RED output to *name* the missing exports, which a load-time `RangeError: Invalid time value` (the first version written) did not satisfy.

## Deviations from Plan

None beyond the one documented decision above (the `?? 90` fallback), which was a fix-forward correction discovered while producing this plan's own required fail-first RED evidence — not a change to scope, contract, or behavior. No Rule 1/2/3/4 auto-fixes were needed against pre-existing code.

## Task 1 RED Output (fail-first evidence)

```
$ npx vitest run --root scripts __tests__/check-dependency-advisories.test.mjs
...
 Test Files  1 failed (1)
      Tests  58 failed | 17 passed (75)
```

Representative failures naming the missing exports (the 17 passes are the pre-existing Tests 1–11 from plan 18-01, unaffected by this plan's additions):

```
FAIL  __tests__/check-dependency-advisories.test.mjs > Test 19 -- loadAcceptList file-level shape (D-04 file contract) > fails on two entries sharing the same advisoryId and package, naming the duplicate pair
TypeError: loadAcceptList is not a function

FAIL  __tests__/check-dependency-advisories.test.mjs > Test 19 -- loadAcceptList file-level shape (D-04 file contract) > succeeds with zero entries and no failure on {"entries": []}
TypeError: loadAcceptList is not a function
```

`Test 13` (the `describe.each` mandatory-field matrix over `validateAcceptListEntry`) failed identically with `TypeError: validateAcceptListEntry is not a function` across all of its cases.

## Task 2 GREEN Summary

```
$ npx vitest run --root scripts __tests__/check-dependency-advisories.test.mjs
 Test Files  1 passed (1)
      Tests  75 passed (75)
```

Malformed-accept-list live-gate check (plan's own Task 2 acceptance criterion, re-run during execution):

```
$ cp .advisory-accept-list.json /tmp/al.bak
$ printf '%s' '{"entries":[{"advisoryId":"GHSA-1111-2222-3333"}]}' > .advisory-accept-list.json
$ npm run check:dependency-advisories
check:dependency-advisories FAILED: .advisory-accept-list.json is malformed.

Problems:
  - entry 0 (advisoryId="GHSA-1111-2222-3333", package=null): field "package" is required and must be a non-empty string
  - entry 0 (advisoryId="GHSA-1111-2222-3333", package=null): field "justification" is required and must be a non-empty string
  - entry 0 (advisoryId="GHSA-1111-2222-3333", package=null): field "owner" is required and must be a non-empty string
  - entry 0 (advisoryId="GHSA-1111-2222-3333", package=null): field "expiry" is required and must be a non-empty string
$ cp /tmp/al.bak .advisory-accept-list.json
$ diff .advisory-accept-list.json /tmp/al.bak   # byte-identical
```

Live gate against the real, unmodified dependency tree, after this plan's changes — unchanged from 18-01's evidence (9 blocking findings, exit 1), confirming the accept-list wiring did not alter gate behavior with an empty accept-list:

```
check:dependency-advisories FAILED: 9 blocking advisory finding(s) not covered by .advisory-accept-list.json.
```

This is the expected, intended end state of this plan — plan 18-03 performs the actual dependency upgrades that turn it green.

## Lint

- `npx eslint scripts/check-dependency-advisories.mjs scripts/__tests__/check-dependency-advisories.test.mjs --max-warnings=0` — exits 0.
- `npm run lint` (whole-repo) still fails on the same 4 pre-existing `@typescript-eslint` errors in `apps/web/src/lib/sentry.ts` documented in `18-01-SUMMARY.md`'s "Scope Boundary" section — verified untouched by this plan (`git diff --stat HEAD -- apps/web/src/lib/sentry.ts` is empty). Per the scope-boundary rule, left alone; not this plan's file set.

## Known Stubs

None. `.advisory-accept-list.json` ships empty by design (D-04/RESEARCH.md, and the plan's own success criteria) — DEP-03/SC4 is proven by the fixture suite (Tests 12–20), not by a manufactured live entry.

## Threat Flags

None. Every new surface introduced by this plan (repo-authored accept-list JSON parsed by `loadAcceptList`, the entry-validation logic itself) was already enumerated in this plan's own `<threat_model>` (T-18-06 through T-18-10) and mitigated exactly as specified: mandatory `owner`+`justification` and the 90-day cap (T-18-06), own-property reads plus `Map`-based duplicate detection with no prototype-reachable accumulation (T-18-07), email-shaped-owner requirement (T-18-08), exact advisoryId-AND-package matching with unit tests in both mismatch directions (T-18-09), and UTC-only expiry comparison unit-tested near a UTC day boundary (T-18-10).

## Auth Gates

None encountered.

## Next Phase Readiness

- The accept-list schema is now fully self-enforcing; plan 18-03 can add a real, justified accept-list entry (if one turns out to be needed after triage) with confidence that a malformed one will be caught by the gate itself.
- The gate remains RED against the real dependency tree by design — 18-03 is the plan that turns it GREEN via actual upgrades.
- `MAX_EXPIRY_DAYS`, `MIN_JUSTIFICATION_LENGTH`, `ACCEPT_LIST_FILENAME`, `loadAcceptList`, and `validateAcceptListEntry` are now stable exported symbols other phase-18 plans (18-04's scheduled scan workflow) can reference directly rather than re-deriving.

## Self-Check: PASSED

- `scripts/check-dependency-advisories.mjs` — FOUND
- `scripts/__tests__/check-dependency-advisories.test.mjs` — FOUND
- Commit `e5f1f97` — FOUND
- Commit `043d7cc` — FOUND

---
*Phase: 18-dependency-hygiene-advisory-gate*
*Completed: 2026-08-20*
