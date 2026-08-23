---
phase: 22-workspace-quiesce-physical-purge
verified: 2026-08-23T20:19:01Z
status: gaps_found
score: 4/5 must-haves verified
behavior_unverified: 0
overrides_applied: 0
gaps:
  - truth: "Once retention has elapsed, the workspace's PII across every tenant table is deleted or anonymized and its secrets are gone, while the compliance evidence required to outlive the tenant is still present and readable."
    status: failed
    reason: "`dead_letter_jobs.payload` (migration 0054, Phase 12) can carry raw contact PII from any terminally-failed job across any queue (events:ingest freeform `properties`, `testTo` raw recipient address, `externalId`, `firstName`/`lastName`). The shared `scrub()` redaction (packages/redaction/src/rules.ts) only matches a fixed key-name list and a handful of value-shape regexes (email/phone/SendGrid-key patterns) -- it has no rule for `firstName`/`lastName`/`externalId`/`testTo`, and no way to redact the same unbounded freeform-properties problem docs/PII-INVENTORY.md itself treats as too dangerous to allowlist for `events.properties`. The table has no `workspace_id` column at all (confirmed in packages/db/src/schema/dead-letter-jobs.ts), so a purge tick cannot scope a delete to one tenant even if it tried. It is absent from PURGE_TABLE_ORDER, absent from PURGE_EVIDENCE_TABLES, and not named anywhere in docs/PII-INVENTORY.md's Included or Excluded tables (verified via grep -- zero matches), nor in docs/runbooks/workspace-purge-and-restore.md's four-row 'what survives, and why' table. This was never surfaced as a deliberate exception in 22-RESEARCH.md either -- the research only cites dead_letter_jobs as a structural precedent (non-RLS platform table pattern), never as a PII risk to be reconciled. This directly contradicts the phase's own stated goal that a purged workspace's PII is 'gone.'"
    artifacts:
      - path: "packages/db/src/schema/dead-letter-jobs.ts"
        issue: "No workspace_id column; not in any purge table list"
      - path: "packages/db/src/workspace-purge-tables.ts"
        issue: "PURGE_TABLE_ORDER/PURGE_EVIDENCE_TABLES do not mention dead_letter_jobs"
      - path: "docs/PII-INVENTORY.md"
        issue: "dead_letter_jobs absent from both Included and Excluded tables sections"
      - path: "packages/queue-core/src/dead-letter-writer.ts"
        issue: "scrub() call has no coverage for firstName/lastName/externalId/testTo/freeform properties"
    missing:
      - "Either add dead_letter_jobs to a documented, workspace-scoped purge step (requires a workspace_id column, backfilled from payload.workspaceId where derivable), or document an explicit retention/deletion policy for dead-letter rows on their own timer and record the table in PII-INVENTORY.md's Excluded tables section with the stated reason, reconciling the runbook's survivor table in the same change (per CLAUDE.md's same-change rule)."
  - truth: "The pre-destruction per-table row census in purge_records.table_counts is an immutable compliance record, written once and never overwritten."
    status: failed
    reason: "recordAuthPurgeCounts (apps/worker/src/queues/workspace-purge-checkpoint.ts:130-142) does an unconditional `table_counts || jsonb_build_object(...)` merge with no write-once guard. The auth step's tail is three separate statements: (1) deleteWorkspaceAuthRows commits on the mega_crm_auth pool, (2) recordAuthPurgeCounts writes counts on the platform pool, (3) markPurgeTableDone appends the 'auth' marker. A process kill between (1) and (2)/(3) leaves the 'auth' marker absent from completed_tables; the next tick re-enters the block, deletes zero rows (already gone), and recordAuthPurgeCounts overwrites (or first-writes) table_counts.member/invitation with 0 -- destroying the real destroyed-row counts this same file's own doc comment calls an invariant ('written once ... and never overwritten afterward'). Verified directly in code (not just cited from review): the merge is a bare `||`, and the existing kill-resume regression suite (workspace-purge-resume.test.ts) only freezes strictly before the auth step begins ('kill before the tail') or after the whole tick completes -- no case exercises the window between the auth delete's commit and the checkpoint write, so this gap has zero regression coverage."
    artifacts:
      - path: "apps/worker/src/queues/workspace-purge-checkpoint.ts"
        issue: "recordAuthPurgeCounts merge is not write-once/idempotent under a crash between auth delete and count write"
    missing:
      - "Make the merge write-once (only set member/invitation keys if absent), or capture counts atomically with the delete on the auth pool before returning to the platform-pool caller. Add a kill-resume case that freezes strictly between the auth delete's commit and recordAuthPurgeCounts."
---

# Phase 22: Workspace Quiesce & Physical Purge Verification Report

**Phase Goal:** A soft-deleted workspace stops sending immediately and, after the platform retention window, physically ceases to exist — its PII and secrets gone, its neighbours untouched, and the compliance evidence that must outlive a tenant still intact.
**Verified:** 2026-08-23T20:19:01Z
**Status:** gaps_found
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A soft-deleted workspace stops sending immediately: no further mail after soft delete. | ✓ VERIFIED | `isWorkspaceSoftDeleted`/`isWorkspaceSoftDeletedById` wired at all send/ingest surfaces: `send-dispatch.ts:332,652` (fresh re-read on every claim attempt), `flows/flow-send.ts:147`, `campaign-kickoff.worker.ts:62`, `api-key-auth.ts:117`, `webhooks.routes.ts:149`. Every quiesce path also confirmed to call `recordExcluded`/`recordFlowExcluded` (never silently ack) rather than dropping the job untracked, and the test-send path (no `sends` row by design) logs the refusal instead of attempting an exclusion write against a row that doesn't exist. Substantive test coverage: `webhooks-quiesce.test.ts` (4 cases incl. "signature verification is not reached"), `events-api-quiesce.test.ts` (4 cases). |
| 2 | Once retention elapses, PII across every tenant table is deleted/anonymized, secrets are gone, compliance evidence intact and readable. | ✗ FAILED | `PURGE_TABLE_ORDER`/`PURGE_SECRET_TABLES`/`PURGE_EVIDENCE_TABLES` (`packages/db/src/workspace-purge-tables.ts`) are thorough and reconciled table-by-table against `docs/PII-INVENTORY.md` for every table that document names; the three evidence tables (`erasure_records`, `workspace_suppressions`, `workspace_daily_rollup`) plus `purge_records` itself are confirmed excluded from the destructive walk. But `dead_letter_jobs` — a table proven capable of holding raw, imperfectly-scrubbed contact PII (no `workspace_id` column, absent from every purge list and from PII-INVENTORY.md's Included/Excluded sections) — is untouched and undocumented. Additionally, `recordAuthPurgeCounts` can overwrite the immutable `table_counts` compliance census with zeros in a real (if narrow) crash window. See gaps. |
| 3 | A purge killed mid-run (real SIGKILL) resumes and completes; re-running a finished purge changes nothing and fails nothing. | ✓ VERIFIED | `apps/worker/src/queues/__tests__/failure-injection/workspace-purge-resume.test.ts` — 7 real-SIGKILL cases: mid-batch, counts-match-uninterrupted-run, counts-match-census, kill-between-tables, kill-before-tail, resume-does-not-re-walk, double-resume. Confirmed real (not simulated) kill: `spawnAndKillOnReady` asserts `exit.signal === "SIGKILL"` against a real child process. Orchestrator evidence: `npm run failure:workspace-purge-resume` 7/7 pass on merged tree. (The one gap in this guarantee — the auth-step count-overwrite window — is reported under truth 2, since its effect is on evidence integrity, not on whether the purge itself resumes/completes.) |
| 4 | Another workspace's rows in the same monthly partitions are provably unchanged after a purge (negative test); no DROP/DETACH/TRUNCATE. | ✓ VERIFIED | `workspace-purge-neighbour-safety.test.ts`: "neighbour rows unchanged... byte-identical", "purge count is A's alone", "no structural partition operation", "concurrent neighbour write is not blocked", "a locked row is retried, not lost". `grep` for DROP/DETACH/TRUNCATE in purge code returns only doc-comment mentions of what is never issued. RLS (`FORCE ROW LEVEL SECURITY`) backstops the one lower-severity finding here (batch-bound not enforced on the outer DELETE's own `ctid` scan for `events`/`send_events` — same-tenant-only exposure across partitions, not a cross-tenant leak; see Anti-Patterns). |
| 5 | A workspace restored after its purge was enqueued is not purged: eligibility re-checked inside every batch, purge refuses rather than skips. | ✓ VERIFIED | `workspace-purge.worker.ts`: `readOrganizationDeletedAt` re-read before the first destructive batch (line 178) and inside `walkPurgeTable`'s per-page loop (line 238), throwing `WorkspaceRestoredError` rather than silently skipping. Behaviorally exercised, not just present: `workspace-purge.test.ts`'s "restored mid-walk is refused: the walk throws, the record is marked failed with a recorded reason, and a later tick does not resume" (line 378) asserts the throw, the `failed` status and the recorded `/restored/` reason directly. |

**Score:** 4/5 truths verified (truth 2 failed on two independently-confirmed defects: the undocumented `dead_letter_jobs` PII gap, and the non-write-once `table_counts` merge)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/db/src/workspace-purge-tables.ts` | Frozen FK-ordered purge table allowlist, secret tables, evidence tables | ✓ VERIFIED (with gap) | Present, substantive, reconciled against PII-INVENTORY.md for named tables — but `dead_letter_jobs` omitted (see gap 1) |
| `apps/worker/src/queues/workspace-purge.worker.ts` | Scheduled tick, report-then-destroy state machine, per-batch eligibility re-check | ✓ VERIFIED | Present, wired to BullMQ repeatable job, `readOrganizationDeletedAt` re-check present and behaviorally tested |
| `apps/worker/src/queues/workspace-purge-checkpoint.ts` | Checkpointed progress, immutable table_counts census | ⚠️ VERIFIED WITH DEFECT | Present and wired, but `recordAuthPurgeCounts`'s merge is not write-once (gap 2) |
| `packages/delivery-core/src/workspace-quiesce.ts` | Shared `isWorkspaceSoftDeleted` helper | ✓ VERIFIED | Present, used by send-dispatch/flow-send/campaign-kickoff |
| `apps/api/src/modules/tenancy/workspace-lookup.ts` | Shared `isWorkspaceSoftDeletedById` for API surfaces | ✓ VERIFIED | Present, used by api-key-auth.ts and webhooks.routes.ts |
| `apps/worker/src/queues/workspace-purge-auth.ts` | Elevated-pool member/invitation deletes only | ✓ VERIFIED | Only two DELETE statements present (`invitation`, `member`), scoped to `organizationId = $1`; no other query on this pool |
| `packages/db/src/workspace-restore.ts` | Point-of-no-return refusal, same-transaction overdue-campaign flip, no tenant-facing route | ✓ VERIFIED | `WorkspacePurgeStartedError` thrown unconditionally once destruction has started; `UPDATE campaigns SET status = 'draft'` confirmed inside the same restore transaction; `grep` for `restoreWorkspace` under `apps/api/src` returns zero matches (CLI-only, no route) |
| `apps/api/src/modules/ops/purge-watchdog.ts` | Read-only observer of `purge_records`/`ops_alert_state` | ✓ VERIFIED | Only write is `UPDATE ops_alert_state` (its own dedup bookkeeping); no write to `purge_records` found |
| `docs/PII-INVENTORY.md` | Complete tenant-table PII inventory reconciled with purge scope | ✗ INCOMPLETE | `dead_letter_jobs` entirely absent (gap 1) |
| `docs/runbooks/workspace-purge-and-restore.md` | End-to-end lifecycle runbook, four-survivor evidence table | ✓ VERIFIED (present) | Present; the four named survivors (`erasure_records`, `purge_records`, `workspace_suppressions`, `workspace_daily_rollup`) match code, but the survivor table's own stated design goal ("tell correct-by-design from purge-incomplete at a glance") is undermined by the unlisted fifth survivor (`dead_letter_jobs`) |
| `apps/worker/src/queues/__tests__/failure-injection/workspace-purge-resume.test.ts` | Real-SIGKILL kill-resume proofs | ✓ VERIFIED | 595 lines, 7 substantive cases, real process kills via kill harness |
| `apps/worker/src/queues/__tests__/workspace-purge-neighbour-safety.test.ts` | Negative cross-tenant partition test | ✓ VERIFIED | 327 lines, 6 cases including byte-identical neighbour check |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `send-dispatch.ts` | `workspace-quiesce.ts` | `isWorkspaceSoftDeleted(client, workspaceId)` re-read on every claim | WIRED | Confirmed at lines 332, 652 |
| `flows/flow-send.ts` | `workspace-quiesce.ts` | `isWorkspaceSoftDeleted` before send | WIRED | Confirmed at line 147 |
| `campaign-kickoff.worker.ts` | `workspace-quiesce.ts` | `isWorkspaceSoftDeleted` via `withTenantTransaction` | WIRED | Confirmed at line 62 |
| `api-key-auth.ts` | `workspace-lookup.ts` | `isWorkspaceSoftDeletedById` fail-closed check | WIRED | Confirmed at line 117 |
| `webhooks.routes.ts` | `workspace-lookup.ts` | `isWorkspaceSoftDeletedById`, before signature verification and before body read | WIRED | Confirmed at line 149; comment and code both show the check consumes only `endpoint.workspaceId`, no body parse |
| `workspace-purge.worker.ts` | `workspace-purge-tables.ts` | `PURGE_TABLE_ORDER` walk via `deletePurgeBatch`/`countPurgeTableRows` | WIRED | Confirmed |
| `workspace-purge.worker.ts` | `workspace-purge-checkpoint.ts` | checkpoint read/write around every table and the auth step | WIRED (with defect, see gap 2) | |
| `workspace-purge.worker.ts` | `workspace-purge-auth.ts` | `deleteWorkspaceAuthRows` called after tenant tables empty, before tombstone | WIRED | Confirmed |
| `events-ingest.worker.ts` / `webhook-events.worker.ts` | shared quiesce helper | local duplicate functions, NOT importing the shared helper | PARTIAL | Both still carry `TODO(22-02)`-flagged local copies past the wave boundary the comment itself set as deadline; functionally correct today (same rule), but drift risk. Not a goal-blocking gap — routed to Anti-Patterns below, not to `gaps`. |

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|-------------|-----------------|--------------|--------|----------|
| PRG-01 | 22-01, 22-06, 22-08 | Physical purge after operator-configured retention | ✓ SATISFIED | `findEligibleWorkspaces`, `WORKSPACE_PURGE_RETENTION_DAYS` in `apps/worker/src/env.ts` |
| PRG-02 | 22-01, 22-05, 22-07, 22-10 | Purge deletes/anonymizes PII, deletes secrets, preserves compliance evidence | ✗ BLOCKED (partial) | Secrets and named tenant tables handled correctly; `dead_letter_jobs` PII gap and `table_counts` overwrite defect are unresolved contradictions of this requirement's own text |
| PRG-03 | 22-01, 22-08, 22-09 | Idempotent, resumable, checkpointed purge; safe re-run and mid-purge crash | ✓ SATISFIED | Real-SIGKILL test suite, `completed_tables` checkpoint, `markPurgeComplete` no-op on re-run |
| PRG-04 | 22-05 | No cross-tenant impact; no DROP/DETACH/TRUNCATE; proven by negative test | ✓ SATISFIED | `workspace-purge-neighbour-safety.test.ts`, RLS backstop confirmed |
| PRG-05 | 22-01, 22-06 | Eligibility re-checked per batch; restored workspace not purged | ✓ SATISFIED | `readOrganizationDeletedAt` re-check inside `walkPurgeTable`, `WorkspaceRestoredError`, behaviorally tested |
| PRG-06 | 22-02, 22-03, 22-04 | Soft-deleted workspace quiesces immediately (no further sends) | ✓ SATISFIED | All three send paths + two API ingress paths wired and tested |

No orphaned requirements: REQUIREMENTS.md lines 25-30 (PRG-01 through PRG-06) all appear in at least one plan's `requirements` frontmatter field; no additional Phase-22-mapped requirement IDs exist beyond these six. **Note:** REQUIREMENTS.md's own tracking table (lines 85-90) still shows all six as "Pending" and the checklist items (lines 25-30) are unchecked — this is a documentation-bookkeeping gap in the requirements ledger itself, not a code gap; flagged for the phase-closure step to update, not blocking this verification's goal-achievement determination.

### Prohibitions Coverage

Every plan in this phase declares `must_haves.prohibitions` (all recorded with `status: unverified` and no `verification:` tier in the PLAN frontmatter — treated as judgment-tier). Representative and highest-risk items were independently spot-checked against the codebase rather than accepted from SUMMARY.md narrative:

| Plan | Prohibition (abbreviated) | Verification | Result |
|------|---------------------------|---------------|--------|
| 22-01 | MUST NOT `DELETE FROM organization` (UPDATE-tombstone only) | `grep -rn "DELETE FROM organization"` across apps/worker, packages/db | ✓ Holds — zero live occurrences (only doc/test comments about why it's avoided) |
| 22-01 | MUST NOT store purge checkpoint state on a tenant-scoped table | `purge_records` migration 0068 read directly | ✓ Holds — no RLS, no FK to organization, platform-level table |
| 22-02 | MUST NOT ack a refused send job silently | `grep` for `recordExcluded`/`recordFlowExcluded`/`WORKSPACE_DELETED_EXCLUSION_REASON` at all 3 dispatch call sites | ✓ Holds — every quiesce refusal on a ledgered path calls `recordExcluded`/`recordFlowExcluded`; test-send path (no ledger row by design) explicitly logs instead |
| 22-03 | MUST NOT parse/JSON-decode webhook body before the quiesce check | Read `webhooks.routes.ts:120-151` directly | ✓ Holds — check consumes only `endpoint.workspaceId`, runs strictly before `verifyWebhookSignature`/body read |
| 22-03 | MUST NOT distinguish deleted-workspace 404 from unknown-pathToken 404 | `webhooks-quiesce.test.ts`: "response is indistinguishable from an unknown pathToken" | ✓ Holds (test-backed) — see IN-03 for a residual timing-side-channel nuance, non-blocking |
| 22-04 | All three scan policies (`campaigns_scan`/`flows_scan`/`flow_runs_scan`) move together in one migration | Read `0070_scan_policies_exclude_deleted_workspaces.sql` directly | ✓ Holds — all three `DROP POLICY`/`CREATE POLICY` pairs present |
| 22-05 | MUST NOT issue DROP/DETACH/TRUNCATE during a purge | `grep -rn "DROP\|DETACH\|TRUNCATE"` across purge code | ✓ Holds — none issued |
| 22-05 | MUST NOT delete/mutate the four evidence tables | `PURGE_EVIDENCE_TABLES` constant + doc comment cross-check | ✓ Holds — excluded from `PURGE_TABLE_ORDER` entirely |
| 22-06 | MUST NOT restore once destruction has started (unconditional refusal) | `WorkspacePurgeStartedError` thrown unconditionally in `workspace-restore.ts` | ✓ Holds |
| 22-06 | Overdue campaign flip happens in the SAME transaction as un-delete | `UPDATE campaigns SET status = 'draft'` located inside the restore transaction | ✓ Holds |
| 22-06 | MUST NOT expose restore as tenant-facing | `grep -rln "restoreWorkspace" apps/api/src` | ✓ Holds — zero matches, CLI-only |
| 22-07 | MUST NOT delete Better Auth user/session/account rows | `workspace-purge-auth.ts` query list | ✓ Holds — only `invitation`/`member` DELETEs present |
| 22-08 | MUST NOT let the watchdog mutate purge state | `grep` for UPDATE/INSERT/DELETE in `purge-watchdog.ts` | ✓ Holds — only write is to its own `ops_alert_state` dedup row |
| 22-09 | MUST NOT prove resumability with a simulated/mocked kill | `spawnAndKillOnReady` asserts `exit.signal === "SIGKILL"` against a real spawned child | ✓ Holds |

No prohibition spot-checked above was found violated. This is a sampled, not exhaustive, pass across ~35 declared prohibitions in this phase (all judgment-tier per the phase's own PLAN frontmatter, which never sets a `verification: test|judgment` field) — the sample deliberately weighted toward the highest-consequence claims (irreversible operations, cross-tenant/cross-boundary access, silent failure). None contradicts the `gaps_found` determination above, and none is itself elevated to a gap.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `packages/db/src/workspace-purge-tables.ts` | 259-277 | Outer `DELETE`'s batch bound relies on `ctid` uniqueness alone for `events`/`send_events` | Warning | Same-tenant rows in a different month's partition can be swept into one "batch," violating the 500-row bound; backstopped by RLS so no cross-tenant leak — SC4 still holds |
| `apps/worker/src/queues/workspace-purge-checkpoint.ts` | 130-142 | `recordAuthPurgeCounts` non-write-once merge | Warning (promoted to gap 2 above — affects stated compliance-evidence guarantee) | See gaps section |
| `apps/worker/src/queues/events-ingest.worker.ts`, `webhook-events.worker.ts` | ~11-30, ~31-52 | `TODO(22-02)`-flagged duplicate quiesce-lookup functions never removed after both branches merged | Warning | Functionally correct today; future drift risk if the canonical rule changes |
| `apps/worker/src/queues/workspace-purge.worker.ts`, `packages/db/src/workspace-purge-report.ts` | ~111-118, ~102-109 | Cutoff comparison casts to bare `timestamp`, session-`TimeZone`-dependent | Warning | Multi-day retention window absorbs the skew in practice; same bug class already fixed elsewhere in the codebase |
| `docker/prod.env.example` | 126-137 | `WORKSPACE_PURGE_TICK_CRON` undocumented | Info | Operator convenience only |
| `packages/db/src/migration-tiers.ts` | 64 | Stale migration count in a comment | Info | Comment only |
| `apps/api/src/modules/webhooks/webhooks.routes.ts` | 149-151 | Timing side-channel between deleted-workspace and unknown-token 404 | Info | Narrow, requires a plausible token already |

No `TBD`/`FIXME`/`XXX` debt markers found in any file touched by this phase (checked against the full phase diff).

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| dead_letter_jobs has no workspace_id column | `grep -n "workspace_id" packages/db/src/schema/dead-letter-jobs.ts` | No match | ✓ CONFIRMS GAP 1 |
| dead_letter_jobs absent from PII-INVENTORY.md | `grep -n "dead_letter" docs/PII-INVENTORY.md docs/runbooks/workspace-purge-and-restore.md packages/db/src/workspace-purge-tables.ts` | No output (zero matches across all three files) | ✓ CONFIRMS GAP 1 |
| scrub() rule table has no name/value rule for firstName/lastName/externalId/testTo | Read `packages/redaction/src/rules.ts` in full | Only `email`/`phone` key+value rules and secret-shaped key rules; no coverage for the named fields | ✓ CONFIRMS GAP 1 |
| `recordAuthPurgeCounts` merge is not write-once | Read `apps/worker/src/queues/workspace-purge-checkpoint.ts:130-142` | Bare `table_counts || jsonb_build_object(...)`, no `WHERE NOT (table_counts ? 'member')` guard | ✓ CONFIRMS GAP 2 |
| No DROP/DETACH/TRUNCATE issued by purge code | `grep -rn "DROP\|DETACH\|TRUNCATE"` across purge worker/table files | Only doc-comment mentions of what is never issued | ✓ PASS |
| Quiesce checks wired at every send/ingest surface | `grep -n "isWorkspaceSoftDeleted"` across send-dispatch/flow-send/campaign-kickoff/api-key-auth/webhooks.routes | All 5 call sites confirmed | ✓ PASS |
| Per-batch eligibility re-check present AND behaviorally tested | Read `workspace-purge.worker.ts:168-250`; `grep -n "restored" apps/worker/src/queues/__tests__/workspace-purge.test.ts` | `readOrganizationDeletedAt` called before first destructive batch and inside the per-page loop; named test "restored mid-walk is refused" asserts the throw/failed-status/reason | ✓ PASS (SC5 stays VERIFIED, not presence-only) |

Full test-suite execution not re-run by this verifier — relied on orchestrator-supplied evidence (chunked `npm test` per workspace green except documented machine-specific sentry tests; `npm run failure:workspace-purge-resume` 7/7 pass on merged tree; full regression green after wave 5) per the "run the full suite at most once" constraint, combined with direct code reads of the specific claims under scrutiny.

### Probe Execution

No `scripts/*/tests/probe-*.sh` probes exist in this repository (`find scripts -path '*/tests/probe-*.sh' -type f` returns nothing), and no PLAN/SUMMARY in this phase references a probe script by that convention — this phase's real-crash verification is carried entirely by the in-repo failure-injection harness under `apps/worker/src/test/harness/` and `apps/worker/src/queues/__tests__/failure-injection/`, which is Step 7b/orchestrator territory, not Step 7c's probe convention. Section included per process; nothing to execute.

### Gaps Summary

The phase delivers a well-architected, thoroughly-tested quiesce-and-purge state machine: all five sending/ingestion surfaces are fail-closed on soft-delete (SC1), the purge is genuinely resumable under real SIGKILL across mid-batch/between-table/pre-tail boundaries with no partial-count corruption in the paths that are tested (SC3), neighbour-partition safety is proven by negative tests with an RLS backstop and zero structural operations (SC4), and eligibility is re-checked inside every batch — not just at dispatch time — with a named test exercising the refusal itself (SC5). A sampled pass across the ~35 declared prohibitions across all ten plans, weighted toward the highest-consequence claims, found none violated.

The one success criterion not fully met is SC2 ("PII across every tenant table is deleted or anonymized... while compliance evidence... is still present and readable"). Two concrete, code-verified defects undermine it:

1. `dead_letter_jobs` — a table proven capable of holding unscrubbed contact PII from any terminally-failed job — is completely outside the purge's scope and completely undocumented in the PII inventory and the purge runbook's survivor table. This is not a documented, deliberate exception like the four named evidence survivors; it is an oversight the phase's own research and planning never surfaced. Whether this is acceptable (e.g., dead-letter rows already have their own short operational lifetime) or must be closed is a scope/policy decision for the team — but it must be an explicit, recorded decision either way, not silence, since the phase's own `PII-INVENTORY.md` states a "same-change rule" for exactly this kind of table.
2. `recordAuthPurgeCounts` can silently overwrite the immutable `table_counts` compliance census with zeros in a real (if narrow) crash window between the auth-table delete and the checkpoint write — a window the existing real-SIGKILL test suite does not exercise.

Both are precise, actionable, and narrow in scope relative to the rest of the phase's delivery. Neither requires re-architecting the purge; both have concrete fixes proposed in the code review this verification independently cross-checked against the actual codebase (not accepted on the review's authority alone).
