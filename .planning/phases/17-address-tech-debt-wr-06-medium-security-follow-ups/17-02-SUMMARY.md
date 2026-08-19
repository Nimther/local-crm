---
phase: 17-address-tech-debt-wr-06-medium-security-follow-ups
plan: 02
subsystem: database
tags: [postgres, timezone, analytics, dashboard, vitest]

requires:
  - phase: 13-compliance-analytics-integrity
    provides: "reconcileWorkspaceDay's single-hop AT TIME ZONE 'UTC' idiom for timestamptz columns (sends.*_at), the pattern this plan's read_first explicitly contrasts against"
provides:
  - "GROWTH_BY_DAY_SQL / BASELINE_CONTACT_COUNT_SQL exported constants executed directly by getWorkspaceDashboard and imported unchanged by the regression test"
  - "Executable proof that the double-hop AT TIME ZONE 'UTC' idiom is UTC-day-correct on a naive timestamp column under a non-UTC reading session, and that the single-hop form is not"
  - "D-03 sweep audit discharged: a written, reproducible classification of every remaining bare ::date cast in apps/api, apps/worker, packages/db, with a residual gate that fails on any future unclassified site"
affects: [dashboard-analytics, wr-06-timezone-hazard]

tech-stack:
  added: []
  patterns:
    - "Double-hop `((col AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::date` for UTC-correct day bucketing on a NAIVE timestamp column (opposite direction from the single-hop form used on timestamptz columns)"
    - "Transaction-scoped `SET LOCAL TIME ZONE '<zone>'` to simulate an unpinned client session in a regression test, without disturbing other concurrent tests on the shared pool"
    - "Insert test fixtures via an explicit no-offset timestamp literal string (never a JS `Date` object) when the test's own correctness must not depend on the INSERT session's TimeZone"

key-files:
  created:
    - apps/api/src/modules/analytics/__tests__/dashboard-timezone.test.ts
  modified:
    - apps/api/src/modules/analytics/dashboard.repository.ts

key-decisions:
  - "Used the double-hop AT TIME ZONE 'UTC' idiom (matching packages/db/src/partitions/relocate-default.ts), NOT the single-hop form 13-REVIEW.md's WR-06 write-up and CONTEXT.md's D-01 literally name -- RESEARCH.md Pitfall 1 proved the single-hop form is session-dependent (wrong) for this naive column, and the RED mutation performed during this plan reproduced that failure directly against this codebase's own test."
  - "BASELINE_CONTACT_COUNT_SQL left semantically unchanged -- it is a naive-to-naive `<` comparison with no timezone conversion at any point, so an anchor would be noise, not safety; made this an executable assertion (Test 4) rather than leaving it an unverified claim."
  - "Test fixtures use explicit no-offset timestamp literal strings (`'2026-08-18 01:30:00'`), not JS `Date` objects, for the INSERT -- a `Date` parameter is serialized by node-postgres using the test PROCESS's own local TZ offset (`parseInputDatesAsUTC: false` is the driver default), which Postgres then reinterprets through the INSERT session's TimeZone GUC. That write-side indirection is the OTHER half of WR-06 (closed by plan 17-01's pool pin, not this plan) and this READ-side test must not accidentally depend on it."

requirements-completed: []

coverage:
  - id: D1
    description: "GROWTH_BY_DAY_SQL uses the double-hop UTC anchor and returns the correct UTC day for a contact regardless of the reading session's TimeZone GUC"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/analytics/__tests__/dashboard-timezone.test.ts#Test 1: GROWTH_BY_DAY_SQL returns the correct UTC day under an America/New_York reading session"
        status: pass
    human_judgment: false
  - id: D2
    description: "The single-hop form named in 13-REVIEW.md/D-01 is proven WRONG by an executable assertion (returns the New York day, not the UTC day) -- locks the hazard out of future 'simplifications'"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/analytics/__tests__/dashboard-timezone.test.ts#Test 2 (RESEARCH.md Pitfall 1, made executable)"
        status: pass
    human_judgment: false
  - id: D3
    description: "BASELINE_CONTACT_COUNT_SQL is session-invariant (identical count under UTC and America/New_York)"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/analytics/__tests__/dashboard-timezone.test.ts#Test 4 (D-03 verified-safe, made executable)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Pre-existing HTTP-level dashboard test suite (dashboard.test.ts) is unaffected by the constant extraction and cast change"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/analytics/__tests__/dashboard.test.ts"
        status: pass
    human_judgment: false
  - id: D5
    description: "D-03 sweep audit reconciled against a fresh grep; residual gate empty, unfiltered grep non-empty (proves the gate filters a real population)"
    verification:
      - kind: other
        ref: "grep -rn '::date' apps/api/src apps/worker/src packages/db/src --include='*.ts' | grep -v '__tests__' | grep -vE '\\$[0-9]+::date' | grep -vE \"AT TIME ZONE 'UTC'\" | grep -vE ':[0-9]+:[[:space:]]*(\\*|//)' -> 0 lines"
        status: pass
    human_judgment: false

duration: ~20min
completed: 2026-08-19
status: complete
---

# Phase 17 Plan 02: Read-site UTC anchor + D-03 sweep audit Summary

**Double-hop `AT TIME ZONE 'UTC'` UTC anchor on the growth-chart query, proven correct under a real America/New_York reading session via an executable test that also locks out the single-hop form 13-REVIEW.md/D-01 literally name.**

## Performance

- **Duration:** ~20 min
- **Completed:** 2026-08-19T11:31:34Z
- **Tasks:** 2 (Task 1 code + test, Task 2 audit-only)
- **Files modified:** 2 (1 modified, 1 created)

## Accomplishments

- `GROWTH_BY_DAY_SQL` and `BASELINE_CONTACT_COUNT_SQL` are now exported constants in `dashboard.repository.ts`, executed directly by `getWorkspaceDashboard` — no second copy of the SQL exists for a test to drift against.
- The growth query's day-bucketing expression is now the double-hop `((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::date` — matching this repo's own existing idiom at `packages/db/src/partitions/relocate-default.ts:112` — instead of a bare `created_at::date` cast with no explicit UTC anchor.
- New `dashboard-timezone.test.ts` forces a real non-UTC Postgres reading session (`SET LOCAL TIME ZONE 'America/New_York'`, transaction-scoped) and proves: (1) the double-hop form returns the correct UTC day, (2) the single-hop form named in 13-REVIEW.md's WR-06 text and CONTEXT.md's D-01 returns the wrong (New York) day, (3) both forms agree under a UTC session, (4) `BASELINE_CONTACT_COUNT_SQL` returns an identical count under UTC and non-UTC sessions.
- The RED mutation demanded by the plan's `<action>` was actually performed: substituting the single-hop form into `GROWTH_BY_DAY_SQL` made Test 1 fail with the New York day; the double-hop form was then restored and the suite went green again. Both outputs are recorded below.
- D-03 sweep audit re-run against a fresh grep and reconciled against the plan's pre-computed classification table (no new unclassified sites found); the residual gate is empty while the unfiltered grep is non-empty, proving the gate filters a real population rather than passing vacuously.

## Task Commits

1. **Task 1: Double-hop UTC anchor on the growth query, proven against a non-UTC reading session** - `ac12269` (feat)
2. **Task 2: Discharge the D-03 sweep audit against a fresh grep** - audit-only, no source change; recorded in this SUMMARY (no separate commit — see Deviations)

**Plan metadata:** committed alongside this SUMMARY.

## Files Created/Modified

- `apps/api/src/modules/analytics/dashboard.repository.ts` — hoisted `GROWTH_BY_DAY_SQL`/`BASELINE_CONTACT_COUNT_SQL` to exported module-level constants; growth query's day-bucketing cast changed from bare `created_at::date` to the double-hop `((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::date` in both SELECT and GROUP BY; added header comments documenting the WR-06 rationale, the `relocate-default.ts` precedent, and why `sends.*_at`'s single-hop form must not be "harmonized" to this one.
- `apps/api/src/modules/analytics/__tests__/dashboard-timezone.test.ts` (new) — 4 integration tests against a real ephemeral Postgres database, using `withTenant`/`withTenantTransaction` from `@mega-crm/tenant-context` plus a transaction-scoped `SET LOCAL TIME ZONE` override to force a non-UTC reading session.

## D-03 Sweep Audit — Reconciled Classification

Re-ran `grep -rn "::date" apps/api/src apps/worker/src packages/db/src --include="*.ts" | grep -v "__tests__"` against the post-Task-1 tree. Every occurrence falls into exactly one of the following classes — identical in substance to the plan's pre-computed table, now confirmed against the actual (post-fix) file state:

| Site | Expression class | Column type (confirmed by reading the schema) | Verdict |
|---|---|---|---|
| `apps/api/.../dashboard.repository.ts:78` (SELECT), `:81` (GROUP BY) | Double-hop `AT TIME ZONE 'UTC'` cast on a column, in a day-bucketing position | `contacts.created_at` — naive `timestamp` (confirmed: `packages/db/src/schema/contacts.ts:52`, `timestamp("created_at").notNull().defaultNow()`, no `withTimezone`) | **FIXED (Task 1).** Was the only bare-cast site in the repo in its class; now carries the explicit double-hop UTC anchor and is proven session-independent by `dashboard-timezone.test.ts`. |
| `apps/api/.../dashboard.repository.ts:80`, `:94`, `:179`; `apps/worker/.../analytics-reconciliation.worker.ts:127`, `:128-137` (right-hand sides), `:218` | `$N::date` — a cast of a **bound parameter**, not of a column | n/a (parameter) | **SAFE.** Casts a date *string* the application computed in JS to `date`. No column and no timezone conversion is involved. |
| `apps/api/.../dashboard.repository.ts:80` (`created_at >= $2::date`), `:94` (`created_at < $2::date`) | `>=`/`<` comparison of a naive column against a `date` literal | `contacts.created_at` — naive `timestamp` | **SAFE, no change.** The `date` literal is implicitly promoted to naive midnight and compared naive-to-naive. No timezone conversion occurs at any point. `dashboard-timezone.test.ts` Test 4 makes this an executable assertion (identical baseline count under a UTC and an America/New_York session) rather than a claim. |
| `apps/worker/.../analytics-reconciliation.worker.ts:128-137` (left-hand sides, e.g. `(sent_at AT TIME ZONE 'UTC')::date`) | **Single**-hop cast on a column | `sends.sent_at` and siblings — `timestamptz` (confirmed: `packages/db/src/schema/sends.ts:89`, `timestamp("sent_at", { withTimezone: true })`) | **SAFE, correct as written, deliberately untouched.** For a `timestamptz` column a single hop converts to naive UTC wall clock and the final cast is a pure truncation — the OPPOSITE direction from the naive-column case above. `timestamptz` and naive `timestamp` columns need opposite-direction handling (RESEARCH.md Pitfall 1); this file was not modified by this plan (`git status --porcelain apps/worker/src/queues/analytics-reconciliation.worker.ts` produces no output). |
| `apps/worker/.../analytics-reconciliation.worker.ts:102`, `apps/worker/.../reputation-tick.worker.ts:103`, `packages/db/src/schema/workspace-daily-rollup.ts:29`, plus the new prose comments added by Task 1 in `dashboard.repository.ts` (lines 52, 58, 87, 147) | Occurrences inside comment prose | n/a | **SAFE.** Documentation, not executed SQL. |

**Residual gate:**
```
grep -rn '::date' apps/api/src apps/worker/src packages/db/src --include='*.ts' \
  | grep -v '__tests__' \
  | grep -vE '\$[0-9]+::date' \
  | grep -vE "AT TIME ZONE 'UTC'" \
  | grep -vE ':[0-9]+:[[:space:]]*(\*|//)'
```
Result: **0 lines** (exit 0, empty output).

**Unfiltered population check** (proves the gate is filtering something real, not passing vacuously on an empty grep): `grep -rn "::date" apps/api/src apps/worker/src packages/db/src --include="*.ts" | grep -v "__tests__"` returns **22 lines** in the post-fix tree (up from the plan-time 15, because Task 1's header comments intentionally discuss `::date`/`AT TIME ZONE 'UTC'` by name — see Deviations below; the filter's comment-line exclusion is exactly what absorbs this).

## RED Mutation Demonstration (D-02's own mandated proof)

Per the plan's `<action>` instruction, the single-hop expression was temporarily substituted into `GROWTH_BY_DAY_SQL` after the tests were written and passing, to prove the test file actually discriminates:

**RED (single-hop form substituted), `npx vitest run --root apps/api src/modules/analytics/__tests__/dashboard-timezone.test.ts`:**
```
 ❯ src/modules/analytics/__tests__/dashboard-timezone.test.ts (4 tests | 1 failed) 1378ms
     × Test 1: GROWTH_BY_DAY_SQL returns the correct UTC day under an America/New_York reading session 352ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯
AssertionError: expected '2026-08-17' to be '2026-08-18' // Object.is equality
Expected: "2026-08-18"
Received: "2026-08-17"

 Test Files  1 failed (1)
      Tests  1 failed | 3 passed (4)
```
This is exactly the failure mode Pitfall 1 predicts: under the deliberately-wrong single-hop form and an America/New_York session, the query reports one day earlier than the correct UTC day.

**GREEN (double-hop form restored), `npx vitest run --root apps/api src/modules/analytics/__tests__/dashboard-timezone.test.ts src/modules/analytics/__tests__/dashboard.test.ts`:**
```
 Test Files  2 passed (2)
      Tests  7 passed (7)
```

## Confirmed Column Types

- `contacts.created_at` — naive `timestamp` (no time zone). Confirmed by reading `packages/db/src/schema/contacts.ts:52`: `createdAt: timestamp("created_at").notNull().defaultNow()` — no `{ withTimezone: true }` option, so Drizzle emits a plain `timestamp` column.
- `sends.sent_at` (and siblings `delivered_at`, `first_opened_at`, `first_clicked_at`, `bounced_at`, `dropped_at`, `unsubscribed_at`, `spam_reported_at`, `queued_at`, `reconciling_since`, `dispatched_at`) — `timestamptz`. Confirmed by reading `packages/db/src/schema/sends.ts:89`: `sentAt: timestamp("sent_at", { withTimezone: true })`.

## Decisions Made

- Implemented the double-hop `AT TIME ZONE 'UTC'` idiom rather than the single-hop form CONTEXT.md's D-01 text and 13-REVIEW.md's WR-06 write-up literally describe — required by RESEARCH.md Pitfall 1's empirical finding, and independently confirmed by this plan's own RED mutation, which reproduced the exact failure mode (wrong day under a non-UTC session) that implementing the literal text would have shipped.
- Left `BASELINE_CONTACT_COUNT_SQL` unchanged (no cast added) — it performs a naive-to-naive comparison with no timezone conversion, so a UTC anchor would add no safety. Verified rather than assumed, via Test 4.
- Test fixtures insert contacts using an explicit no-offset timestamp literal string, not a JS `Date` object, specifically to keep this READ-side test's correctness independent of the INSERT session's TimeZone (a `Date` parameter's write-time behavior is the OTHER half of WR-06, closed by plan 17-01, not this plan).

## Deviations from Plan

### Auto-fixed / Noted Issues

**1. [Informational — no fix needed] `anonymized_at IS NULL` grep count is 3, not the plan's expected 2**
- **Found during:** Task 1 acceptance-criteria verification
- **Issue:** The plan's acceptance criteria state `grep -c 'anonymized_at IS NULL' <file>` should return 2 (once per SQL query: growth, baseline). The actual count in `dashboard.repository.ts` is 3.
- **Root cause:** A pre-existing code comment above the growth query (`// \`anonymized_at IS NULL\` (CMP-04, plan 13-10, Task 3 audit find --`) already mentioned the phrase before this plan's changes — the plan's grep-count expectation was computed without accounting for that comment.
- **Resolution:** No fix needed. The substantive requirement — the erasure filter surviving in BOTH SQL query strings — is verified: `anonymized_at IS NULL` appears in both `GROWTH_BY_DAY_SQL` (line 80) and `BASELINE_CONTACT_COUNT_SQL` (line 94); the third occurrence is the pre-existing comment (line 227, unrelated to this plan's edits). Documented here rather than treated as a discrepancy requiring a code change.
- **Files affected:** None (documentation-only finding).

**2. [Rule 2-adjacent, informational] Task 2 produced no source change — audited as `SAFE`, per D-03's own instruction not to mechanically rewrite stable queries**
- **Found during:** Task 2
- **Issue:** N/A — this is the expected outcome per the plan's own text ("D-03 explicitly rejected a repo-wide cast rewrite"). Recorded here only to make explicit that Task 2's "commit" is this SUMMARY plus the metadata commit, not a separate code commit, since there was no code to commit.
- **Files affected:** None.

---

**Total deviations:** 0 code changes beyond the plan's own scope; 2 informational notes above.
**Impact on plan:** None — plan executed as specified; both notes are clarifications of pre-existing state, not corrections to work performed in this plan.

## Issues Encountered

None. `npx tsc -p apps/api/tsconfig.json --noEmit` passes clean after the constant extraction (confirms the generic `client.query<...>` type parameters still line up against the extracted string constants).

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- WR-06's read-site half (D-01's second half) is closed for the growth-chart query specifically; the write-side half (pool-level `TimeZone=UTC` pin) is plan 17-01's responsibility and was not required to land before this plan's test could pass (the test forces its own non-UTC session independently of the pool's default).
- D-03's sweep audit is discharged with a written, reproducible classification and a residual gate that will fail loudly if a new unclassified bare `::date` cast on a naive column ever appears in `apps/api/src`, `apps/worker/src`, or `packages/db/src`.
- No blockers for the remaining Phase 17 plans (image immutability, restore-drill instrumentation, security-register closure).

---
*Phase: 17-address-tech-debt-wr-06-medium-security-follow-ups*
*Completed: 2026-08-19*
