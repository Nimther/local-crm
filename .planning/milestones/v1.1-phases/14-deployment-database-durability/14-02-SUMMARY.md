---
phase: 14-deployment-database-durability
plan: 02
subsystem: database
tags: [postgres, drizzle, migrations, better-auth, rls, constraints]

requires:
  - phase: 10-tenant-isolation-trust-boundaries
    provides: mega_crm_auth/mega_crm_scan role separation and grants (migration 0045) this plan's connection-role decision is derived from
  - phase: 13-compliance-analytics-integrity
    provides: migration 0057's fail-closed duplicate-guard + indisvalid-assert pattern, cited and reused verbatim here
provides:
  - Live pg_constraint/pg_index/pg_class introspection script (audit-missing-constraints.ts) covering application-owned and Better Auth tables
  - Read-only + --resolve duplicate-count script for member(organizationId, userId) (count-member-duplicates.ts)
  - Migration 0062: enforced, validated unique constraint on member(organizationId, userId)
  - Recorded, evidence-based decision to defer an invitation(organizationId, email) partial-unique constraint
affects: [14-05 (drizzle-kit generate empty-diff gate), 14-13 (SPECIFICATION.md consolidation)]

tech-stack:
  added: []
  patterns:
    - "Live pg_constraint/pg_index audit before trusting a static schema read for a missing-constraint inventory"
    - "Connection role for a script is decided from grep'd GRANT statements, not assumed from table domain"
    - "Index and the constraint that promotes it share one literal name, sidestepping ADD CONSTRAINT ... USING INDEX's silent rename"

key-files:
  created:
    - packages/db/scripts/audit-missing-constraints.ts
    - packages/db/scripts/count-member-duplicates.ts
    - packages/db/migrations/0062_member_unique_org_user.sql
    - packages/db/src/__tests__/migration-0062-member-unique.test.ts
  modified:
    - packages/db/package.json
    - packages/db/migrations/meta/_journal.json
    - packages/db/src/schema/auth.ts

key-decisions:
  - "audit-missing-constraints.ts uses DATABASE_URL/mega_crm_app: it reads only pg_catalog (PUBLIC-readable), no table grant needed"
  - "count-member-duplicates.ts uses AUTH_DATABASE_URL/mega_crm_auth: migration 0045 revokes DELETE on member from mega_crm_app (SELECT-only) and grants full CRUD only to mega_crm_auth"
  - "No per-workspace loop for member: it carries no RLS at all (migration 0045's own header), unlike send_events (FORCE RLS), so a single unscoped query is correct"
  - "member_organization_user_unique names BOTH the index and the constraint, verified empirically that Postgres accepts this with no rename ambiguity"
  - "invitation(organizationId, email) constraint deferred as an audited-and-deliberately-not-changed finding, not added on a guess -- see Decisions Made"

requirements-completed: [DB-12]

coverage:
  - id: D1
    description: "Live pg_constraint/pg_index/pg_class audit script covering contacts, workspace_sendgrid_keys, workspace_send_settings, session, organization, user, member, invitation -- confirms member and invitation each carry only their primary key"
    requirement: "DB-12"
    verification:
      - kind: integration
        ref: "npm run db:audit-missing-constraints -w packages/db (run against dev DB migrated through 0061; output recorded below)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Read-only + --resolve duplicate-count tooling for member(organizationId, userId), modeled on migration 0057's count-send-event-duplicates.ts"
    requirement: "DB-12"
    verification:
      - kind: unit
        ref: "packages/db/src/__tests__/migration-0062-member-unique.test.ts#the fail-closed duplicate guard, and resuming after --resolve"
        status: pass
      - kind: unit
        ref: "packages/db/src/__tests__/migration-0062-member-unique.test.ts#role-difference warning (findRoleWarnings/resolveAllDuplicates)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Migration 0062: member(organizationId, userId) unique constraint, fail-closed duplicate guard, indisvalid assertion, Drizzle schema parity"
    requirement: "DB-12"
    verification:
      - kind: unit
        ref: "packages/db/src/__tests__/migration-0062-member-unique.test.ts (14/14 tests, both TDD RED and GREEN runs recorded)"
        status: pass
      - kind: unit
        ref: "npx vitest run --root packages/db (152/152 tests)"
        status: pass
      - kind: other
        ref: "npm run lint:migrations (63 files, no violations)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Migration 0062 applied to the operator's live development database"
    human_judgment: true
    rationale: "Cannot be automated in this worktree -- npm run migrate:prod (plan 14-01's deliverable) does not exist here; hand-applying via psql would skip __drizzle_migrations bookkeeping and is explicitly forbidden. Operator must run the exact command recorded below once plan 14-01 has landed."

duration: 58min
completed: 2026-08-13
status: complete
---

# Phase 14 Plan 02: Live constraint audit and member(organizationId, userId) unique constraint Summary

**Live pg_constraint introspection proved `member` was the one confirmed missing-constraint gap; migration 0062 closes it with a fail-closed duplicate guard, a blocking unique index, and an `indisvalid` assertion, following migration 0057's proven shape.**

## Performance

- **Duration:** ~58 min
- **Started:** 2026-08-12T23:16:04+05:00 (worktree base commit)
- **Completed:** 2026-08-13T00:14:16+05:00
- **Tasks:** 2 (Task 2 executed as RED → GREEN under `tdd="true"`)
- **Files modified:** 7 (4 created, 3 modified)

## Accomplishments

- Live `pg_constraint`/`pg_index`/`pg_class` audit (`audit-missing-constraints.ts`) run against the dev database (migrated through 0061) confirms `member` and `invitation` each carry only their primary key — no unique constraint beyond it. Every other audited table (`contacts`, `workspace_sendgrid_keys`, `workspace_send_settings`, `session`, `organization`, `user`) already has the uniqueness `packages/db/src/schema/*.ts` declares, and every existing unique index reports `indisvalid=true`.
- `count-member-duplicates.ts` (read-only + `--resolve`) reports **0** duplicate `(organizationId, userId)` groups in the dev database today — the constraint applies cleanly with no cleanup needed.
- Migration 0062 adds `member_organization_user_unique`, a named, validated unique constraint on `member(organizationId, userId)`, backed by a blocking `CREATE UNIQUE INDEX` (not `CONCURRENTLY` — not expressible in this repo's one-transaction-per-migration-file model, per migration 0057's own documented finding) and asserted valid via `pg_index.indisvalid` (Pitfall 17). The Drizzle schema (`packages/db/src/schema/auth.ts`) declares the identical constraint by the identical name.
- `invitation(organizationId, email)` audited and evidence shows an unqualified unique constraint would be wrong; recorded as a deliberate non-change (see Decisions Made) rather than added on a guess.

## Task Commits

Each task was committed atomically:

1. **Task 1: Prove what is missing (live introspection) and how much data blocks it** — `392c0ca` (feat)
2. **Task 2: Migration 0062 — RED** — `19de21b` (test)
3. **Task 2: Migration 0062 — GREEN** — `ac6ed8a` (feat)

**Plan metadata:** (this commit, immediately following)

_TDD: Task 2 ran RED (11/14 failing on the absent migration file, 3 vacuously-passing orthogonal-insert cases) → GREEN (14/14 passing). One test-only bug found and fixed during GREEN — see Deviations._

## Files Created/Modified

- `packages/db/scripts/audit-missing-constraints.ts` — read-only `pg_constraint`/`pg_index`/`pg_class` report across 8 tables, using `DATABASE_URL`/`mega_crm_app` (catalog reads need no table grant)
- `packages/db/scripts/count-member-duplicates.ts` — read-only report + `--resolve` for `member` duplicates, using `AUTH_DATABASE_URL`/`mega_crm_auth` (the only role with `DELETE` on `member`)
- `packages/db/migrations/0062_member_unique_org_user.sql` — the constraint migration itself
- `packages/db/src/__tests__/migration-0062-member-unique.test.ts` — 14 tests covering fresh apply, the fail-closed guard + resolve-then-resume path, role-difference warnings, and the migration's static shape
- `packages/db/package.json` — registers `db:audit-missing-constraints`, `db:count-member-duplicates`, `db:resolve-member-duplicates`
- `packages/db/migrations/meta/_journal.json` — idx 62 entry
- `packages/db/src/schema/auth.ts` — `member` table gains `unique("member_organization_user_unique").on(t.organizationId, t.userId)`

## Live audit output (dev DB, migrated through 0061)

```
contacts:
  primary key contacts_pkey (id) -- indisvalid=true
  unique      contacts_workspace_email_unique (workspace_id, email) -- indisvalid=true
  unique      contacts_workspace_external_id_unique (workspace_id, external_id) -- indisvalid=true
workspace_sendgrid_keys:
  primary key workspace_sendgrid_keys_pkey (workspace_id) -- indisvalid=true
workspace_send_settings:
  primary key workspace_send_settings_pkey (workspace_id) -- indisvalid=true
session:
  primary key session_pkey (id) -- indisvalid=true
  unique      session_token_unique (token) -- indisvalid=true
organization:
  primary key organization_pkey (id) -- indisvalid=true
  unique      organization_slug_unique (slug) -- indisvalid=true
user:
  unique      user_email_unique (email) -- indisvalid=true
  primary key user_pkey (id) -- indisvalid=true
member:
  primary key member_pkey (id) -- indisvalid=true   <-- the DB-12 gap, closed by this plan
invitation:
  primary key invitation_pkey (id) -- indisvalid=true   <-- audited, deliberately not changed (see below)
```

`db:count-member-duplicates` against the same database: `TOTAL: 0 group(s), 0 row(s) to resolve`. A direct query against `invitation` for duplicate `pending`-status `(organizationId, email)` pairs also returned 0 rows.

## Decisions Made

**Connection role for each script**, established from the grants (not assumed):
- `audit-missing-constraints.ts` reads only `pg_catalog` system tables — never a data row — so no table-level `GRANT` is relevant; Postgres grants `SELECT` on every `pg_catalog` relation to `PUBLIC`. Uses `DATABASE_URL`/`mega_crm_app` as the plainest already-required connection.
- `count-member-duplicates.ts` needs `SELECT` **and** `DELETE` on `member`. Migration 0045 revokes all privileges on `member` from `mega_crm_app` and re-grants only `SELECT` (line 70); `mega_crm_auth` holds `SELECT, INSERT, UPDATE, DELETE` (line 43), because better-auth's own adapter performs the full range of data manipulation on it. Uses `AUTH_DATABASE_URL`/`mega_crm_auth`.
- Neither script loops per-workspace the way migration 0057's own duplicate guard does for `send_events`: `member`/`invitation` carry **no row-level security at all** (migration 0045's header: "RLS is deliberately NOT used here" for the seven better-auth tables) — there is no fail-closed GUC to satisfy and no reason to iterate `organization` one row at a time. `send_events`'s per-workspace loop exists specifically because it is `FORCE ROW LEVEL SECURITY`, a genuinely different situation.

**`invitation(organizationId, email)` deferred — evidence, not a guess.** Read `apps/api/src/modules/tenancy/invites.ts` and better-auth's own `organization/routes/crud-invites.mjs`:
- Better-auth's `createInvitation` route already calls `adapter.findPendingInvitation(...)` and throws `USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION` if a **pending** invite already exists for that `(organizationId, email)`, unless the caller passes `resend: true` (which updates the existing row) — so a second **pending** invite for the same pair is already prevented at the application layer today.
- After an invite is declined, expired, or accepted (any non-`pending` status), a genuinely **new** invitation row is created for a re-invite. This is legitimate, existing behavior this platform depends on.
- Therefore an **unqualified** `UNIQUE(organizationId, email)` would be provably wrong — it would reject every legitimate re-invite after decline/expiry/accept, which currently succeeds. The only defensible shape is a **partial** unique index `WHERE status = 'pending'`, hardening the app's own (currently TOCTOU-prone, read-then-write) invariant with a real database constraint.
- Live evidence: 0 existing duplicate-pending pairs in the dev database today, so nothing currently blocks adding that partial index.
- **Deferred anyway**, because it needs its own duplicate-count-and-resolve tooling and test infrastructure (mirroring this plan's `member` work) that is outside this plan's `files_modified` scope — this plan's artifacts list names only `member`'s constraint. Recorded here as the audited, evidence-based, deliberate non-change the plan's action text explicitly permits ("either outcome is a recorded decision; silence is not"). A future plan should add: a `count-invitation-duplicates.ts` script scoped to `status = 'pending'`, and a migration adding `CREATE UNIQUE INDEX ... ON invitation (organizationId, email) WHERE status = 'pending'`.

**Index/constraint naming.** Verified empirically against a scratch table on this project's own Postgres 17.10: `ALTER TABLE ... ADD CONSTRAINT x UNIQUE USING INDEX y` renames the index to `x` whenever `x != y`. To avoid ambiguity about which name the `indisvalid` assertion should target, the index and the constraint share one literal name (`member_organization_user_unique`) from the start — Postgres accepts this with no rename notice.

**CONCURRENTLY deviation** (documented in the plan and repeated in the migration's own header, per the plan's instruction): the ROADMAP/CONTEXT.md text names `CREATE UNIQUE INDEX CONCURRENTLY`. This is not expressible in this repo's migration model — each file runs as one `client.query(sql)` call, which Postgres's simple-query protocol wraps in one implicit transaction end-to-end, and `CONCURRENTLY` cannot run inside a transaction block. Migration 0057 already discovered and documented this; this migration follows the same resolution (blocking build + `indisvalid` assertion) rather than re-deriving it. `member` is small, unpartitioned, and has no per-tenant write-blocking window to reason about (unlike `send_events`), so the blocking build costs milliseconds. The guarantee the ROADMAP asked for (no INVALID, non-enforcing index) is delivered in full; only the mechanism differs, for a reason this repository already documented.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `pg` does not auto-parse `name[]` array results**
- **Found during:** Task 1, first live run of `audit-missing-constraints.ts` against the dev DB
- **Issue:** `array(SELECT attname FROM pg_attribute ...)` returned a raw Postgres array-literal string (`"{id}"`) instead of a parsed JS array, because `pg`'s default type-parser table does not cover `name[]` (OID 1003); `formatReport`'s `c.columns.join(", ")` threw `TypeError: c.columns.join is not a function`.
- **Fix:** Cast to `attname::text` inside the subquery, which node-postgres does auto-parse as a JS array.
- **Files modified:** `packages/db/scripts/audit-missing-constraints.ts`
- **Verification:** Re-ran `npm run db:audit-missing-constraints -w packages/db` — clean output for all 8 tables.
- **Committed in:** `392c0ca` (Task 1 commit)

**2. [Rule 1 - Bug] Test's own `firstDoIndex`/`firstCreateIndex` search hit a false positive**
- **Found during:** Task 2, first GREEN test run
- **Issue:** `migration-0062-member-unique.test.ts`'s static-shape test searched the raw (non-comment-stripped) migration file for the first `"CREATE UNIQUE INDEX"` occurrence to assert it comes after the guard block — but this migration's own header prose (the CONCURRENTLY-deviation note) mentions `CREATE UNIQUE INDEX` before the real DDL statement, so the raw search found the prose mention first and the ordering assertion failed on a correct migration.
- **Fix:** Search the comment-stripped SQL instead (same `stripLineComments` helper the adjacent CONCURRENTLY test already used).
- **Files modified:** `packages/db/src/__tests__/migration-0062-member-unique.test.ts`
- **Verification:** All 14 tests pass.
- **Committed in:** `ac6ed8a` (Task 2 GREEN commit)

---

**Total deviations:** 2 auto-fixed (both Rule 1 — bugs discovered while running the code, not scope creep).
**Impact on plan:** Both fixes were necessary for the scripts/tests to run at all; no functional scope change.

## Issues Encountered

**Pre-existing, out-of-scope build failure discovered during verification (not caused by this plan):** `npm run build --workspaces --if-present` fails in `@mega-crm/test-support` — `tsc` reports `Module '"../../../../scripts/lint-migrations.mjs"' has no exported member 'checkStatementBreakpointPlacement'` in `packages/test-support/src/__tests__/migration-lint.test.ts`, even though that export exists in the source file (confirmed by direct read) and neither file has any diff between this plan's commits and the worktree's base commit (`a2c593d`). Not fixed — out of scope per the Scope Boundary rule (unrelated files, pre-existing at the base commit this worktree started from). `npm run lint` (eslint) passes cleanly on its own. Flagging here since `.planning/WINDOWS.md` is off-limits in this worktree per repo-specific rules.

## User Setup Required

None — no external service configuration required.

**Operator action required before this migration takes effect:** `npm run migrate:prod` (plan 14-01's deliverable, `scripts/migrate-runner.mjs`) does not exist in this worktree — plan 14-01 runs in a parallel wave-1 worktree and has not landed here. Migration 0062 is therefore **not yet applied** to the development database (currently at migration 0061, confirmed via `SELECT count(*) FROM drizzle.__drizzle_migrations` = 62 rows = migrations 0000–0061). Per this plan's own instruction, it was **not** hand-applied via `psql` (would skip `__drizzle_migrations` bookkeeping and poison a later `migrate:prod` run) and the `drizzle-kit` CLI was **not** used as a fallback (documented in STATE.md to hang under this sandbox's Node v26).

**Exact command for the operator, once plan 14-01 has landed:**
```
npm run migrate:prod
```
This will apply migration 0062 (and any other pending migrations) via the programmatic `drizzle-orm migrate()` runner plan 14-01 introduces.

## SPECIFICATION.md items for 14-13

(Not written to `SPECIFICATION.md` in this worktree per the phase's repo-specific rules — filing deferred to plan 14-13.)

- **§4 Схема данных:** new migration `0062_member_unique_org_user.sql` — adds constraint `member_organization_user_unique` (UNIQUE on `member.organizationId, member.userId`), backed by a validated index of the same name. **Not yet applied to the dev database** — see "User Setup Required" above; note this caveat when filing.
- **§4 Схема данных (audited, no change):** `invitation(organizationId, email)` audited and found to lack a partial-unique constraint on pending invites — deliberately deferred (see Decisions Made above); mention as an open follow-up if 14-13's audit surfaces it.
- No new npm package, no new environment variable, no new HTTP route, no new queue/worker — only new `packages/db` scripts (`db:audit-missing-constraints`, `db:count-member-duplicates`, `db:resolve-member-duplicates`) using already-pinned `pg`/`tsx`, which the threat model (T-14-SC) already accounted for as "no package installed."

## Next Phase Readiness

- Migration 0062 is written, tested (14/14 unit tests, full 152/152 package suite), lint-clean, and its Drizzle schema counterpart is in place — ready for plan 14-05's `drizzle-kit generate` empty-diff gate once applied.
- Blocker for full closure: the migration is not yet applied to the dev database, pending plan 14-01's `migrate:prod` runner landing in the merged tree. This is expected sequencing (14-01 and 14-02 are both wave-1, parallel, independent plans) and not a defect in this plan's own work.

---
*Phase: 14-deployment-database-durability*
*Completed: 2026-08-13*
