# Phase 22: Workspace Quiesce & Physical Purge - Research

**Researched:** 2026-08-23
**Domain:** Multi-tenant destructive data lifecycle (soft-delete quiesce + retention-triggered physical erasure) on a shared-schema Postgres RLS platform
**Confidence:** HIGH for schema/FK/privilege findings (all grep-verified against the live codebase); MEDIUM for state-machine shape and worker wiring (design recommendations, not yet code); LOW/ASSUMED flagged explicitly where noted

## Summary

This phase closes the workspace lifecycle: quiesce (stop sending/ingesting immediately on soft delete) and physical purge (destroy PII + secrets after a retention window, while specific evidence rows survive). The codebase already contains the exact precedents this phase needs to generalize: `erasure-scrub.worker.ts` + `erasure-scrub-checkpoint.ts` for checkpointed, resumable, keyset-paginated batch deletion; `relocate-default.ts` for advisory-locked, SKIP-LOCKED batched DML inside shared partitions; `partition-maintenance.worker.ts` for the scheduled-tick + dead-man's-switch worker shape; `ops_alert_state`/`dead_letter_jobs` for platform-level (non-RLS) evidence/checkpoint tables.

Three findings materially change what CONTEXT.md's plan-time decisions assumed, and the planner must treat all three as load-bearing:

1. **`erasure_records.contact_id` has `ON DELETE CASCADE` to `contacts.id`.** D-10 requires `erasure_records` to survive the purge as evidence, but the purge must physically delete `contacts` rows. Postgres will cascade-delete `erasure_records` the instant a referenced contact is deleted, REGARDLESS of the order the purge issues its DELETEs in — this is not an ordering problem, it is a schema problem. **A migration to relax this FK (nullable `contact_id`, `ON DELETE SET NULL`) is mandatory**, not optional, before the purge can satisfy D-10.
2. **PT-01's "privilege model" question resolves narrowly, not broadly.** `mega_crm_app` (the app's normal DB role) already owns every tenant table and already has `UPDATE` on `organization` — no new grant is needed for tombstoning the org row or for any tenant-table batched DELETE (each runs one-workspace-at-a-time through the existing `withTenant` RLS scope, exactly like `erasure-scrub.worker.ts` already does). The **real** privilege gap is narrower and different: `mega_crm_app` was deliberately stripped of `DELETE` (and `INSERT`) on `member`/`invitation` in migration 0045 (the Phase 10 Better Auth trust boundary) — only `mega_crm_auth` can delete those rows, and only `apps/api` currently holds `AUTH_DATABASE_URL`. D-12 requires deleting a purged workspace's `member`/`invitation` rows, so the purge worker needs a path to the `mega_crm_auth` role for exactly those two tables.
3. **PT-03's premise (that a new column-level grant is needed for `mega_crm_scan` to read `organization.deletedAt`) is incorrect.** Migration 0042 already grants `mega_crm_scan` table-level `SELECT` on `organization` in full. Closing the `campaigns_scan`/`flows_scan` gap is a pure policy-predicate change (add a `NOT EXISTS (... organization ...)` subquery to the existing `USING` clause) — no new grant migration required. (The `flow_runs_scan` policy used by `flow-reconciliation.worker.ts`'s `findDueFlowRunCandidates` has the **same** gap and was not named in CONTEXT.md's "verified gap" — it must be closed in the same migration or D-02's "flows exactly as the tenant left them" is violated by continuing flow-run advancement during the retention window.)

**Primary recommendation:** Build the purge as a `partition-maintenance.worker.ts`-shaped scheduled tick that (a) discovers eligible workspaces via a dedicated non-RLS pool (organization carries no RLS at all — no special role needed for discovery either), (b) drives one `erasure-scrub`-shaped keyset-paginated batch loop per tenant table in FK-dependency order, checkpointing progress on a NEW platform-level (non-RLS, no FK to organization) `purge_records` table exactly like `ops_alert_state`/`dead_letter_jobs` already do, and (c) tombstones `organization` (UPDATE, not DELETE) only after every tenant table reports zero remaining rows. Ship the `erasure_records.contact_id` FK-relaxation migration and the `campaigns_scan`/`flows_scan`/`flow_runs_scan` policy-predicate migration as prerequisite/companion migrations in the same phase.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Soft-delete quiesce (stop new dispatch) | API / Backend (Fastify routes, existing) | — | `workspaces.ts` DELETE route already sets `deletedAt`; no new tier |
| Discovery-layer exclusion (`campaigns_scan`/`flows_scan`/`flow_runs_scan`) | Database (RLS policy) | Worker (discovery query, unchanged) | The exclusion is a WHERE-clause/policy-predicate concern, not application logic — closing it in Postgres means every current and future consumer of these scan policies inherits the fix |
| Dispatch-time fail-closed kill (D-01) | API / Backend (`packages/delivery-core`'s `evaluatePreSendGate`, worker call sites) | — | Mirrors the existing suppression/frequency-cap gate; must also cover the test-send path, which bypasses `evaluatePreSendGate` entirely today |
| Ingestion quiesce (events API + webhook) | API / Backend (Fastify routes) | Worker (already-enqueued job drain, see Open Questions) | Typed refusal at the authenticated events API; drop/quarantine at the anonymous webhook route (post-token-lookup, pre-signature-verify is NOT an option — signature must still gate first per CLAUDE.md) |
| Purge worker (batched DELETE per tenant table) | Worker (BullMQ tick, dedicated pool) | Database (RLS via `withTenant`, one workspace at a time) | Same shape as `erasure-scrub.worker.ts`/`partition-maintenance.worker.ts`; no new DB tier |
| Purge checkpoint + evidence (`purge_records`) | Database (new platform-level table, no RLS) | — | Must survive past the point tenant tables are gone; cannot live on any tenant-scoped (RLS'd, cascade-linked) table |
| Restore CLI | Worker/CLI (operator script) | Database (UPDATE `organization.deletedAt`, read `purge_records` point-of-no-return) | Mirrors `relocate-default-partition-rows.ts`'s operator-CLI shape |
| Member/invitation deletion (D-12) | Database (via `mega_crm_auth`-authenticated connection) | Worker (purge job orchestrates the call) | `mega_crm_app` structurally cannot DELETE these two tables (Phase 10 boundary, migration 0045) — this is the one piece of the purge that cannot run through the worker's existing pool unmodified |

## User Constraints

<user_constraints>

### Locked Decisions

- **D-01:** Quiesce enforcement at both layers — discovery-scan exclusion (`campaigns_scan`/`flows_scan`, extend to `flow_runs_scan`, see Standard Stack/Pitfalls) AND a fail-closed dispatch-time check in the send path.
- **D-02:** Soft delete freezes, never cancels — no campaign/flow state mutation at soft-delete time.
- **D-03:** A dispatch-gate refusal is recorded as an excluded send fact (`sends.status = 'excluded'`, new `exclusion_reason` e.g. `workspace_deleted`) — same mechanism as suppression exclusions. **Note (research finding):** the test-send dispatch path has no `sends` row at all (see Common Pitfalls) — D-03's mechanism cannot apply there; needs its own refusal shape.
- **D-04:** Ingestion quiesces too — events API typed refusal; webhook events dropped/quarantined. Late webhook evidence for pre-delete mail deliberately sacrificed.
- **D-05:** Purge initiation is an automatic worker tick (partition-maintenance pattern) — no operator-invoked-only gate (Phase 9 precedent explicitly NOT followed here).
- **D-06:** Retention default 30 days via env (planner names it, e.g. `WORKSPACE_PURGE_RETENTION_DAYS`), boot-validated floor (e.g. ≥7 days).
- **D-07:** Report-only first tick — eligibility report at least one full tick before the first destructive batch, plus an on-demand operator CLI.
- **D-08:** Stuck/failed purge raises an operator alert via `ops_alert_state`; success is a structured log line + the durable purge record.
- **D-09:** `organization` row becomes an anonymized tombstone (name/slug/PII scrubbed, `deletedAt` kept, `purged_at` added) — one-way.
- **D-10:** Surviving evidence set: `erasure_records`, a new `purge_records` row, hashed suppression rows, aggregate daily metrics. Everything else deleted. Widening later is easy; narrowing after a purge has run is impossible.
- **D-11:** Per-workspace HMAC suppression key destroyed with other secrets — cryptographic erasure of suppression rows.
- **D-12:** Purge deletes this workspace's `member`/pending `invitation` rows; Better Auth `user`/`session`/`account` untouched. No orphaned-user cleanup this phase.
- **D-13:** Minimal operator-only restore CLI — clears `deletedAt`, refuses past the point of no return.
- **D-14:** Point of no return = the first destructive batch. Restore succeeds any time before the first row is destroyed (including during the report-only tick).
- **D-15:** On restore, an overdue `scheduled` campaign never auto-fires.

### Claude's Discretion

- Env var names, exact floor value for D-06, tick cadence, batch sizes (500-row erasure-scrub precedent suggested, not mandated), purge table/column naming.
- The purge state machine's exact states, claim primitive (advisory lock vs claimed_at column), and checkpoint storage shape — must live OUTSIDE tenant tables (PRG-03).
- Whether webhook events for a deleted workspace are dropped vs quarantined (D-04) — pick whichever keeps the ingress-journal invariants intact.
- Typed refusal shapes for quiesced ingestion and the restore CLI's error copy.
- FK deletion ordering across tenant tables — research/spike territory (see Standard Stack, FK graph below — this research resolves most of it).
- Exclusion-reason literal, scan-filter mechanics, `purge_records` schema details.

### Deferred Ideas (OUT OF SCOPE)

- Owner-facing restore in UI — tenant self-service un-delete. Operator CLI (D-13) covers the mechanism.
- Orphaned Better Auth user cleanup — users left with zero workspaces after purge.
- Durable DSR export audit table (`dsr_export_records`) — `purge_records` is its natural companion if that requirement emerges later.

</user_constraints>

## Phase Requirements

<phase_requirements>

| ID | Description | Research Support |
|----|-------------|------------------|
| PRG-01 | Soft-deleted workspace physically purges after policy-defined retention (platform default via env) | `partition-maintenance.worker.ts` tick pattern; env-floor validation pattern in `apps/api/src/env.ts` (`z.coerce.number().int()...refine()`); organization has no RLS so eligibility discovery needs no new role/grant |
| PRG-02 | Purge deletes/anonymizes tenant PII in every tenant table, deletes secrets, keeps compliance evidence | Full FK graph mapped below (organization → 26 tenant tables, all `ON DELETE CASCADE`); PII-INVENTORY.md is the per-contact authority; `erasure_records.contact_id` FK-relax migration is a hard prerequisite for keeping evidence |
| PRG-03 | Purge is idempotent and resumable, checkpointed outside tenant tables | `erasure-scrub-checkpoint.ts` pattern generalized; checkpoint must live on the NEW non-RLS `purge_records` table (erasure_records's own checkpoint approach — storing cursors ON the record row — cannot be reused here because tenant tables are being destroyed) |
| PRG-04 | No DROP/DETACH/TRUNCATE; batched DELETE inside shared partitions; proven by negative test | `relocate-default.ts`'s `SKIP LOCKED` + advisory-lock batched DELETE pattern; 38 existing negative cross-tenant tests are the genre precedent for SC4 |
| PRG-05 | Eligibility re-checked inside every batch; restored workspace refused not skipped | `campaign-scheduler.worker.ts`'s discover-then-re-verify-per-row split (`findDueCampaignCandidates` → `transitionToSending`'s own re-check) is the direct precedent shape |
| PRG-06 | Soft-deleted workspace stops sending immediately | `campaigns_scan`/`flows_scan`/`flow_runs_scan` RLS-policy gap (grep-confirmed, all three); `evaluatePreSendGate` fail-closed gate precedent; test-send path bypasses that gate entirely (new gap to close) |

</phase_requirements>

## Standard Stack

No new libraries are required for this phase — it is pure application code (worker, migrations, CLI) built entirely on the existing stack.

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| drizzle-orm | 0.45.2 [VERIFIED: package.json] | Schema for `purge_records`, tombstone columns | Already the project ORM |
| pg | 8.22.0 [VERIFIED: package.json] | `PoolClient`-based batched DML, same as `relocate-default.ts`/`erasure-scrub.worker.ts` | Already the project driver |
| bullmq | 5.79.4 [VERIFIED: package.json] | Purge tick worker + queue | Already the project queue |
| zod | 4.4.3 [VERIFIED: package.json] | `WORKSPACE_PURGE_RETENTION_DAYS` env validation, job payload schemas | Already the project validator |
| drizzle-kit | 0.31.10 [VERIFIED: package.json] | New migrations (purge_records table, FK relax, RLS policy predicate change) | Already the project migration CLI |

### Package Legitimacy Audit

**No new packages introduced this phase.** All work is implemented with the existing dependency set above (all versions confirmed directly from installed `package.json` files, not from training data). No `npm view`/registry check is needed since nothing new is being added — flagging this explicitly per the audit protocol's requirement to state findings, not skip silently.

## FK Graph and Deletion Ordering (PRG-02/PRG-04, replaces "spike territory")

Every tenant table's `workspace_id` column FKs to `organization.id` with `ON DELETE CASCADE` [VERIFIED: grep across `packages/db/src/schema/*.ts`, 27 tables]. **This means D-09's tombstone (never hard-delete `organization`) is not merely a preference — it is structurally required.** If the purge ever issued a hard `DELETE FROM organization WHERE id = $1`, Postgres would cascade that single statement into an unbounded, unbatched, single-transaction delete across every one of the 27 tenant tables (including the two large partitioned tables, `events` and `send_events`) — a direct violation of PRG-03 (checkpointed/resumable) and PRG-04 (batched, no long-lived unbounded lock). The purge must NEVER touch the `organization` row with `DELETE`, only `UPDATE` (the tombstone), for exactly this reason — the FK graph forces the design CONTEXT.md already chose.

Within a single tenant's own tables (deleted explicitly, in batches, never relying on cascade — required for PRG-04's bounded-batch guarantee even though CASCADE row-locking mechanics would eventually work), three `ON DELETE RESTRICT` edges force an explicit order [VERIFIED: grep `references(()` across schema files]:

- `campaigns.segment_id → segments.id` (RESTRICT)
- `flows.trigger_segment_id → segments.id` (RESTRICT)
- `flow_runs.flow_version_id → flow_versions.id` (RESTRICT)

Recommended deletion order (leaf-to-root, satisfies every RESTRICT edge and avoids relying on any CASCADE for a table the purge itself must report a row-count for):

1. `send_events` (references `sends`, SET NULL — safe to delete first or last; delete first since it's the largest partitioned table and has no downstream dependents)
2. `flow_run_steps` (references `flow_runs`, `sends` SET NULL)
3. `campaign_recipients` (references `campaigns`, `contacts`)
4. `subscription_status_history`, `flow_segment_membership_snapshot`, `flow_segment_sweep_checkpoint` (reference `contacts`/`flows`)
5. `events` (references `contacts`, partitioned — same batched-per-partition-month concern as `send_events`)
6. `sends` (references `contacts`, `campaigns` SET NULL, `flow_runs` — must go after `flow_runs`... **see note below**)
7. `flow_runs` (references `flows`, `flow_versions` RESTRICT, `contacts`) — must go before `flow_versions`
8. `flow_versions` (references `flows`)
9. `flows` (references `segments` RESTRICT) — must go before `segments`
10. `campaigns` (references `segments` RESTRICT) — must go before `segments`
11. `segments`
12. `contacts` — **only after every table above that references it is empty** (`send_events` via `sends`, `flow_run_steps`, `campaign_recipients`, `subscription_status_history`, `flow_segment_membership_snapshot`, `events`, `sends`, `flow_runs` all reference `contacts` with CASCADE, so ordering here is not strictly required for correctness, but deleting `contacts` before its dependents are batched-deleted would fire an uncontrolled cascade across those tables — **explicit ordering is required to keep every delete a bounded, batched, checkpointed statement, not to satisfy an FK error**)
13. Remaining single-table-no-fan-in tenant tables in any order: `csv_import_rows` → `csv_imports`, `property_registry`, `suppressions` [see evidence-survival note], `send_event_quarantine`, `ingress_journal`, `workspace_daily_rollup` [see evidence-survival note], `api_keys`, `workspace_send_settings`, `reputation_alert_state`, `workspace_sendgrid_keys` [secret], `workspace_suppression_keys` [secret], `workspace_webhook_endpoints` [secret]
14. `erasure_records` — **do NOT delete** (D-10 evidence); requires the FK-relax migration below before `contacts` (step 12) can be safely deleted
15. `member`, `invitation` (D-12) — requires `mega_crm_auth`-privileged connection, see Common Pitfalls / Privilege Model
16. `organization` — **UPDATE only** (tombstone), never DELETE

**Note on `sends` vs `flow_runs` ordering:** `sends.flow_run_id → flowRuns.id` is `ON DELETE CASCADE`, so `sends` rows tied to a flow run would auto-cascade if `flow_runs` were deleted first. For the same "keep every delete bounded and explicit" reason as `contacts` above, delete `sends` before `flow_runs`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Keyset pagination over a partitioned table | A custom cursor scheme | `erasure-scrub-checkpoint.ts`'s composite `(occurredAt, id)` cursor pattern, generalized per table | Already solved the exact "partitioned table needs the partition key leading the ORDER BY" problem (documented pitfall in that file) |
| Batched cross-tenant-safe DELETE inside a shared partition | A raw `DELETE ... LIMIT` loop with no locking discipline | `relocate-default.ts`'s `DELETE ... WHERE ctid IN (SELECT ... FOR UPDATE SKIP LOCKED)` pattern | `SKIP LOCKED` is what prevents a purge batch from blocking on (or racing) an in-flight tenant write from another process |
| Scheduled destructive worker with stuck-job detection | A cron script + manual monitoring | `partition-maintenance.worker.ts`'s `upsertJobScheduler` + dedicated pool + `ops_alert_state`-backed watchdog shape | Already proven two-process dead-man's-switch pattern (worker writes health/progress row, API-side watchdog alerts on staleness) |
| Advisory-lock single-flight guard for a destructive maintenance job | A Redis lock or a boolean flag column | `pg_try_advisory_lock`/`pg_advisory_unlock` on a dedicated connection, exactly as `relocateAllDefaultRows` does | Already handles the "concurrent invocation" race with a clear failure message, and the release-before-pool-return subtlety (advisory locks are session-scoped, not checkout-scoped) |

**Key insight:** every mechanical building block this phase needs (keyset pagination, batched shared-partition DELETE, scheduled-tick worker with watchdog, advisory-lock single-flight) already exists in this codebase in a proven, tested form. The actual net-new work is (a) generalizing keyset pagination from "one contact across two tables" to "one workspace across ~20 tables," (b) two migrations (FK relax, RLS predicate change), and (c) the purge-specific state machine (point-of-no-return, eligibility re-check per batch).

## Common Pitfalls

### Pitfall 1: `erasure_records.contact_id` cascade destroys the evidence it's supposed to preserve

**What goes wrong:** The purge deletes `contacts` rows (required — contacts are the core PII table). `erasure_records.contact_id REFERENCES contacts(id) ON DELETE CASCADE` [VERIFIED: `packages/db/migrations/0059_contact_erasure.sql:72`, mirrored in `packages/db/src/schema/erasure-records.ts:48-51`]. The instant a contact row is deleted, Postgres cascade-deletes every `erasure_records` row for that contact — silently, with no application code involved, regardless of what order the purge's own DELETE statements run in.

**Why it happens:** `erasure_records` was designed in Phase 13 as *per-contact* erasure evidence, before Phase 22's *workspace-level* purge requirement (D-10: this table must survive workspace purge) existed. The FK was never revisited for the new requirement.

**How to avoid:** Ship a migration that changes `erasure_records.contact_id` to nullable with `ON DELETE SET NULL` (dropping the `NOT NULL` + `ON DELETE CASCADE`, adding `ON DELETE SET NULL`) before the purge worker's first production run. This preserves the audit trail ("an erasure happened, for a contact that no longer exists") while making contact deletion safe. Note `erasure_records.workspace_id → organization.id` is also `ON DELETE CASCADE`, but this is a non-issue in practice **only because** the purge never hard-deletes `organization` (Pitfall 2) — do not "fix" this second FK by relaxing it too; leaving it as CASCADE is fine and arguably correct (if `organization` were ever hard-deleted by some other path, losing `erasure_records` along with it is consistent, whereas losing it merely because one contact among many was deleted is not).

**Warning signs:** A negative test that seeds an `erasure_records` row, runs the purge, and asserts the row still exists (D-10's own falsifiability requirement) will fail immediately without this migration — this should be one of the first tests written, before the full purge loop, so the gap is caught at plan-time rather than discovered mid-implementation.

### Pitfall 2: Hard-deleting the `organization` row instead of tombstoning it

**What goes wrong:** Every one of 27 tenant tables cascades from `organization.id`. A hard `DELETE FROM organization WHERE id = $1` fires one giant, unbounded, unbatched cascade across all of them in a single transaction/lock scope — including the two large partitioned tables (`events`, `send_events`).

**Why it happens:** It looks like the "obviously correct" way to finish a purge — the org row is gone, so surely everything downstream should be too.

**How to avoid:** D-09's tombstone (UPDATE `deletedAt`/PII columns/`purged_at`, never DELETE) is the only design compatible with PRG-03 (checkpointed/resumable) and PRG-04 (batched). Every application-level DELETE of tenant rows must be explicit and batched (see FK Graph section) — the org row is deliberately never removed, by construction, forever.

**Warning signs:** Any code path that calls `db.delete(organization)` or raw `DELETE FROM organization` anywhere in the purge worker is a design error, not a style nit.

### Pitfall 3: Assuming the `campaigns_scan`/`flows_scan` gap is the whole gap

**What goes wrong:** CONTEXT.md names `campaigns_scan` (campaign-scheduler) and `flows_scan` (flow-segment-sweep) as the two RLS scan policies that don't check `organization.deletedAt`. A third, structurally identical policy — `flow_runs_scan`, consumed by `flow-reconciliation.worker.ts`'s `findDueFlowRunCandidates` (`status = 'waiting' AND next_wake_at <= now()`) — has the exact same gap [VERIFIED: `packages/db/migrations/0042_scan_role_grants_and_policies.sql:28-30`]. If only the two named policies are patched, a deleted workspace's flow runs keep waking and advancing for up to 30 days: the dispatch-time gate (D-01) blocks the actual email, but flow-run state (`current_node_id`, `exited_at`, etc.) keeps mutating and excluded-send facts keep accumulating — directly contradicting D-02's "a workspace restored during retention finds its campaigns and flows exactly as the tenant left them."

**Why it happens:** CONTEXT.md's own gap-discovery pass named the two policies its own dispatch-path audit found; `flow_runs_scan` sits one hop away (a different worker, `flow-reconciliation.worker.ts`, not `flow-segment-sweep.worker.ts`) and was not in the direct trace.

**How to avoid:** Patch all three scan policies (`campaigns_scan`, `flows_scan`, `flow_runs_scan`) in the same migration, using the same `NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = <table>.workspace_id AND o."deletedAt" IS NOT NULL)` predicate shape. Note the column is quoted camelCase `"deletedAt"` in the physical schema (a better-auth `additionalField`), NOT snake_case `deleted_at` — see Code Examples.

**Warning signs:** A negative test that soft-deletes a workspace with a `waiting` flow run whose wake time has passed, ticks `flow-reconciliation.worker.ts`, and asserts the run did NOT advance — absent today, and this is exactly the test that would catch the gap if left unpatched.

### Pitfall 4: The test-send dispatch path has no `sends` row for D-03's exclusion mechanism to attach to

**What goes wrong:** `send-dispatch.ts`'s `kind === 'test'` branch explicitly documents (its own comment, D-12 from Phase 11) that test sends "skip the pre-send gate AND the ledger insert entirely... never has a claim to release" [VERIFIED: `apps/worker/src/queues/send-dispatch.ts` lines ~612-618]. D-01 requires a fail-closed dispatch-time kill on ALL three dispatch paths (campaign, flow, test-send); D-03 records that kill as an excluded-send fact on the `sends` table — but test-send never creates a `sends` row, so there is no row to write `exclusion_reason` onto.

**Why it happens:** D-03's mechanism was designed against the two paths that already share `evaluatePreSendGate` + a `sends` row (campaign, flow); test-send is architecturally the odd one out and was already documented as deliberately bypassing that shared gate for unrelated reasons (Phase 11 D-12: test sends aren't counted, aren't ledgered).

**How to avoid:** Give the test-send branch its own lightweight quiesce check (a plain `organization.deletedAt IS NOT NULL` lookup, or a check hoisted from the campaign row already read in `readSendPrereqs`) that short-circuits to a typed refusal/log line — not an attempted `recordExcluded` call, which would need a `sends` row that structurally doesn't exist on this path. This is a genuinely new decision point CONTEXT.md's D-01/D-03 pairing did not anticipate; flag it for the planner explicitly rather than silently reusing the campaign/flow shape.

**Warning signs:** A test that soft-deletes a workspace mid-flight and then enqueues a test-send job — if it "succeeds" (SendGrid gets called) or throws an unhandled error trying to write a `sends` row that was never created, this gap is live.

### Pitfall 5: Assuming `mega_crm_app` can delete `member`/`invitation` rows

**What goes wrong:** D-12 requires the purge to delete a workspace's `member` and pending `invitation` rows. `mega_crm_app` — the role the purge worker's normal DB pool connects as — was deliberately `REVOKE ALL PRIVILEGES`'d on `organization, member, invitation, "user"` and re-granted only `SELECT` on all four plus `UPDATE` on `organization` alone [VERIFIED: `packages/db/migrations/0045_auth_role_grants.sql:61,70-71`]. A plain `DELETE FROM member WHERE organization_id = $1` issued through the worker's normal pool will fail with Postgres error 42501 (permission denied), not silently no-op.

**Why it happens:** This grant partition is the Phase 10 "Better Auth trust boundary" (SEC-05/D-04/D-05) — a deliberate defense-in-depth measure so an app-level bug or injected query cannot mass-mutate identity/membership tables. It predates Phase 22's requirement and was never revisited for it.

**How to avoid:** See "Privilege Model for D-12" below — this needs an explicit plan-time decision, it is not free.

**Warning signs:** A live/integration test that actually attempts the `member`/`invitation` delete through the worker's ordinary pool will surface this immediately (42501) — a unit test that mocks the DB layer will not, so this must be caught by an integration-level test against a real Postgres instance with the real role grants, not a mock.

## Privilege Model for D-12 (resolves PT-01)

**PT-01 as originally framed ("grant migration on organization for `mega_crm_app` vs a dedicated elevated DSN, following the partition-relocation precedent") is answered differently for different parts of the purge:**

- **Tenant-table batched DELETE (the bulk of PRG-02/04):** No new privilege needed. `mega_crm_app` already owns every tenant table (migration 0041's own header: *"`mega_crm_app` owns every table in this database"*), and the purge deletes exactly one workspace's rows at a time through the existing `withTenant(workspaceId)` RLS scope — identical to how `erasure-scrub.worker.ts` already deletes/rewrites tenant rows today. `relocate-default.ts`'s `adminClient` requirement is for **DDL** (`CREATE TABLE`, `ATTACH PARTITION`) — the purge does no DDL at all (PRG-04 explicitly forbids DROP/DETACH), so that precedent's justification does not transfer.
- **`organization` tombstone UPDATE (D-09):** No new privilege needed. `mega_crm_app` already has `UPDATE` on `organization` (migration 0045 line 71), used today by `workspaces.ts`'s existing soft-delete route.
- **Cross-tenant eligibility discovery (D-05, "which workspaces are past retention"):** No new privilege needed. `organization` carries no RLS at all (documented in migration 0042's own comment); a plain dedicated pool connecting as `mega_crm_app` (same shape as `partition-maintenance.worker.ts`'s `partitionMaintenancePool`) can already `SELECT * FROM organization WHERE "deletedAt" IS NOT NULL` with zero policy friction. `mega_crm_scan` is not even required for this (unlike `campaigns_scan`/`flows_scan`, which need role-scoped predicate narrowing because `campaigns`/`flows` carry per-row tenant RLS `organization` does not).
- **`member`/`invitation` DELETE (D-12) — the one genuine gap:** `mega_crm_app` structurally cannot do this (Pitfall 5). Two real options, both requiring a plan-time decision:
  - **(a) Extend `mega_crm_app`'s grant** — a small migration adding `GRANT DELETE ON member, invitation TO mega_crm_app`. Cheapest to implement (no new pool/credential in `apps/worker`), but weakens the Phase 10 trust-boundary's defense-in-depth for *every* app code path, not just the purge — a bug or injected query anywhere in `mega_crm_app`'s surface gains the ability to delete membership rows it could not before.
  - **(b) Plumb `AUTH_DATABASE_URL` into `apps/worker`** (currently `apps/worker` has no env schema and no knowledge of this credential at all — only `apps/api` holds it) and open a dedicated pool authenticated as `mega_crm_auth` for exactly the `member`/`invitation` deletes, mirroring `relocate-default.ts`'s `adminClient` pattern but reusing the **existing** `mega_crm_auth` role (already fully granted `SELECT/INSERT/UPDATE/DELETE` on `member`/`invitation`, migration 0045 line 43) rather than inventing a new one. Preserves the trust boundary; costs one new credential/pool wired into a process that has never held it before.

  This research recommends **(b)** — it keeps the Phase 10 security boundary intact and the incremental cost (one new env var + one new pool in `apps/worker`, following an established pattern) is small — but this is a genuine tradeoff with security implications on both sides, not a fact that resolves itself from the evidence alone. **Flag as a plan-time decision requiring explicit confirmation**, not a research-settled fact.

## Ingestion Quiesce Wiring (D-04)

- **Events API** (`apps/api/src/modules/events/events-api.routes.ts`): `workspaceId` is resolved from the verified API key before any handler logic runs (`apiKeyAuth` hook). Add the `organization.deletedAt` check either inside `apiKeyAuth` itself or as an additional `onRequest`/`preHandler` step immediately after it, returning a typed 4xx refusal before the batch is ever enqueued to `eventsIngestQueue`.
- **Webhook route** (`apps/api/src/modules/webhooks/webhooks.routes.ts`): `endpoint.workspaceId` is resolved by `findWebhookEndpointByToken(pathToken)` BEFORE signature verification. CLAUDE.md forbids parsing the body before signature verification, but the quiesce check does not require parsing the body — it only needs `endpoint.workspaceId`, already available at that point. Recommend checking `deletedAt` immediately after the `pathToken` lookup and returning the SAME generic 404 the "unknown pathToken" branch already returns (T-05-03's existing "no enumeration oracle" discipline) — do not invent a distinguishable status code for "workspace deleted" on this anonymous, unauthenticated surface. Signature verification still happens for a live (non-deleted) workspace exactly as today; a deleted workspace never reaches that step at all, avoiding the DROP/quarantine ambiguity CONTEXT.md's D-04 left as discretion (recommend "drop before journal write" — never write to `ingress_journal` for a quiesced workspace, since that table's own purpose is proving delivery accountability the tenant no longer has standing to receive).

## Open Questions

1. **Already-enqueued worker-side jobs during the quiesce window.** The API-level refusals above (events API, webhook route) close the *ingress* side, but do NOT retroactively stop a job already sitting in `eventsIngestQueue`/`webhook-events` BullMQ queues at the moment of soft delete — those workers (`events-ingest.worker.ts`, `webhook-events.worker.ts`) will still process already-queued jobs and write `contacts`/`events`/`send_events` rows for a few seconds to minutes after soft delete.
   - What we know: This is a small, bounded window (typical BullMQ processing latency), not an ongoing leak — it self-resolves once the queue drains, unlike the `campaigns_scan`/`flows_scan`/`flow_runs_scan` gap (which would recur every tick for 30 days if unpatched).
   - What's unclear: Whether this bounded drain window is an acceptable, documented gap (matching the CONTEXT.md's own precedent of "late webhook evidence... deliberately sacrificed") or whether the two ingestion workers also need an `organization.deletedAt` check added at the top of their processors.
   - Recommendation: Document the bounded-drain-window gap explicitly (in `SPECIFICATION.md`'s §5/§6 update this phase already owes) rather than silently accepting it; if the planner wants zero-tolerance, add the same `deletedAt` check to both workers' processor entry points — cheap to add given the API-level pattern already exists.

2. **Should the purge attempt SendGrid-side webhook deprovisioning before destroying the key ciphertext?** D-11 destroys the workspace's SendGrid API key ciphertext + DEK. `sendgrid-webhook-provision.ts` presumably called SendGrid's API to register the webhook using that same key at connect time. Once the ciphertext is destroyed, the platform permanently loses the ability to deprovision that webhook registration on SendGrid's side (an orphaned webhook subscription in the tenant's own SendGrid account, pointing at a now-tombstoned `pathToken` that returns generic 404 forever).
   - What we know: CONTEXT.md's scope explicitly excludes "re-planning of existing subsystems... queues" and doesn't mention outbound SendGrid API calls as part of purge at all.
   - What's unclear: Whether making an outbound call to the tenant's own (about-to-be-destroyed) SendGrid account is in scope, given it happens after the tenant has already requested deletion and the platform is about to lose the credential that would let it clean up.
   - Recommendation: Flag for the planner as an explicit scope decision (in scope with an ordering constraint: must happen strictly BEFORE ciphertext destruction, since it's a one-way door same as D-14's point of no return) or explicitly deferred/out-of-scope, but do not let it fall through silently — the ordering is irreversible once missed.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | SendGrid's platform-side behavior when a webhook subscription's target URL starts 404ing indefinitely (does it auto-disable, alert the tenant, retry forever) is not verified against SendGrid's own docs in this session | Open Questions #2 | Low — this affects only the tenant's now-purged SendGrid account, not this platform's own data integrity; informs but does not block the purge design |

**All other claims in this document are `[VERIFIED]` via direct grep/read against the live codebase (schema files, migrations, worker source) or `[CITED]` against files this repository already treats as authoritative (`docs/PII-INVENTORY.md`, `docs/runbooks/backups.md`).** No package-name or library-existence claims required verification since no new packages are introduced this phase.

## Code Examples

### Extending a scan-role RLS policy predicate to exclude soft-deleted workspaces

```sql
-- Source: pattern derived from packages/db/migrations/0042_scan_role_grants_and_policies.sql
-- (existing predicate shape) — the organization table needs NO new grant,
-- mega_crm_scan already has table-level SELECT on it (0042 line 9).
-- NOTE: the physical column is quoted camelCase "deletedAt" (better-auth
-- additionalField, packages/db/src/schema/auth.ts), NOT deleted_at.

DROP POLICY campaigns_scan ON campaigns;
CREATE POLICY campaigns_scan ON campaigns
  FOR SELECT TO mega_crm_scan
  USING (
    status = 'scheduled' AND scheduled_at <= now()
    AND NOT EXISTS (
      SELECT 1 FROM organization o
      WHERE o.id = campaigns.workspace_id AND o."deletedAt" IS NOT NULL
    )
  );

-- Repeat identically for flows_scan (on flows.workspace_id) and
-- flow_runs_scan (on flow_runs.workspace_id) in the SAME migration --
-- Pitfall 3 above documents why all three must move together.
```

### Relaxing `erasure_records.contact_id` so contact deletion doesn't cascade-destroy purge evidence

```sql
-- Source: pattern derived from packages/db/migrations/0059_contact_erasure.sql's
-- own CREATE TABLE statement (contact_id uuid NOT NULL REFERENCES contacts(id)
-- ON DELETE CASCADE) -- this migration relaxes exactly that one constraint.

ALTER TABLE erasure_records ALTER COLUMN contact_id DROP NOT NULL;
ALTER TABLE erasure_records DROP CONSTRAINT erasure_records_contact_id_fkey;
ALTER TABLE erasure_records
  ADD CONSTRAINT erasure_records_contact_id_fkey
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL;
```

### Purge checkpoint table shape (platform-level, no RLS, no cascade-linked FK)

```typescript
// Pattern derived from packages/db/src/schema/ops-alert-state.ts and
// packages/db/src/schema/erasure-records.ts's status-machine shape.
// Deliberately NO `.references(() => organization.id, { onDelete: "cascade" })`
// on workspaceId -- unlike every tenant table, this row must remain
// addressable and stable even though its own organization row survives
// only as a scrubbed tombstone, and it must never be a candidate for any
// future cascade change to that tombstone row.
export const purgeRecords = pgTable("purge_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(), // no FK -- survives independently
  softDeletedAt: timestamp("soft_deleted_at", { withTimezone: true }).notNull(),
  eligibleAt: timestamp("eligible_at", { withTimezone: true }).notNull(),
  reportedAt: timestamp("reported_at", { withTimezone: true }), // D-07 announce-then-act
  firstDestructiveBatchAt: timestamp("first_destructive_batch_at", { withTimezone: true }), // D-14 point of no return
  purgedAt: timestamp("purged_at", { withTimezone: true }),
  status: text("status").notNull().default("pending"), // pending | reported | purging | complete | failed
  tableCounts: jsonb("table_counts"), // per-table destroyed-row counts, D-10's evidence payload
  purgeError: text("purge_error"),
});
// No ENABLE ROW LEVEL SECURITY -- same "role identity is the boundary"
// precedent as ops_alert_state/dead_letter_jobs/partition_maintenance_runs.
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| Erasure checkpoint stored ON the tenant-scoped evidence row itself (`erasure_records.sends_scrub_cursor`) | Checkpoint must live on a NEW platform-level, non-RLS table for workspace purge | This phase (PRG-03's explicit requirement) | The erasure-scrub pattern cannot be reused verbatim — its checkpoint-storage location assumption (a still-living tenant row) breaks when the tables it walks are themselves being destroyed |

**Deprecated/outdated:** None — every precedent this phase builds on is current, in-tree code from Phases 9-16, not a library or external API.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.x [ASSUMED: version from project stack doc; not independently re-verified in this session against installed package.json] |
| Config file | Existing `vitest.config.ts` per package (unchanged by this phase) |
| Quick run command | `npm run test -- erasure-scrub` (per-file targeting, existing convention) |
| Full suite command | `npm test` (root workspace script, existing convention) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PRG-06 | `campaigns_scan`/`flows_scan`/`flow_runs_scan` exclude soft-deleted workspaces | integration (real Postgres, real RLS) | `npm run test -- campaign-scheduler` / `flow-segment-sweep` / `flow-reconciliation` | ❌ new assertions on existing files |
| PRG-06 | Dispatch-time kill fires for an in-flight job on all three send paths incl. test-send | integration | `npm run test -- send-dispatch` | ❌ new test, existing file |
| PRG-02 | `erasure_records` survives a purge that deletes its contact | integration | new test file, e.g. `apps/worker/src/queues/__tests__/workspace-purge.test.ts` | ❌ Wave 0 |
| PRG-03 | Purge killed mid-run (real SIGKILL) resumes and completes | failure-injection | mirrors `apps/worker/src/queues/__tests__/failure-injection/erasure-scrub-resume.test.ts` | ❌ Wave 0, but direct precedent exists to copy the harness shape from |
| PRG-04 | Another workspace's rows in the same partition are unchanged (negative test) | integration | mirrors the existing 38-test negative-cross-tenant genre | ❌ Wave 0 |
| PRG-05 | A workspace restored after purge was enqueued is refused, not silently skipped | integration | new test, exercises the restore CLI racing a purge batch | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** targeted `npm run test -- <touched-file-stem>`
- **Per wave merge:** `npm test` (full suite)
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `apps/worker/src/queues/__tests__/workspace-purge.test.ts` — covers PRG-02/03/05
- [ ] `apps/worker/src/queues/__tests__/failure-injection/workspace-purge-resume.test.ts` — covers PRG-03's SIGKILL requirement, mirrors `erasure-scrub-resume.test.ts`'s harness
- [ ] `packages/db/src/partitions/__tests__/` addition or sibling — covers PRG-04's negative cross-tenant-partition-safety test
- [ ] New migration test coverage for the `erasure_records` FK relax and the three scan-policy predicate changes (mirrors existing `test:migrations` discipline noted in STATE.md's operational prerequisites)

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | Purge is an internal worker process; no new auth surface |
| V3 Session Management | no | — |
| V4 Access Control | yes | Postgres role/grant partitioning (mega_crm_app / mega_crm_auth / mega_crm_scan) — extended, not replaced, by this phase; RLS `withTenant` scoping for all tenant-table deletes |
| V5 Input Validation | yes | `WORKSPACE_PURGE_RETENTION_DAYS` boot-validated via Zod (`z.coerce.number().int().min(...)`), same pattern as existing env validators |
| V6 Cryptography | yes | KMS envelope-encrypted secret destruction (SendGrid key DEK/ciphertext, suppression HMAC key) — never hand-rolled, reuses existing `@mega-crm/kms` destroy path |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Privilege creep via a "just add the grant" fix to D-12's member/invitation gap | Elevation of Privilege | Prefer the dedicated `mega_crm_auth`-authenticated connection over extending `mega_crm_app`'s grant (see Privilege Model section) — keeps the Phase 10 trust boundary's blast-radius argument intact |
| Cascade-triggered mass deletion outside the purge's own batch/checkpoint control | Tampering / Denial of Service (self-inflicted) | Never issue a DELETE against any table that is the target of an `ON DELETE CASCADE` from a not-yet-emptied child (see FK Graph ordering) — an accidental early-order delete could silently cascade thousands of rows outside the checkpointed batch loop, defeating PRG-03/04 without any error being raised |
| Enumeration oracle on the webhook route distinguishing "deleted workspace" from "unknown token" | Information Disclosure | Reuse the existing generic-404 response for both cases (see Ingestion Quiesce Wiring) — do not add a distinguishable status/message for the deleted-workspace case on this anonymous surface |
| A restored workspace's overdue `scheduled` campaign silently firing on the next scheduler tick | Tampering (unintended state transition) | D-15: restore CLI must flip overdue `scheduled` campaigns to `draft` inside the same transaction as clearing `deletedAt`, not rely on the scheduler's own re-check to catch it after the fact (a race exists between "restore commits" and "scheduler's next tick" otherwise) |

## Sources

### Primary (HIGH confidence — direct codebase read/grep this session)
- `packages/db/src/schema/*.ts` (all 27+ tenant table schemas) — FK graph, cascade rules
- `packages/db/migrations/0001, 0041, 0042, 0044, 0045, 0059, 0065` — RLS policy shapes, grant partitioning history, erasure_records constraint definition
- `apps/worker/src/queues/erasure-scrub.worker.ts` + `erasure-scrub-checkpoint.ts` — checkpoint pattern
- `packages/db/src/partitions/relocate-default.ts` — batched-DELETE/advisory-lock pattern
- `apps/worker/src/queues/partition-maintenance.worker.ts` — scheduled-tick worker shape
- `apps/worker/src/queues/campaign-scheduler.worker.ts`, `flow-segment-sweep.worker.ts` — scan-policy gap (grep-confirmed absence of `deletedAt` check)
- `apps/worker/src/queues/send-dispatch.ts` — `evaluatePreSendGate` call sites, test-send bypass (lines ~612-618)
- `packages/delivery-core/src/pre-send-gate.ts` — the shared fail-closed gate
- `apps/api/src/modules/tenancy/workspaces.ts`, `workspace-lookup.ts` — soft-delete route, `deletedAt` filtering precedent
- `apps/api/src/modules/events/events-api.routes.ts`, `apps/api/src/modules/webhooks/webhooks.routes.ts` — ingestion entry points
- `docs/PII-INVENTORY.md` — per-contact PII authority
- `docs/runbooks/backups.md`, `docker/pgbackrest/pgbackrest.conf` — pgBackRest retention (`repo1-retention-full=2`, count-based)
- `docker/init-app-role.sql` — role identity (`mega_crm_app` is DB owner, NOBYPASSRLS)
- `apps/api/src/env.ts` — env-floor validation pattern (`MAX_UNSUBSCRIBE_PREVIOUS_SECRETS`, `z.coerce.number()...refine()`)
- `package.json` files (root, apps/api, apps/worker, packages/db) — installed version confirmation

### Secondary (MEDIUM confidence)
- Vitest version cited from the project's own CLAUDE.md technology stack table, not re-verified against installed `package.json` in this session

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new packages, all versions read directly from package.json
- Architecture / FK graph / privilege model: HIGH — every claim grep/read-verified against live schema and migration files this session
- Pitfalls: HIGH for the three schema-level findings (FK cascade, RLS gap, test-send bypass); MEDIUM for the worker-drain-window Open Question (bounded but not measured)

**Research date:** 2026-08-23
**Valid until:** 30 days (stable, in-tree architectural findings; not dependent on any external library's release cadence)
