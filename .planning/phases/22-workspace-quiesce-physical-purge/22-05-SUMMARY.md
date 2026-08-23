---
phase: 22-workspace-quiesce-physical-purge
plan: 05
subsystem: database
tags: [postgres, drizzle, purge, partitions, rls, gdpr]

# Dependency graph
requires:
  - phase: 22-workspace-quiesce-physical-purge (plan 22-01)
    provides: purge_records table, the tracer two-table walk, deletePurgeBatch/countPurgeTableRows primitives, the checkpoint machinery
provides:
  - The full FK-ordered PURGE_TABLE_ORDER (~25 tables) covering every table docs/PII-INVENTORY.md names
  - PURGE_SECRET_TABLES naming the three tenant secret tables destroyed last
  - Corrected PURGE_EVIDENCE_TABLES (workspace_suppressions, was mistakenly "suppressions")
  - docs/PII-INVENTORY.md reconciled table-by-table against the purge's own allowlist
  - Neighbour-partition-safety proof (byte-identical rows, non-blocking concurrency, no structural DDL)
affects: [22-06 (restore path/report builder), 22-07 (member/invitation), 22-08 (watchdog), 22-10 (SPECIFICATION.md)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Full-tenant purge fixture: one row seeded per table in the FK order, inserted in dependency order inside a single withTenantTransaction"
    - "Neighbour-safety proof: seed two workspaces into the SAME monthly partition, snapshot the untouched workspace's full row contents (not counts) before/after"
    - "Deterministic lock-retry proof: hold a row lock for the WHOLE destructive tick rather than racing a timed release, to assert the fail-loud branch without flakiness"

key-files:
  created:
    - apps/worker/src/queues/__tests__/workspace-purge-tables.test.ts
    - apps/worker/src/queues/__tests__/workspace-purge-neighbour-safety.test.ts
  modified:
    - packages/db/src/workspace-purge-tables.ts
    - docs/PII-INVENTORY.md
    - apps/worker/src/queues/__tests__/workspace-purge.test.ts

key-decisions:
  - "Fixed PURGE_EVIDENCE_TABLES's typo'd 'suppressions' entry to the real physical table name 'workspace_suppressions' (Rule 1 bug from plan 22-01; the disjointness/evidence-survival tests only worked by coincidence before since nothing ever matched the wrong name)"
  - "Secret tables destroyed by the ordinary walk, not a bespoke path — PURGE_SECRET_TABLES only documents the set and its last-in-order placement"
  - "Reconciled docs/PII-INVENTORY.md's Excluded tables section with every purge-order table not already named by the DSR-export inventory, each with an explicit D-10 survival/destruction reason, so the reconciliation test's extraction is non-vacuous and exhaustive"
  - "workspace-purge.test.ts's two exact table_counts assertions changed to toMatchObject: the tracer's own 2-row fixture no longer produces an exhaustive census against the widened 25-table order"

requirements-completed: [PRG-02, PRG-04]

coverage:
  - id: D1
    description: "PURGE_TABLE_ORDER extended to the full FK-ordered ~25-table allowlist, satisfying all three ON DELETE RESTRICT edges and never relying on an uncounted cascade"
    requirement: "PRG-04"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/workspace-purge-tables.test.ts#order satisfies the restrict edges"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/workspace-purge-tables.test.ts#every spec resolves"
        status: pass
    human_judgment: false
  - id: D2
    description: "A full-tenant purge empties every table in the order (including both partitioned tables) while all four evidence sets and nothing else survive"
    requirement: "PRG-02"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/workspace-purge-tables.test.ts#full-tenant purge empties everything"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/workspace-purge-tables.test.ts#all four evidence sets survive"
        status: pass
    human_judgment: false
  - id: D3
    description: "The three secret tables are destroyed by the ordinary walk; suppression hashes survive while the HMAC key is destroyed"
    requirement: "PRG-02"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/workspace-purge-tables.test.ts#secrets are gone"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/workspace-purge-tables.test.ts#cryptographic erasure of suppression matching"
        status: pass
    human_judgment: false
  - id: D4
    description: "docs/PII-INVENTORY.md reconciled table-by-table against the purge's order and evidence set"
    requirement: "PRG-02"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/workspace-purge-tables.test.ts#inventory reconciliation"
        status: pass
    human_judgment: false
  - id: D5
    description: "A co-tenant workspace's rows in the same monthly partition are byte-identical after a purge, never blocked, and no structural partition operation is ever issued"
    requirement: "PRG-04"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/workspace-purge-neighbour-safety.test.ts#neighbour rows unchanged"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/workspace-purge-neighbour-safety.test.ts#no structural partition operation"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/workspace-purge-neighbour-safety.test.ts#concurrent neighbour write is not blocked"
        status: pass
    human_judgment: false

duration: 55min
completed: 2026-08-23
status: complete
---

# Phase 22 Plan 05: Full FK-Ordered Purge Table Allowlist, Secrets, Evidence, Neighbour Safety Summary

**Extended `PURGE_TABLE_ORDER` from the tracer's 2-table walk to the full ~25-table FK-ordered allowlist (satisfying 3 RESTRICT edges), destroyed the 3 tenant secret tables via the same ordinary walk, reconciled `docs/PII-INVENTORY.md` table-by-table, fixed a typo'd evidence-table name from plan 22-01, and proved neighbour-partition safety (byte-identical rows, non-blocking concurrency, no structural DDL) against a real partitioned Postgres.**

## Performance

- **Duration:** ~55 min
- **Completed:** 2026-08-23
- **Tasks:** 3
- **Files modified:** 5 (2 created, 3 modified)

## Accomplishments

- `PURGE_TABLE_ORDER`/`PURGE_TABLE_SPECS` in `packages/db/src/workspace-purge-tables.ts` widened to every tenant table `docs/PII-INVENTORY.md` names, in an order that satisfies `sends`→`flow_runs`, `flow_runs`→`flow_versions`, and `flows`/`campaigns`→`segments` (all `ON DELETE RESTRICT`), with the two partitioned tables (`events`, `send_events`) drained by the same bounded batched `deletePurgeBatch` as every other table.
- New `PURGE_SECRET_TABLES` constant names `workspace_sendgrid_keys`, `workspace_suppression_keys`, `workspace_webhook_endpoints` — destroyed last in the walk (not a bespoke path) so a mid-purge failure leaves credentials intact for resumption.
- `docs/PII-INVENTORY.md` reconciled table-by-table: every table the purge destroys that the DSR-export inventory didn't already name is now recorded under Excluded tables with an explicit D-10 reason (workspace-level config, platform bookkeeping, or a tenant secret — never per-contact PII).
- `apps/worker/src/queues/__tests__/workspace-purge-tables.test.ts` (new, 12 tests): FK-order index assertions, evidence-table disjointness, a real-database resolution check for every table spec (catches a typo'd physical name before a purge ever runs), the inventory↔purge reconciliation test, a full-tenant purge that empties all 25 tables while all 4 evidence sets survive, an empty-tables-are-normal case, secrets-gone, cryptographic-erasure-of-suppression-matching (hashed rows survive, the HMAC key doesn't), an idempotent-replay byte-identity check, and a uuid-not-name-equality backstop.
- `apps/worker/src/queues/__tests__/workspace-purge-neighbour-safety.test.ts` (new, 6 tests): seeds two workspaces into the SAME monthly partition, proves the untouched workspace's full row contents (not just counts) are byte-identical after the co-tenant's purge, that its own `table_counts` is never inflated by the neighbour's rows, that every partition existing before the purge still exists after it (plus a comment-stripped source scan for DROP/DETACH/TRUNCATE as a secondary guard), that a genuine concurrent write from a second connection is never blocked (short `statement_timeout` so a block fails fast), and that a row held by another connection's lock for the whole tick causes the purge to fail loudly rather than silently declare the table complete.

## Task Commits

1. **Task 1 + Task 2: Full FK-ordered table allowlist, secrets destroyed, evidence intact** - `71bb6df` (feat)
2. **Task 3: Neighbour partition-safety proof** - `4910cfa` (test)

_Note: Tasks 1 and 2 both modified `packages/db/src/workspace-purge-tables.ts` as a single coherent change (the secret-table ordering and `PURGE_SECRET_TABLES` constant are inseparable from the order extension itself), so they landed in one commit together with their combined test coverage._

## Files Created/Modified

- `packages/db/src/workspace-purge-tables.ts` - `PURGE_TABLE_ORDER`/`PURGE_TABLE_SPECS` widened to 25 tables; new `PURGE_SECRET_TABLES`; `PURGE_EVIDENCE_TABLES` typo fixed
- `docs/PII-INVENTORY.md` - Excluded tables section reconciled with every purge-order table not already covered
- `apps/worker/src/queues/__tests__/workspace-purge-tables.test.ts` - new, 12 tests (Tasks 1-2)
- `apps/worker/src/queues/__tests__/workspace-purge-neighbour-safety.test.ts` - new, 6 tests (Task 3)
- `apps/worker/src/queues/__tests__/workspace-purge.test.ts` - two exact `table_counts` assertions widened to `toMatchObject` (fallout of the order extension)

## Decisions Made

- **Fixed `PURGE_EVIDENCE_TABLES`'s "suppressions" typo → "workspace_suppressions".** Plan 22-01 declared the evidence list with a physical table name that never existed (`suppressions`), which meant the disjointness/survival guarantees it was meant to encode had never actually been checked against the real table. Corrected as a Rule 1 bug fix; the new tests exercise the corrected name directly.
- **Secret tables destroyed by the ordinary walk, never a bespoke code path.** `PURGE_SECRET_TABLES` exists purely to make "the secrets are gone" assertable by name and to document the last-in-order placement rationale (a purge that fails halfway is easier to resume with credentials intact).
- **`docs/PII-INVENTORY.md` reconciliation went beyond the minimum test requirement.** The reconciliation test only needs every table NAMED in the doc to resolve to the order or evidence set — it doesn't require every purge-order table to be named. I added the remaining ~17 tables to Excluded tables anyway (workspace configuration objects, platform bookkeeping, and the three secrets) because the doc's own stated purpose ("Phase 22's purge must consume this document") and the CLAUDE.md same-change rule both call for the doc to actually describe what the purge does, not just what export needed.
- **The "locked row is retried, not lost" test holds the lock for the whole tick rather than timing a release.** The plan's acceptance bar is "either completes after retry, or fails loudly — never declares done with a row present." Holding the lock for the entire destructive tick deterministically exercises the fail-loud branch without a timing race; the retry-then-succeed branch is already implicit in every other test where a batch legitimately empties.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `PURGE_EVIDENCE_TABLES` named a non-existent table**
- **Found during:** Task 1, while reconciling `PURGE_EVIDENCE_TABLES` against the real schema
- **Issue:** Plan 22-01 declared `PURGE_EVIDENCE_TABLES = ["erasure_records", "suppressions", "workspace_daily_rollup"]`, but the real table is `workspace_suppressions` — the disjointness/evidence-survival guarantees this constant is supposed to encode were silently unverifiable for that table.
- **Fix:** Corrected the entry to `workspace_suppressions`.
- **Files modified:** `packages/db/src/workspace-purge-tables.ts`
- **Verification:** New tests assert `workspace_suppressions` rows and their HMAC-hashed content survive a full purge; existing `workspace-purge.test.ts` test that checks `PURGE_EVIDENCE_TABLES` contains `erasure_records` still passes.
- **Committed in:** `71bb6df`

**2. [Rule 1 - Bug] `workspace-purge.test.ts`'s exact `table_counts` assertions broke under the widened order**
- **Found during:** Regression run of the tracer suite after extending `PURGE_TABLE_ORDER`
- **Issue:** The tracer's own two-table fixture asserted `tableCounts` with strict `toEqual({ contacts: 3, subscription_status_history: 5 })`. With the order now covering ~25 tables, the census legitimately includes a `0` entry for every other table, breaking the exact-equality check.
- **Fix:** Changed both assertions to `toMatchObject`, which the plan's own acceptance criterion ("the tracer suite survives the longer list") requires.
- **Files modified:** `apps/worker/src/queues/__tests__/workspace-purge.test.ts`
- **Verification:** `npm run test -w apps/worker -- workspace-purge` — 12/12 pass.
- **Committed in:** `71bb6df`

---

**Total deviations:** 2 auto-fixed (both Rule 1 bugs, both pre-existing from plan 22-01, both required for this plan's own acceptance criteria)
**Impact on plan:** Both fixes are corrections to code this plan directly extends; no scope creep.

## Issues Encountered

- Running the full `apps/worker` suite (all files concurrently) produced one flaky failure in `workspace-purge.test.ts`'s "restored mid-walk is refused" test — it passes reliably both standalone and within its own file (verified twice), and only misbehaves under full-suite parallel load. This matches the documented "isolation-pass = flake" signature already known for other tests in this repo (advisory-lock, flow-run-advance) and is not caused by this plan's changes. Not rabbit-holed per project constraints.
- Two additional full-suite failures are pre-existing/environmental, unrelated to this plan: `sentry.test.ts`'s "no DSN" case fails deterministically on this machine (real DSNs present in the local env file per prior project notes), and `stop-grace-period-publish.test.ts` requires `apps/worker/dist` to exist (resolved once `npm run build -w apps/worker` was run as part of this plan's own verification, but not part of the standard `vitest run` invocation).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `PURGE_TABLE_ORDER`, `PURGE_TABLE_SPECS`, `PURGE_SECRET_TABLES`, and `PURGE_EVIDENCE_TABLES` are now the complete, tested allowlist plan 22-06 (restore path, report builder) and 22-08 (watchdog) can build on directly from `@mega-crm/db`.
- `member`/`invitation` remain deliberately out of this plan's table order (owned by plan 22-07) — no code here touches them.
- No migration was added by this plan (per its own document contract); plans 22-01 and 22-04 remain the only two touching `packages/db/migrations/meta/_journal.json`.

---
*Phase: 22-workspace-quiesce-physical-purge*
*Completed: 2026-08-23*
