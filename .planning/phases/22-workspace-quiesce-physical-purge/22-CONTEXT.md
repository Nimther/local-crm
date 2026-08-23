# Phase 22: Workspace Quiesce & Physical Purge - Context

**Gathered:** 2026-08-23
**Status:** Ready for planning

<domain>
## Phase Boundary

Two capabilities. (1) **Quiesce:** a soft-deleted workspace stops all activity immediately — scheduled and in-flight campaigns and flow dispatches produce no further mail, and (per this discussion) event ingestion and inbound webhook processing stop too. (2) **Physical purge:** once the operator-configured platform retention has elapsed, the workspace's PII across every tenant table is deleted or anonymized and its secrets (SendGrid key ciphertext, DEK, webhook endpoints, per-workspace HMAC suppression key) are destroyed — while compliance evidence that must outlive the tenant survives and stays readable. The purge is idempotent, resumable across a real SIGKILL, batched-DELETE-only inside shared partitions (no DROP/DETACH/TRUNCATE), provably leaves other workspaces' rows unchanged, and re-checks eligibility inside every batch so a restored workspace is refused, never silently skipped. Requirements: PRG-01..PRG-06.

**Non-negotiable (locked by ROADMAP success criteria):** immediate send stop on soft delete (SC1); PII + secrets gone after retention with evidence intact (SC2); SIGKILL-resume + idempotent re-run (SC3); partition-neighbour safety by negative test, no DROP/DETACH/TRUNCATE (SC4); per-batch eligibility re-check with refuse-not-skip semantics (SC5).

**Scope limits:** no per-workspace retention configuration (platform default only — REQUIREMENTS.md Out of Scope); no tenant self-service restore UI; no re-planning of existing subsystems (RLS, KMS, queues, erasure, backups) — purge integrates into them.

</domain>

<decisions>
## Implementation Decisions

### Quiesce semantics (PRG-06)
- **D-01:** Quiesce enforcement lives at **both layers**: the cross-workspace discovery queries (`campaigns_scan` in campaign-scheduler, `flows_scan` in flow-segment-sweep — neither checks `organization.deletedAt` today) exclude soft-deleted workspaces so no new work is enqueued, AND a **fail-closed dispatch-time check** in the send path kills jobs already in flight. Defense-in-depth on the suppression-gate precedent: a job enqueued seconds before soft-delete still cannot send.
- **D-02:** Soft delete **freezes, never cancels**: no campaign/flow state mutation at soft-delete time — both quiesce layers simply refuse work while `deletedAt` is set. A workspace restored during retention finds its campaigns and flows exactly as the tenant left them (subject to D-16). Purge destroys the state later anyway.
- **D-03:** A dispatch-gate refusal is recorded as an **excluded send fact**: the send row takes the existing `excluded` status with a new `exclusion_reason` (e.g. `workspace_deleted`) — same mechanism as suppression exclusions, honest and queryable, consistent with the Phase 11 state-machine discipline. Never a silent job ack that leaves a send stuck in `queued` for the reconciler to chase.
- **D-04:** **Ingestion quiesces too**: a deleted workspace's API keys stop accepting events (typed refusal on the events API), and inbound SendGrid webhook events for it are dropped/quarantined rather than processed. Nothing accumulates new PII in a workspace awaiting purge. (Planner note: late webhook evidence for pre-delete mail is deliberately sacrificed for the compliance-clean reading — the user chose full quiesce over the evidence-completion variant.)

### Retention & purge triggering (PRG-01)
- **D-05:** Purge initiation is an **automatic worker tick** (partition-maintenance worker pattern): the worker discovers eligible workspaces (`deletedAt + retention elapsed`) and purges unattended. GDPR-honest — deletion happens by construction, not operator memory. The Phase 9 "destructive = operator-invoked CLI only" precedent is explicitly NOT followed here: that rule protected live tenants; this tenant asked for deletion and retention has expired, and PRG-05's per-batch eligibility re-check is the safety net.
- **D-06:** Retention default **30 days**, delivered via env (name at planner's discretion, e.g. `WORKSPACE_PURGE_RETENTION_DAYS`), with a **boot-validated floor** (e.g. ≥7 days) so a typo like `0` cannot make soft-delete instantly destructive.
- **D-07:** **Report-only first tick**: the worker always emits an eligibility report (workspace, deletedAt, per-table row counts) at least one full tick BEFORE that workspace's first destructive batch — announce-then-act built into the purge state machine, not an env-flag dry-run mode someone forgets to flip back. Plus an operator CLI that prints the same report on demand.
- **D-08:** Observability: a **stuck/failed purge raises an operator alert** through the existing `ops_alert_state` watchdog machinery (started-but-not-finished-within-N-days = alert); successful completion is a structured log line plus the durable purge record (D-10). Alerts are reserved for failure, matching the existing nine-watchdog discipline.

### PII scope & surviving evidence (PRG-02)
- **D-09:** The `organization` row becomes an **anonymized tombstone**: name/slug/PII scrubbed, `deletedAt` kept, a `purged_at` marker added. The workspace id stays resolvable as the FK anchor for surviving evidence, idempotent re-runs can verify "already purged", and the slug is freed by the scrub. Workspace-level mirror of the Phase 13 contact-anonymization model. — **Reversibility:** one-way — the scrub destroys the org row's identity fields; only the purge_records/tombstone pair proves what it was.
- **D-10:** **Surviving evidence set (everything else is deleted):** (a) `erasure_records` — proof of individual GDPR erasures performed while the workspace lived; (b) a **new `purge_records` row** — durable, PII-free record of the purge itself (workspace id, soft-deleted at, purged at, per-table destroyed-row counts), the workspace-level analog of `erasure_records`; (c) **hashed suppression rows** — proof suppression was honored, kept as immutable timestamped evidence; (d) **aggregate daily metrics** — count-only rollups as sending-history/dispute evidence. — **Reversibility:** costly — this enumeration defines what PRG-02's "evidence that must outlive the tenant" MEANS; widening later is easy, narrowing after a purge has run is impossible for already-purged tenants.
- **D-11:** The **per-workspace HMAC suppression key is destroyed** with the other secrets. Surviving suppression rows become permanently unmatchable — cryptographic erasure that strengthens the privacy claim (nobody, including the platform, can ever test an email against them) while the rows still prove enforcement. The evidential trade-off (no future "you mailed me after I unsubscribed" re-check) was made knowingly.
- **D-12:** Auth reach: purge deletes **this workspace's membership rows and pending invitations** (invitee emails are PII). Better Auth `user`/`session`/`account` rows are untouched — global identities that may belong to other workspaces; a user left with zero workspaces simply has an empty workspace list. Respects the Phase 10 `mega_crm_auth` trust boundary; no orphaned-user cleanup this phase.

### Restore semantics (PRG-05)
- **D-13:** Phase 22 **ships a minimal operator-only restore CLI** (relocate-default CLI precedent): clears `deletedAt`, refuses if the point of no return (D-14) has passed. Gives PRG-05 a real path to guard, gives the 30-day window a real recovery story, and makes the restore-vs-purge race testable end-to-end. No UI, no tenant self-service.
- **D-14:** **Point of no return = the first destructive batch.** Restore succeeds any time before the first row is destroyed (including during the report-only tick); once destruction begins, restore refuses with a typed error — a partially-purged workspace must never come back live. The purge state machine records the transition and both sides (restore CLI, purge batches) check it under the same lock/claim discipline. — **Reversibility:** one-way — this boundary is exactly the line between recoverable and destroyed data; it cannot be relaxed after any production purge has crossed it.
- **D-15:** *(interacts with D-02)* On restore, an overdue `scheduled` campaign (its `scheduled_at` passed while the workspace was deleted) **never auto-fires**: the mechanism is planner's choice (restore CLI flips overdue campaigns back to draft, or the scheduler requires the window to be un-elapsed), but mail must not blast out on the tick after un-delete. Explicit human re-scheduling is the honest behavior.

### Plan-time decisions (NOT settled here — carry to research)
- **PT-01 (roadmap decision a):** privilege model for cross-tenant deletion — grant migration on `organization` (and auth tables) for `mega_crm_app` vs a dedicated elevated DSN following the partition-relocation precedent. Research-gated; the roadmap recommends a short architecture spike (multi-table FK ordering, privilege model). No user leaning was captured — decide on evidence.
- **PT-02 (roadmap decision c):** documented caveat that purged data persists in encrypted pgBackRest backups until backup retention expires — wording and placement (runbook + SPECIFICATION.md) at research/plan time.
- **PT-03:** exact quiesce wiring details for D-01's discovery layer (WHERE-clause vs join vs view; note `mega_crm_scan` may need SELECT on `organization.deleted_at` — the Phase 15 column-level-grant precedent, migration 0065, applies).

### Claude's Discretion
- Env var names, exact floor value for D-06, tick cadence, batch sizes (500-row erasure-scrub precedent suggested, not mandated), purge table/column naming.
- The purge state machine's exact states, claim primitive (advisory lock vs claimed_at column), and checkpoint storage shape — must live OUTSIDE tenant tables (PRG-03).
- Whether webhook events for a deleted workspace are dropped vs quarantined (D-04) — pick whichever keeps the ingress-journal invariants intact.
- Typed refusal shapes for quiesced ingestion and the restore CLI's error copy.
- FK deletion ordering across tenant tables — research/spike territory.
- Exclusion-reason literal, scan-filter mechanics, `purge_records` schema details.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & roadmap
- `.planning/REQUIREMENTS.md` — PRG-01..PRG-06 («Workspace Purge» section); Out of Scope table (per-workspace retention explicitly out)
- `.planning/ROADMAP.md` — Phase 22 section: goal, 5 success criteria, plan-time decisions (a)/(b)/(c), research flag (architecture spike recommended)

### The PII authority (the single most important doc)
- `docs/PII-INVENTORY.md` — per-table per-contact PII definition Phase 21 wrote FOR this phase; purge must delete/anonymize exactly what it lists, and the same-change rule requires updating it if any table/allowlist changes
- `packages/delivery-core` (shared allowlists, Phase 21 D-03) — `SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST` / export allowlist; purge scrub semantics must not diverge from these

### Soft delete & workspace lifecycle
- `apps/api/src/modules/tenancy/workspaces.ts` — D-20 Owner-only soft delete (sets `deletedAt` only; deliberately avoids better-auth's hard delete); the DELETE route purge/quiesce builds on
- `apps/api/src/modules/tenancy/workspace-lookup.ts` — `isNull(organization.deletedAt)` active-workspace filter (the read-side exclusion pattern)
- `packages/db/src/schema/auth.ts` — organization/member/invitation schema incl. `deletedAt`

### The quiesce gap (D-01 closes this)
- `apps/worker/src/queues/campaign-scheduler.worker.ts` — `campaigns_scan` cross-workspace discovery on `mega_crm_scan`; does NOT check `organization.deletedAt` today
- `apps/worker/src/queues/flows/flow-segment-sweep.worker.ts` — `flows_scan`, same gap
- Send dispatch paths for the D-03 excluded-send-fact gate: `apps/worker/src/queues/send-dispatch.ts` (all three dispatch paths), suppression pre-send gate precedent

### Purge mechanics precedents
- `apps/worker/src/queues/erasure-scrub.worker.ts` + `erasure-scrub-checkpoint.ts` — checkpointed, resumable, 500-row-page batch scrub; the PRG-03 pattern
- `apps/worker/src/queues/erasure-scrub-reclaim.worker.ts` — reclaim pattern for work stranded between commit and enqueue
- `packages/db/src/partitions/relocate-default.ts` — batched cross-tenant DELETE inside shared partitions with SKIP LOCKED; the PRG-04 precedent AND the elevated-privilege precedent for PT-01
- `apps/worker/src/queues/partition-maintenance.worker.ts` — the scheduled-tick worker pattern D-05 follows; dead-man's-switch health-row + API-side watchdog pattern D-08 follows
- `packages/db/src/schema/erasure-records.ts` — the evidence-record shape `purge_records` (D-10) mirrors
- `packages/db/src/schema/ops-alert-state.ts` — keyed alert-state claim primitive for D-08

### Secrets to destroy
- `packages/db/src/schema/sendgrid-keys.ts` — SendGrid key ciphertext + wrapped DEK rows
- `packages/db/src/schema/workspace-suppression-keys.ts` — per-workspace HMAC key (D-11 destroys)
- `packages/db/src/schema/webhook-endpoints.ts` — workspace webhook endpoints (incl. `path_token`/`public_key` trust anchors); note Phase 15 migration 0065 column-level grant precedent

### As-built documentation to update in the same change
- `SPECIFICATION.md` — §4 (schema: purge_records, tombstone columns), §5 (new worker/queue), §6 (restore CLI, typed refusals), §3 (new env vars)
- `.claude/CLAUDE.md` — "Project Specification" same-change rule

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- Erasure-scrub checkpoint machinery (`erasure-scrub-checkpoint.ts`): checkpointed progress outside tenant tables, 500-row pages, SIGKILL-resume proven — the purge loop is this pattern generalized to many tables
- `relocate-default.ts`: batched DELETE across shared partitions with neighbour-safety discipline — the closest existing code to the purge's core loop, and the precedent for both PRG-04 tests and the PT-01 privilege question
- Partition-maintenance worker + `partition_maintenance_runs` health row + API-side watchdog: the scheduled-destructive-worker shape D-05/D-08 reuse
- `ops_alert_state` + `claimAlertSlot`: multi-replica-safe alert dedup for the stuck-purge watchdog
- `sends.exclusion_reason` excluded-status path: D-03 adds one reason literal to an existing mechanism
- `erasure_records` schema: the template for `purge_records`
- Phase 15 migration 0065 (column-level `GRANT SELECT`): the precedent if `mega_crm_scan` needs to read `organization.deleted_at` (PT-03)

### Established Patterns
- Fail-closed pre-send gates (suppression, frequency cap) — D-01's dispatch gate joins this chain
- Evidence-preserving anonymization over deletion (Phase 13) — D-09/D-10/D-11 extend it to workspace level
- Boot-time env validation (fail-loud, three-validator unsubscribe-secret precedent) — D-06's retention floor
- Operator-invoked CLI with non-zero exit on refusal (`relocate:default-partition-rows`) — D-13's restore CLI shape
- Two-process dead-man's switch (worker writes health row, API watchdog alerts) — D-08
- Negative cross-tenant tests as proof (38 existing) — SC4's neighbour-unchanged test follows this genre
- Real-SIGKILL failure-injection scenarios in CI (Phase 8/11/12) — SC3's kill-resume proof has harness precedent

### Integration Points
- `workspaces.ts` DELETE route — quiesce is triggered by state this route already writes; restore CLI is its inverse
- `campaign-scheduler` / `flow-segment-sweep` discovery queries — D-01 filter lands here
- `send-dispatch.ts` three dispatch paths — D-03 gate joins the existing per-path gate chain
- Events API key auth + webhook ingest path — D-04 refusals land at these two entries
- Worker queue registry + Bull Board — new purge queue/worker registers like the other tick workers
- `docs/PII-INVENTORY.md` — purge coverage must be reconciled against it table-by-table; any divergence updates the doc in the same change

</code_context>

<specifics>
## Specific Ideas

- The user again consistently chose the compliance-honest, fail-closed option at every fork: full ingestion quiesce over evidence-completion convenience, automatic purge over operator-memory, validated retention floor, announce-then-act reporting, cryptographic erasure of the HMAC key, refuse-not-skip restore semantics, never-auto-fire on restore. Planner should resolve micro-ambiguities in the same direction.
- "Freeze means freeze" has one deliberate exception (D-15): overdue scheduled campaigns must not fire on restore — surprise mail is worse than surprise silence.
- The purge state machine's point-of-no-return (D-14) should be designed first — the restore CLI, the report-only tick, and the destructive loop all hang off it.

</specifics>

<deferred>
## Deferred Ideas

- **Owner-facing restore in UI** — tenant self-service un-delete within the retention window. A new user-facing capability; the operator CLI (D-13) covers the mechanism this phase. Revisit if tenants ask.
- **Orphaned Better Auth user cleanup** — deleting user accounts left with zero workspaces after purge. Its own lifecycle question (touches the auth trust boundary, races with signups); explicitly out of D-12.
- **Durable DSR export audit table** (`dsr_export_records`) — carried from Phase 21's deferred list; `purge_records` (D-10) is its natural companion if a compliance requirement for export evidence emerges.

</deferred>

---

*Phase: 22-Workspace Quiesce & Physical Purge*
*Context gathered: 2026-08-23*
