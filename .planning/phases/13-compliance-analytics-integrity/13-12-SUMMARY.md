---
phase: 13-compliance-analytics-integrity
plan: 12
subsystem: database
tags: [postgres, rls, drizzle, kms, hmac, contacts, suppression, compliance]

requires:
  - phase: 13-compliance-analytics-integrity
    provides: "13-10's unconditional suppression insert on erasure (deleteContact) and the shared SUPPRESSION_REASON_CONTACT_DELETED constant -- this plan converts that write site's INSERT to a hash"
provides:
  - "workspace_suppression_keys table (migration 0060): one per-workspace HMAC key, envelope-encrypted via @mega-crm/kms, same wrapped shape as workspace_sendgrid_keys, FORCE RLS"
  - "packages/contacts-core/src/suppression-hash.ts: normalizeSuppressionEmail, hashSuppressionEmail, ensureWorkspaceSuppressionKey, loadWorkspaceSuppressionKey, clearSuppressionKeyCache, SUPPRESSION_KEY_CACHE_TTL_MS"
  - "workspace_suppressions.email_hash as the sole identity column post-migration-0061 -- the plaintext email column is gone; every read/write site (isEmailSuppressed, deleteContact's insert, applySuppression's insert) compares/writes only the hash"
  - "packages/db/scripts/rehash-suppressions.ts (db:rehash-suppressions): the operator-invoked backfill between the expand (0060) and contract (0061) migrations, discover-on-scan/work-per-workspace, bounded batches, idempotent, skips (not crashes on) a case/whitespace collision between two pre-existing plaintext rows"
affects: [13-14]

tech-stack:
  added: []
  patterns:
    - "Per-workspace envelope-encrypted secret, second instance: workspace_suppression_keys mirrors workspace_sendgrid_keys' wrapped-key column shape verbatim"
    - "In-process TTL cache of unwrapped key material (5 min), keyed by workspace id, zeroed on eviction/clear -- the hot-path-cost defense for a per-candidate suppression check"
    - "No-key-row-means-nothing-suppressed short-circuit: the read path never creates a key; only a write site (or the operator backfill) does"
    - "Discover-on-scan-pool / work-per-workspace-on-app-pool for an operator backfill that WRITES (not just reads) a tenant table, following count-send-event-duplicates.ts's precedent"

key-files:
  created:
    - packages/contacts-core/src/suppression-hash.ts
    - packages/contacts-core/src/__tests__/suppression-hash.test.ts
    - packages/db/src/schema/workspace-suppression-keys.ts
    - packages/db/migrations/0060_suppression_hash_expand.sql
    - packages/db/migrations/0061_suppression_hash_contract.sql
    - packages/db/scripts/rehash-suppressions.ts
    - packages/db/src/__tests__/suppression-hash-migration.test.ts
  modified:
    - packages/contacts-core/src/contact-repository.ts
    - packages/contacts-core/src/index.ts
    - packages/contacts-core/package.json
    - packages/db/src/schema/suppressions.ts
    - packages/db/src/index.ts
    - packages/db/package.json
    - packages/db/migrations/meta/_journal.json
    - package.json
    - apps/api/src/modules/contacts/contact.repository.ts
    - apps/worker/src/queues/webhook-events.worker.ts
    - packages/tenant-context/src/__tests__/tenant-context.test.ts
    - apps/worker/src/queues/__tests__/webhook-events-suppression.test.ts
    - apps/worker/src/queues/__tests__/webhook-events-unsubscribe-convergence.test.ts
    - apps/api/src/modules/contacts/__tests__/contact-erasure.test.ts
    - apps/api/src/modules/contacts/__tests__/subscription-status.test.ts

key-decisions:
  - "Migration 0060/0061 pulled into Task 1's commit for the table-creation half: Task 1's own DB-backed tests (ensureWorkspaceSuppressionKey/loadWorkspaceSuppressionKey against a real workspace_suppression_keys row) cannot pass without the table existing, so the plan's Task-boundary (migration nominally a Task 2 artifact) was adjusted to make each commit's own <verify> actually runnable at that commit."
  - "rehash-suppressions.ts uses the SAME manual SET LOCAL app.current_workspace_id mechanism as count-send-event-duplicates.ts / audit-sends-history.ts, not a literal @mega-crm/tenant-context import -- packages/db has no dependency on that package (by design: it is a standalone operator-CLI connection lifecycle, matching the existing precedent for every other db/scripts/*.ts backfill in this codebase). The plan's acceptance criterion describing this as 'a withTenant/withTenantTransaction scope' is satisfied at the mechanism level (identical BEGIN/SET LOCAL/COMMIT/ROLLBACK shape), not via a new package edge."
  - "Found and fixed during Task 3's own test-writing (not assumed): rehashSuppressionsForWorkspace's original collision-skip logic re-selected and re-counted the same permanently-unhashable row on every subsequent batch (its email_hash never becomes non-null, so the WHERE clause kept matching it), double-counting skippedCollisions and only terminating because of an unrelated 'batchHashed === 0' escape hatch. Fixed by tracking skipped ids in-memory per call and excluding them from later SELECTs, so the loop terminates on a genuinely empty page and each collision is counted exactly once."
  - "workspace_suppressions gains suppressed_at (timestamptz, defaults now()) and source (nullable text) per the plan's explicit DDL instruction, but no write site populates source as of this plan -- there was no corresponding read/write-site instruction pointing at it, and no acceptance criterion tests it. Recorded here rather than silently added: a future plan (13-13/13-14/13-15) may be the intended consumer, or it may prove genuinely unused and be a candidate for later removal."
  - "@mega-crm/kms added as a workspace dependency edge on packages/contacts-core (Task 1) and @mega-crm/contacts-core added as a devDependency edge on packages/db (Task 2, for the backfill script and its migration test) -- both flagged below for plan 13-14's 'zero new dependencies' claim, which needs qualifying to 'zero new EXTERNAL packages, plus these two workspace edges.' kms's own transitive dependency is @aws-sdk/client-kms only (already a transitive cost paid by apps/api and apps/worker, which both already depend on @mega-crm/kms directly)."
  - "Deviation (Rule 1, out of the plan's files_modified list but directly caused by this conversion): apps/worker's webhook-events-suppression.test.ts and webhook-events-unsubscribe-convergence.test.ts, and apps/api's contact-erasure.test.ts, each queried workspace_suppressions.email directly (a plaintext-comparison JOIN, in one case) or asserted a returned .email field. All three broke as a direct, mechanical consequence of the three call sites no longer writing that column -- fixed by comparing/asserting against the hash instead, mirroring isEmailSuppressed's own conversion. The unsubscribe-convergence fix is the more consequential one: its old JOIN on ws.email = c.email would have silently evaluated to zero matches forever post-conversion, making its 'writes zero suppression rows' assertions pass vacuously regardless of what the code under test actually did."

patterns-established:
  - "Compliance hash-not-plaintext: a per-workspace key + normalize-then-HMAC pure module, with a no-key-row short-circuit on the read path and a TTL cache on the unwrap path -- reusable for any future 'prove X happened without recording what X was' requirement."
  - "Expand/backfill/contract migration triplet with a fail-closed contract-side guard using the per-workspace SET LOCAL loop (migration 0057's Step 0 shape) whenever the guard needs to read across a FORCE-RLS table's full tenant population."

requirements-completed: [CMP-04]

coverage:
  - id: D1
    description: "Per-workspace HMAC key (workspace_suppression_keys) envelope-encrypted via @mega-crm/kms, with a TTL cache and a no-key-row short-circuit"
    requirement: CMP-04
    verification:
      - kind: unit
        ref: "packages/contacts-core/src/__tests__/suppression-hash.test.ts"
        status: pass
      - kind: unit
        ref: "packages/kms (existing suite, unaffected)"
        status: pass
    human_judgment: false
  - id: D2
    description: "All three suppression read/write sites (isEmailSuppressed, deleteContact insert, applySuppression insert) converted to write/compare only the hash, case-insensitively"
    requirement: CMP-04
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/webhook-events-suppression.test.ts"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/contact-erasure.test.ts"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/subscription-status.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "Expand (0060) / backfill (rehash-suppressions.ts) / contract (0061, fail-closed) migration sequence: no plaintext survives, no partially-converted state reaches the send pipeline"
    requirement: CMP-04
    verification:
      - kind: integration
        ref: "packages/db/src/__tests__/suppression-hash-migration.test.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "Dev-database migrate/backfill/migrate operator sequence (Task 3's human-check): apply through 0060, run npm run db:rehash-suppressions, apply 0061, then confirm a previously-suppressed address is refused on create and workspace_suppressions holds no readable address"
    verification: []
    human_judgment: true
    rationale: "This is the plan's own <human-check> verify step -- it requires a live dev database an operator applies migrations to, which this execution did not have access to (only ephemeral CI-style test databases). The full sequence is proven equivalently by suppression-hash-migration.test.ts's full-sequence test against a real (ephemeral) Postgres, but the plan explicitly separates this as a human-check step and it has not been run by a human against a real dev database."

duration: ~85min
completed: 2026-08-12
status: complete
---

# Phase 13 Plan 12: Suppression list hashing (CMP-04 evidence hygiene) Summary

**Replaced `workspace_suppressions`' plaintext email column with a per-workspace-keyed HMAC-SHA256 hash, via an expand/backfill/contract migration triplet, converting all three read/write sites and closing the last plaintext-survival gap left by plan 13-10's contact erasure.**

## Performance

- **Duration:** ~85 min
- **Tasks:** 3 completed
- **Files modified:** 20 (7 created, 13 modified)

## Accomplishments

- A per-workspace HMAC key (`workspace_suppression_keys`), envelope-encrypted via `@mega-crm/kms` exactly like tenant SendGrid keys, with a 5-minute in-process TTL cache of unwrapped key material and a no-key-row-means-nothing-suppressed short-circuit that keeps the pre-send/pre-create suppression check free of KMS work for the common case.
- A pure `normalizeSuppressionEmail`/`hashSuppressionEmail` module (`packages/contacts-core/src/suppression-hash.ts`) -- lowercases and trims but deliberately does NOT apply Gmail-style dot/plus-tag aliasing, matching `contacts.email`'s own (non-)normalization so the same person can't be suppressed under one form and re-created under another.
- All three confirmed call sites (`isEmailSuppressed`, `deleteContact`'s suppression insert, `applySuppression`'s suppression insert) converted in one change to write/compare only the hash -- grep confirms no remaining INSERT supplying a value for the `email` column anywhere in `apps`/`packages`.
- An expand (0060) / backfill (`npm run db:rehash-suppressions`) / contract (0061) migration sequence: 0061 fails closed with a per-workspace `SET LOCAL` loop guard (the same shape migration 0057's Step 0 uses, required because `workspace_suppressions` carries FORCE ROW LEVEL SECURITY) if any row still lacks a hash, and only then drops the plaintext column entirely.
- The backfill script is idempotent, pages in bounded batches, and defensively skips (rather than crashes on) a case/whitespace collision between two pre-existing plaintext rows that would otherwise violate the new `(workspace_id, email_hash)` unique index.

## Task Commits

1. **Task 1: Per-workspace suppression key and the pure normalize-and-hash function** - `f2061f2` (feat)
2. **Task 2: Expand the column, convert every call site, and backfill existing rows** - `2de06a1` (feat)
3. **Task 3: Contract the column fail-closed, and apply the full sequence** - `86bcf31` (feat)

**Plan metadata:** (this commit)

## Files Created/Modified

- `packages/contacts-core/src/suppression-hash.ts` - normalize/hash pure functions + per-workspace key lifecycle (create/load/cache)
- `packages/contacts-core/src/__tests__/suppression-hash.test.ts` - 11 tests: pure functions, no-key-row short-circuit, get-or-create idempotency, buffer zeroing (happy + error path), TTL cache hit/expiry, cross-workspace divergence
- `packages/db/src/schema/workspace-suppression-keys.ts` - Drizzle table for the new key table
- `packages/db/migrations/0060_suppression_hash_expand.sql` - creates workspace_suppression_keys; adds email_hash/suppressed_at/source to workspace_suppressions, makes email nullable, adds the new unique index
- `packages/db/migrations/0061_suppression_hash_contract.sql` - fail-closed guard, email_hash NOT NULL, drops the old constraint and the email column
- `packages/db/scripts/rehash-suppressions.ts` - discover-on-scan/work-per-workspace backfill, registered as `db:rehash-suppressions`
- `packages/db/src/__tests__/suppression-hash-migration.test.ts` - 13 tests: empty-table trivial pass, fail-closed guard + resolution, batching/idempotency, collision-skip path, full seed-expand-backfill-contract sequence
- `packages/contacts-core/src/contact-repository.ts` - `isEmailSuppressed` converted to hash comparison with the no-key-row short-circuit
- `apps/api/src/modules/contacts/contact.repository.ts` - `deleteContact`'s suppression insert converted to write only the hash
- `apps/worker/src/queues/webhook-events.worker.ts` - `applySuppression`'s insert converted to write only the hash
- `packages/db/src/schema/suppressions.ts` - Drizzle schema updated to the final (post-0061) shape
- `packages/tenant-context/src/__tests__/tenant-context.test.ts` - workspace_isolation policy count bumped 26 -> 27
- `apps/worker/src/queues/__tests__/webhook-events-suppression.test.ts` - suppression-row helper converted to hash lookup; added a case-insensitive isEmailSuppressed test
- `apps/worker/src/queues/__tests__/webhook-events-unsubscribe-convergence.test.ts` - suppression-row-count helper converted to hash lookup (its old plaintext JOIN would have passed vacuously post-conversion)
- `apps/api/src/modules/contacts/__tests__/contact-erasure.test.ts` - suppression-row helper converted to hash lookup
- `apps/api/src/modules/contacts/__tests__/subscription-status.test.ts` - added a case-insensitive-suppression HTTP-level test
- `packages/contacts-core/package.json`, `packages/db/package.json`, `package.json` - new dependency edge and `db:rehash-suppressions` npm script

## Decisions Made

See `key-decisions` in frontmatter. Summarized:
- Migration 0060 was pulled into Task 1's own commit (table creation only needed to make Task 1's tests runnable); Task 2's commit then added the column-set/call-site/backfill half of the same migration file plus the conversion work.
- `rehash-suppressions.ts` replicates the `SET LOCAL app.current_workspace_id` mechanism directly (matching `count-send-event-duplicates.ts`'s precedent) rather than adding a `@mega-crm/tenant-context` dependency to `packages/db`.
- A real double-counting bug in the backfill's collision-skip path was found and fixed while writing Task 3's migration test (see key-decisions).
- `source` column added per the migration's explicit DDL instruction but left unpopulated by every write site in this plan -- flagged, not silently dropped.
- Two new workspace dependency edges (`@mega-crm/kms` on `contacts-core`, `@mega-crm/contacts-core` on `db`) recorded for plan 13-14's "zero new dependencies" claim to qualify.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed suppression-assertion breakage in three test files not in the plan's files_modified list**
- **Found during:** Task 2
- **Issue:** `webhook-events-suppression.test.ts`'s and `contact-erasure.test.ts`'s suppression-row helpers queried `workspace_suppressions.email` directly, and `webhook-events-unsubscribe-convergence.test.ts`'s helper JOINed on `ws.email = c.email` -- all three broke (or, worse, silently passed vacuously) once the three write sites stopped populating that column.
- **Fix:** Converted each helper to compute the expected hash (via `loadWorkspaceSuppressionKey`/`hashSuppressionEmail`/`normalizeSuppressionEmail`) and compare/query by `email_hash` instead.
- **Files modified:** `apps/worker/src/queues/__tests__/webhook-events-suppression.test.ts`, `apps/worker/src/queues/__tests__/webhook-events-unsubscribe-convergence.test.ts`, `apps/api/src/modules/contacts/__tests__/contact-erasure.test.ts`
- **Verification:** All three files' full suites pass (11, 8, and 19 tests respectively).
- **Committed in:** `2de06a1` (Task 2 commit)

**2. [Rule 1 - Bug] Fixed a double-counting bug in the backfill's collision-skip path**
- **Found during:** Task 3, while writing the collision-scenario test
- **Issue:** `rehashSuppressionsForWorkspace` re-selected and re-counted the same permanently-unhashable (colliding) row on every subsequent batch, since its `email_hash` never becomes non-null and the `WHERE email_hash IS NULL` clause kept matching it -- the loop only terminated via an unrelated `batchHashed === 0` escape hatch, after over-counting `skippedCollisions`.
- **Fix:** Track skipped row ids in-memory for the duration of one call and exclude them from every subsequent SELECT, so the loop terminates on a genuinely empty page and each collision is counted exactly once.
- **Files modified:** `packages/db/scripts/rehash-suppressions.ts`
- **Verification:** `suppression-hash-migration.test.ts`'s collision-scenario tests pass with the corrected counts.
- **Committed in:** `86bcf31` (Task 3 commit)

---

**Total deviations:** 2 auto-fixed (both Rule 1 bug fixes)
**Impact on plan:** Both fixes were necessary for correctness -- the first prevents pre-existing tests from either failing or (worse) passing vacuously; the second fixes a genuine counting/termination bug in new code written for this plan. No scope creep beyond what the conversion itself required.

## Issues Encountered

- Task boundary friction: Task 1's plan text places the migration file under Task 2's `files_modified`, but Task 1's own acceptance criteria require DB-backed tests against the real `workspace_suppression_keys` table. Resolved by creating migration 0060 (the table-creation portion) as part of Task 1's commit -- documented above as a key-decision rather than a deviation, since no plan requirement was skipped or changed, only which commit a shared artifact landed in.
- `@mega-crm/test-support`'s `buildTestRoleDsn` is not re-exported from its package root (only `buildRoleDsn` is) -- used the lower-level `buildRoleDsn` with the explicit `mega_crm_dev_pw` password, mirroring `send-events-dedup-rebase.test.ts`'s own precedent for constructing a scan-role test pool.

## User Setup Required

None - no external service configuration required. One outstanding **operator action** for real environments: on any dev/staging database carrying pre-13-12 suppression rows, run `npm run db:rehash-suppressions` after applying migration 0060 and before applying 0061 -- 0061 will otherwise refuse to apply (by design).

## Next Phase Readiness

- CMP-04's evidence-hygiene half (D-02) is closed: no plaintext email address survives in `workspace_suppressions` after this plan, and every read/write site is converted.
- Plan 13-14 should read the `@mega-crm/kms` (contacts-core) and `@mega-crm/contacts-core` (db) dependency edges recorded above and qualify its "zero new dependencies" claim accordingly.
- Outstanding, not part of this plan's scope (see RESEARCH.md assumption A2 in the plan's own `<flagged_assumptions>`): the AWS-KMS hot-path load-test comparing the suppression-check TTL-cache behavior against Phase 12's `loadtest:tenant-rps` remains unrun. The local KMS provider used in dev/test has no network round trip, so this risk is invisible until an AWS-backed environment is load-tested.
- Task 3's `<human-check>` verify step (apply through 0060, run the backfill, apply 0061, confirm a suppressed address is refused and no readable address remains) was not run against a live dev database during this execution -- only against ephemeral CI-style test databases via `suppression-hash-migration.test.ts`'s full-sequence test, which proves the same guarantee mechanically. Flagged as `human_judgment: true` (D4) in the coverage block above.

## Known Stubs

None. `source` (text, nullable) on `workspace_suppressions` is a schema column with no current writer -- not a UI/behavior stub, but flagged in key-decisions for a future plan to either wire up or remove.

---
*Phase: 13-compliance-analytics-integrity*
*Completed: 2026-08-12*
