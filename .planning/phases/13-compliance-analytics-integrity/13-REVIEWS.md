---
phase: 13
reviewers: [claude]
reviewed_at: 2026-08-11T12:56:41Z
plans_reviewed: [13-01-PLAN.md, 13-02-PLAN.md, 13-03-PLAN.md, 13-04-PLAN.md, 13-05-PLAN.md, 13-06-PLAN.md, 13-07-PLAN.md, 13-08-PLAN.md, 13-09-PLAN.md, 13-10-PLAN.md, 13-11-PLAN.md, 13-12-PLAN.md, 13-13-PLAN.md, 13-14-PLAN.md]
note: >
  Single-reviewer run. Only the claude CLI was available on this machine; the user
  explicitly opted to run it despite the same-vendor self-review caveat (fresh headless
  session, source-grounded against the repo). No cross-vendor consensus is possible.
---

# Cross-AI Plan Review — Phase 13

## Claude Review

# Cross-AI Plan Review — Phase 13: Compliance & Analytics Integrity (14 plans)

**Review basis:** every load-bearing claim was checked against the repository at `/Users/primeropanther/Projects/mega-crm` (webhook route/worker, reconciler, campaign repository, unsubscribe route, contact repository, schemas, migrations 0020/0042/0044/0053/0054, migration journal, package manifests, npm scripts, watchdogs, queue-core, redaction rules).

## 1. Summary

This is an unusually well-grounded plan set: nearly every file, line range, constant, and pattern citation checks out against the actual code, and several plans correct genuine errors in their own upstream research (13-07's correction of RESEARCH A1 and its rejection of `ADD CONSTRAINT … UNIQUE USING INDEX` on partitioned tables are both verified accurate). The architecture consistently reuses proven in-repo siblings rather than inventing machinery. However, verification against source surfaced three HIGH-severity integration gaps the plans do not close: (1) journal rows for batches that the worker legitimately skips before opening its tenant transaction are never marked ingested and will become false "poison" alerts; (2) the ingestion-health watchdog is directed to read an RLS-forced table on a scan role that is never granted access to it; (3) contact anonymization leaves `external_id` intact while the shared upsert resolves identity external_id-first, creating a resurrection-or-unique-violation path that undoes erasure. A systemic cross-app import-boundary problem (apps/api ↔ apps/worker) is anticipated in one plan but hit un-anticipated in three others. All are fixable with targeted plan edits; none invalidates the phase design.

## 2. Strengths

- **13-03's diagnosis is exact.** The four-key ledger allow-list that silently drops `reconciling`/`unknown` is at `apps/api/src/modules/campaigns/campaign.repository.ts:426-430`, precisely as claimed; the sum-to-total must-have is the right structural fix.
- **13-02's UTC defect is real and fully enumerated.** Exactly eight bare `::date` comparisons exist in `reconcileWorkspaceDay` (`apps/worker/src/queues/analytics-reconciliation.worker.ts:73-82`), and every `sends.*_at` fact column is `timestamptz` (`packages/db/src/schema/sends.ts:89-96`), so the session-TZ hazard is genuine, not hypothetical. The scheduler-registration target (`analytics-reconcile-tick`, worker line 21) exists, and the test file already carries an `analytics-reconcile` block (`scheduler-registration.test.ts:62-63`) — Task 3's "extend rather than duplicate" contingency correctly anticipated this.
- **13-08's deviation from RESEARCH/PATTERNS is verified correct.** `packages/contacts-core/package.json:12` declares `@mega-crm/delivery-core` as a dependency, so the researched placement (helper in delivery-core importing `recordSubscriptionStatusChange` from contacts-core) really would be a cycle. The unsubscribe token really carries `sendId` (`packages/delivery-core/src/unsubscribe-token.ts:15`), and the route transaction really never touches `sends` (`unsubscribe.routes.ts:191-219`) — the CMP-01 gap is as described.
- **13-07 catches its own research's mistakes.** `open_count`/`click_count` increment inside the `newRows` loop (`webhook-events.worker.ts:291,303`) — gated by the dedup insert, contradicting RESEARCH A1 — and the plan pins the resulting same-second collapse with a two-sided test instead of inheriting the false reassurance. The old inline `UNIQUE (workspace_id, sg_event_id, occurred_at)` exists at `0020_send_events_partitioned.sql:45` with an auto-generated name, matching the plan's "read the catalog, don't guess" caution. The doc comment the plan orders rewritten-not-appended (`send-events.ts:22-32`, "the sole natural key that matters") exists verbatim.
- **13-09's anti-pattern warning is grounded.** `dead_letter_alert_state` is `id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1)` with a seed INSERT (`0054_dead_letter_jobs.sql:65-84`) — the singleton shape a naive copy would inherit. The observed/alerted disjoint-column split is a clean answer to the two-writer problem.
- **13-11 copies a real, proven shape.** Claim-before-send, guarded slot release on `sendMail` rejection, and interval-level catch are all present in `dead-letter-watchdog.ts:165-233` exactly as the plan describes; the tier-escalation disjunct is correctly identified as the only genuinely new logic.
- **Migration bookkeeping is correct.** The journal ends at idx 54, so 0055–0061 numbering is right, wave-ordered, and collision-free; 13-09's comment that its `depends_on: [13-07]` is migration-ordering only is honest and useful.
- **Deploy/regression hygiene is threaded consistently:** the G-12-1 conditional-`autorun` guard, `@mega-crm/queue-core` factory usage (verified: `connection.ts`, `queue-options.ts`, `error-listeners.ts` exist), `schemaVersion` convention (the doc comment at `shared-schemas/src/queues.ts:87-97` explicitly notes `webhookEventsJobSchema` lacks it today), and the drizzle-kit-hangs caveat with `test:migrations` as the proof mechanism appear in every plan that needs them.
- **All referenced infrastructure exists as cited:** `failure:all` aggregate (`package.json:40`), `verify:redis-config`, `coverage:gate`, `platform-mail/client.ts`, `OPERATOR_ALERT_EMAIL`/`PLATFORM_MAIL_FROM` in `env.ts:24-35`, `flow-segment-sweep-checkpoint.ts` helpers, `REDACTION_RULES` key/value rules, `events.contact_id` (13-13's link path), the `(workspace_id, send_id)` index on `send_events` (`0020:65`) that the scrub walk needs, all six `webhook-events-*.test.ts` suites named in verify blocks, and `COVERAGE.md` for 13-14.
- **13-12's call-site count is verifiable and correct:** exactly three code sites touch `workspace_suppressions` (`contact.repository.ts` api-side insert, `webhook-events.worker.ts:198-204` `applySuppression` insert, `contacts-core/contact-repository.ts:46` `isEmailSuppressed` read); the delivery-core hit is a doc comment only.

## 3. Concerns

### HIGH

- **[13-01 / 13-06 / 13-11] Fully-skipped batches never get their journal row marked ingested — guaranteed false poison alerts.** `processWebhookEventBatch` early-returns at `webhook-events.worker.ts:514-516` (zero extractable events) and `:519-524` (every event sibling-dropped) *before* the tenant transaction where 13-01 places `markIngestionComplete`. Sibling-only batches are not an edge case — `dropSiblingWorkspaceEvents` exists precisely because shared BYO SendGrid keys make them a proven production scenario (Phase 10 SEC-09/WR-01). Under the plans as written, every such batch's journal row stays `ingestion_completed_at IS NULL`, is re-enqueued by 13-06's sweep until `WEBHOOK_REPLAY_MAX_ATTEMPTS`, and then surfaces to the operator through 13-11's watchdog as an attempt-capped "poison batch" — for correctly-handled deliveries. No plan's behavior list covers "a batch processed to completion with zero insertable rows still marks its journal row complete." (13-04 restructures the extraction path but its behavior list also never asserts journal completion for an all-quarantined batch.)
- **[13-11, with root cause in 13-01] The ingestion-health watchdog cannot read `ingress_journal` as specified.** 13-11 Task 1 directs `readIngestionHealth` "through the cross-workspace scan path, since `ingress_journal` is RLS-forced." But `mega_crm_scan` has only the explicit grants in `0042_scan_role_grants_and_policies.sql:9` (`flow_runs, flows, contacts, sends, organization`), and scan access to an RLS-forced table requires both a `GRANT SELECT` and a dedicated `_scan` policy (the `sends_scan` precedent). 13-01's migration 0055 creates only the `mega_crm_app` `workspace_isolation` policy; no plan adds a scan grant or policy for `ingress_journal`. As written, the watchdog's check throws permission-denied every interval, is swallowed by the interval's `scrubbedConsole.error` catch, and the CMP-08 alert never fires — silently. 13-09 explicitly checks 0042's grant list for its tables; 13-01/13-11 must do the same for the journal (and quarantine table, if 13-11 ever reads it).
- **[13-10] `external_id` survives anonymization and breaks erasure via the shared upsert.** `contacts` carries `contacts_workspace_external_id_unique` (`packages/db/src/schema/contacts.ts:55`), and the shared upsert resolves identity external_id-first (`packages/contacts-core/src/contact-repository.ts:98-115` — "A. external_id match → update in place"). The anonymizing UPDATE nulls email/name/phone/attributes but not `external_id`. Consequences the plan never addresses: an incoming event or CSV row carrying the erased contact's `external_id` either (a) matches the anonymized row and **repopulates PII in place** — silently undoing the erasure and potentially resuming mail — or (b), if the upsert lookup gains `anonymized_at IS NULL`, tries to create a new contact and hits the external_id unique violation, failing ingestion. The behavior list covers only the email analog ("creating a new contact with the former email…"), and `packages/contacts-core` (where the upsert lives) is absent from 13-10's `files_modified`. Either scrub `external_id` in the same UPDATE (it's nullable) with the same re-import semantics as email, or make an explicit, tested decision about anonymized-row matching in the shared upsert.

### MEDIUM

- **[13-04 / 13-06 / 13-08; 13-01 partially] The apps/api ↔ apps/worker import boundary is hit at four points and anticipated at only one.** `apps/worker` depends on `@mega-crm/api` **as a devDependency only** (`apps/worker/package.json:30`), and `apps/api` has no dependency on `apps/worker` at all. Production-code imports the plans require: (a) 13-01 — worker's `markIngestionComplete` from an apps/api module: *anticipated*, with a `packages/db` fallback ✓; (b) 13-04 — worker imports `writeQuarantinedEvent` from `apps/api/src/modules/webhooks/quarantine.ts`: **not anticipated**; (c) 13-06 — the replay-sweep worker "enqueues through the existing `enqueueWebhookBatch` path", an apps/api module that also imports apps/api's `env`: **not anticipated**; (d) 13-08 — the unsubscribe route must mirror "the webhook side's gating exactly" for the rollup increment, but `incrementWorkspaceDailyRollup` lives in `apps/worker/src/queues/analytics-rollup.ts` and `incrementCampaignCounter` is a private worker function — apps/api cannot import either: **not anticipated**. Risk: three executors independently invent placements (or worse, promote the devDep to a production dep). Decide the shared home once — journal/quarantine query helpers and the rollup increment most naturally join `packages/db` or `delivery-core` — and state it in each affected plan.
- **[13-13] The specified checkpoint storage does not exist.** `flow_segment_sweep_checkpoint` is keyed `(workspace_id, flow_id)` with `flow_id uuid NOT NULL REFERENCES flows(id) ON DELETE CASCADE` (`0053_flow_segment_sweep_checkpoint.sql`) — it cannot hold "an arbitrary key" (an erasure-record id fails the FK). The plan's fallback — "put the cursor on the `erasure_records` row itself using the columns plan 13-10 created" — also fails: 0059 creates `status`/timestamps/counts but **no cursor columns**, and Wave 7 "owns no migration slot" by 13-13's own statement. Resolve now by adding `sends_scrub_cursor`/`events_scrub_cursor` columns to `erasure_records` in 13-10's migration 0059 (cheap while that migration is unwritten).
- **[13-07] Two migration-mechanics gaps.** (1) Step 0's "bounded and batched … committing each batch" DELETE is not expressible in a hand-written SQL migration under this runner — a `DO` block is one transaction (no per-batch commits), and the `--> statement-breakpoint` convention doesn't give you loops. The realistic options (a pre-migration operator script à la `relocate-default-partition-rows`, or accepting a single guarded DELETE for the current data volume) should be chosen in the plan, not discovered mid-execution. (2) Dropping the old constraint (Step 4) in the same migration the new `ON CONFLICT` code requires creates a deploy window where **old** worker code's `ON CONFLICT (workspace_id, sg_event_id, occurred_at)` matches no constraint and every insert fails at runtime. Tolerable under stop-old-start-new (R-05), but the plan should say so — or defer the old-constraint drop to a follow-up migration, true expand/contract.
- **[13-04] Internal contradiction on `unusable` events.** Task 2's behavior list requires the quarantine row's reason to distinguish "too old" from "structurally not a timestamp" (i.e., unusable events *are* quarantined when they carry an `sg_event_id`), while `flagged_assumptions` states "`unusable` … is deliberately NOT quarantined while `rejected` is." An executor faces contradictory acceptance criteria; pick one (quarantining structurally-broken-timestamp events that still have an event id seems more consistent with "evidence for tuning the window").
- **[13-12] Missing manifest and write-path details.** `suppression-hash.ts` must import `@mega-crm/kms`, which `contacts-core` does not declare (deps: `delivery-core`, `pg`, `pino` only) — `packages/contacts-core/package.json` is absent from `files_modified`, and the new workspace-dep edge belongs in SPECIFICATION §2 (13-14 currently asserts "zero new dependencies" without qualifying workspace edges). Separately, the backfill is told to "use the cross-tenant read approach `audit-sends-history` established … introduce no new grant" — but the backfill *writes* `email_hash`, and the scan role is SELECT-only; the workable shape (enumerate via scan, write per-workspace under `withTenant`) is implied but never stated.

### LOW

- **[13-01] Deferral vs. parse-throw.** With `schemaVersion: z.literal(1).optional()`, a future version-2 payload fails the `.parse()` at `webhook-events.worker.ts:511` and throws into BullMQ retries — not the "defer by logging and returning" the doc comment promises. Needs a `safeParse`/version-check branch; no acceptance criterion pins it.
- **[13-05] A sliver of unverified band survives at day rollover.** An event for day D arriving within the final reconcile interval (<3 min) before D+1 midnight is inside the standing window at increment time (not marked dirty), but D exits the window before the next tick. The stored count remains correct (same-transaction increment + fact column), yet "every retroactive increment gets verified" is not literally airtight. Marking dirty whenever `day != today` closes it for one extra sweep row per boundary event.
- **[13-06] `replay_count` is committed in Postgres while the enqueue is a Redis call outside that transaction — a crash between them burns an attempt without a job (self-healing via the cap + watchdog) or replays free (harmless via dedup). Fine, but worth a code comment; also Task 3's verify line (`… | head -5; test $? -ne 0 || true`) tests the exit code of `head`/`test`, i.e., asserts nothing.
- **[13-12] `isEmailSuppressed` on a workspace that has never suppressed anything must short-circuit to `false` without KMS work (no key row exists yet); unspecified, and the hot-path claim depends on it.
- **[13-09] Exact-threshold semantics (1/1000 = 0.1% → `warn`) imply `>=` comparisons — the tests pin it, but the constants' comments should state inclusivity explicitly.

## 4. Suggestions

1. **Add a "zero-work batches complete their journal row" must-have** to 13-01 (and a matching case to 13-04): restructure `processWebhookEventBatch` so a `journalId`-carrying job always reaches a completion mark, including the zero-extracted and all-sibling-dropped early returns — e.g., a small `withTenant` write on those paths, with a test seeding a sibling-only batch.
2. **Add scan-role access for `ingress_journal` to migration 0055** (GRANT SELECT + a `_scan` policy mirroring `sends_scan`), and have 13-11 assert the read works under `withCrossWorkspaceScan` in its test rather than only via an injected client.
3. **Extend 13-10's anonymizing UPDATE to `external_id`** (or add an explicit decided behavior for external_id-matched upserts against anonymized rows), add `packages/contacts-core` to its `files_modified`, and add ingest-upsert and CSV-import cases to the behavior list alongside the existing email cases.
4. **Decide the cross-app shared-module home once, up front** (recommend: journal + quarantine query helpers in `packages/db`; move `incrementWorkspaceDailyRollup` into `delivery-core` or `db` so both apps import it), and propagate that decision into 13-04, 13-06, and 13-08 instead of leaving each executor to rediscover the boundary. Explicitly forbid production imports of `@mega-crm/api` from worker code (it is devDep-only today).
5. **Give `erasure_records` its cursor columns in migration 0059** (13-10), so 13-13's same-transaction checkpoint rule is satisfiable without a Wave-7 migration.
6. **In 13-07, choose the duplicate-resolution mechanism now** (operator script vs. guarded in-migration DELETE), and either split the old-constraint drop into a follow-on migration or record the stop-old-start-new deploy assumption in the migration header.
7. **Resolve 13-04's unusable-vs-quarantine contradiction** in the plan text before execution.
8. **In 13-01, specify `safeParse` + defer** for unrecognized `schemaVersion` values, with a test.

## 5. Risk Assessment

**Overall risk: MEDIUM.**

The plan set is architecturally sound, exceptionally well-sourced (essentially every cited file, line range, constant, and precedent verified against the repository), and correctly sequenced — migration numbering, wave dependencies, and the expand/contract discipline all hold. The three HIGH findings are not design flaws but concrete integration gaps that would ship real broken behavior if executed verbatim: a permanently silent ingestion watchdog (CMP-08's alerting half effectively unimplemented), systematic false poison-batch alerts for a proven-common batch shape, and an erasure guarantee that the platform's own external_id-first upsert can silently undo (a compliance-grade defect in a compliance phase). All are cheap to fix at plan level — one migration grant, one completion-mark restructure, one extra column in the anonymizing UPDATE plus upsert semantics, two cursor columns — and none forces re-architecture. With those edits plus the cross-app placement decision made once, this phase would drop to LOW risk; the phase goals (CMP-01…CMP-09) are otherwise genuinely achievable by the plans as designed.

---

## Consensus Summary

Single-reviewer run (claude only, separate headless session) — no cross-reviewer consensus is possible. The findings below are one grounded reviewer's verdict; the reviewer verified claims directly against the repository (file:line citations throughout), so findings carry source-grounded weight, but they lack independent cross-vendor confirmation. Same-vendor caveat: this session also runs on Claude, so shared blind spots are not ruled out.

### Agreed Strengths

(n/a — single reviewer; see Strengths above. Standouts: plan citations verified accurate against source; plans correct their own upstream research errors (13-07); migration numbering 0055–0061 collision-free and wave-ordered; consistent reuse of proven in-repo patterns.)

### Agreed Concerns

(n/a — single reviewer. The reviewer's three HIGH-severity findings, all source-verified:)

1. **[13-01/13-06/13-11] Fully-skipped webhook batches never mark their journal row ingested** — early returns at `webhook-events.worker.ts:514-524` bypass the tenant transaction where `markIngestionComplete` lives, producing guaranteed false "poison batch" alerts for sibling-only batches (a proven-common shape under shared BYO SendGrid keys).
2. **[13-11/13-01] Ingestion-health watchdog cannot read `ingress_journal`** — the `mega_crm_scan` role has no GRANT or `_scan` RLS policy for the table; the permission error is swallowed each interval and the CMP-08 alert silently never fires.
3. **[13-10] `external_id` survives anonymization** — the external_id-first shared upsert (`contacts-core/contact-repository.ts:98-115`) can repopulate PII into an erased row or hit a unique violation; erasure is silently undone. A compliance-grade defect in a compliance phase.

Plus MEDIUM: the apps/api ↔ apps/worker import boundary is hit un-anticipated in 13-04/13-06/13-08; 13-13's specified checkpoint storage doesn't exist (FK to flows blocks arbitrary keys, and `erasure_records` has no cursor columns); 13-07's batched-DELETE migration isn't expressible under the runner and its constraint-drop creates a deploy window; 13-04 has contradictory acceptance criteria for `unusable` events; 13-12 misses a `@mega-crm/kms` workspace dep and the backfill's write-path shape.

### Divergent Views

(n/a — single reviewer.)

**Overall risk: MEDIUM** — architecturally sound and exceptionally well-sourced, but three HIGH integration gaps would ship real broken behavior if executed verbatim. All are cheap plan-level fixes (one migration grant, one completion-mark restructure, one extra column in the anonymizing UPDATE + upsert semantics, two cursor columns, one cross-app placement decision); with them, the phase drops to LOW risk.

---

## Codex follow-up review

**Reviewer:** codex — follow-up pass, 2026-08-11, run against the Phase 13 plan set after the Claude review above had already been incorporated.

**Status of the Claude review above:** incorporated and closed. Its 3 HIGH / 5 MEDIUM / 5 LOW findings were addressed by the replan at commits `f20ea79` and `967d978`; treat them as history, not as work.

**Status of this section:** the six findings below postdate that replan and are the **open, current, actionable** review set for Phase 13. Each one must be closed in the relevant PLAN.md — or explicitly deferred/rejected there with a written rationale — by the next `/gsd-plan-phase 13 --reviews` run. None of them is addressed by the plan set as it stands.

**Severity legend:** BLOCKER — must be closed in the plan text before Phase 13 executes. WARNING — must be decided in the plan text before execution, never left to executor discretion.

### Finding 1 — BLOCKER: Suppression evidence missing for previously subscribed contacts (13-10)

**Finding (verbatim):**

> 1. BLOCKER — 13-10 must create suppression evidence for every contact erasure, including previously subscribed contacts. 13-CONTEXT.md says erasure must not weaken suppression and every erased address must remain unmailable after re-import.

**Affected plan(s):** 13-10-PLAN.md Task 2, step 2 (line 194: "Keep the existing conditional suppression insert exactly as it is, including ... its unsubscribed-or-suppressed status gate") and the acceptance criterion at line 208 ("After deleting a seeded subscribed contact, `workspace_suppressions` contains no row for that address"), which currently asserts the opposite of what this finding requires — that a previously subscribed contact's erasure writes no suppression row at all. Plan 13-12 later converts `workspace_suppressions.email` to a hash across all four call sites (13-10's insert among them), so the fix must be expressed in terms that survive that conversion — an unconditional insert keyed by email, not gated on pre-erasure subscription status.

**Required acceptance tests:**

- Erasing a previously *subscribed* contact writes a `workspace_suppressions` row for that address (replacing, not supplementing, the current line-208 criterion that asserts no row is written).
- The suppression reason distinguishes erasure (`contact_deleted` or an erasure-specific reason) from a genuine unsubscribe, so consent history is not falsified by conflating "asked to leave" with "asked to be forgotten."
- Re-importing the erased address after erasure — through both the CSV import path and the shared `contacts-core` upsert — produces a contact that the pre-send suppression gate still refuses to mail.

**Threat-model update:** amends 13-10's `T-13-10-04` ("Mail continuing to an erased address", high/mitigate) — its mitigation text ("Suppression and status are resolved synchronously in the delete request") is false for the previously-subscribed case as the plan is currently written, since step 2's insert is conditional on prior unsubscribed-or-suppressed status. Also amends `T-13-10-05` ("Resurrecting an erased contact via re-import or update", medium/mitigate) — the re-import protection via the identity-lookup filter (Task 3) prevents PII repopulation but does not by itself guarantee the address stays unmailable, since a newly-created contact from re-import has no suppression row unless one was written unconditionally at erasure time. Corrected mitigation: the suppression insert in Task 2 step 2 must be unconditional on erasure, independent of the contact's subscription status at the time of deletion.

**Suggested fix:** In 13-10-PLAN.md Task 2 step 2, make the `workspace_suppressions` insert unconditional whenever a contact is erased (drop the unsubscribed-or-suppressed status gate for the erasure path specifically, while leaving the genuine-unsubscribe insert path elsewhere unchanged), give it an erasure-specific reason, delete the acceptance criterion at line 208 that asserts no suppression row for a subscribed contact's erasure, and add the re-import assertions from the Required acceptance tests above to the behavior list and acceptance criteria.

### Finding 2 — BLOCKER: UPDATE ... RETURNING cannot capture the pre-update email (13-10)

**Finding (verbatim):**

> 2. BLOCKER — 13-10 cannot capture the old email using a normal UPDATE ... RETURNING after setting email = NULL; PostgreSQL returns the updated row. Read and lock the contact first with SELECT ... FOR UPDATE, or use a CTE that explicitly preserves pre-update values.

**Affected plan(s):** 13-10-PLAN.md Task 2, step 1 (line 191). The step directs an anonymizing UPDATE that sets `email = NULL` (among other columns) in the same statement and states it is "returning the pre-update `email` and `subscription_status`" via "the UPDATE's own returning clause." A single `UPDATE ... RETURNING` in PostgreSQL yields the row's post-update values, so as written the RETURNING clause yields `email = NULL`, not the address step 2's suppression insert needs. This interacts with Finding 1: once the suppression insert becomes unconditional (Finding 1's fix), a correct capture mechanism becomes mandatory on every erasure, not only the previously-unsubscribed path the plan currently exercises.

**Required acceptance tests:**

- Erasing a contact writes a `workspace_suppressions` row whose stored value corresponds to the address the contact actually had before erasure (asserting the captured value itself, not merely that a row was inserted).
- The capture mechanism is exercised by a test that would fail under a naive `UPDATE ... RETURNING email` after setting `email = NULL` in the same statement — the test must assert against the real pre-update address, not null or empty.
- The erasure record's insert (step 3) and the suppression insert (step 2) both use the same correctly-captured pre-update email, so neither one silently drifts from the other.

**Threat-model update:** amends `T-13-10-01` ("Incomplete PII scrub on the contacts row", high/mitigate) and `T-13-10-04` ("Mail continuing to an erased address", high/mitigate) — both currently assert the capture is "resolved synchronously in the delete request," which is unachievable if the RETURNING clause yields null. Corrected mitigation for T-13-10-04: capture the pre-update email via `SELECT ... FOR UPDATE` (lock and read before the anonymizing UPDATE) or a CTE that explicitly preserves pre-update column values across the UPDATE, then use that captured value for both the suppression insert and any erasure-record fields that reference the address.

**Suggested fix:** rewrite 13-10-PLAN.md Task 2 step 1 to either (a) `SELECT email, subscription_status FROM contacts WHERE ... FOR UPDATE` first, holding the row lock, then run the anonymizing UPDATE using the already-captured values for steps 2/3, or (b) use a single statement built as a CTE (e.g. a `WITH old AS (SELECT email, subscription_status FROM contacts WHERE ... FOR UPDATE) UPDATE contacts SET ... FROM old WHERE contacts.id = old.id RETURNING old.email, old.subscription_status`) that explicitly selects the pre-update values into a separate CTE before the UPDATE touches them. Remove the plan's current claim that "the UPDATE's own returning clause" yields the pre-update email.

### Finding 3 — BLOCKER: erasure_records needs a durable outbox with a reclaimer (13-10)

**Finding (verbatim):**

> 3. BLOCKER — Make erasure_records a durable outbox. Commit anonymization, suppression and the pending erasure record atomically; enqueue only after commit. Add a scheduled or boot-time reclaimer for pending and lease-expired records using deterministic job IDs. Test a crash after database commit but before BullMQ enqueue.

**Affected plan(s):** 13-10-PLAN.md Task 2, step 3 (line 195: the `erasure_records` insert in the same transaction as anonymization) and step 4 (line 196: the enqueue, "Enqueue after the transaction commits, or inside it if the existing codebase convention for API-side enqueues does so ... State which you did and why in the SUMMARY"). The atomicity half — steps 1-3 in one transaction — is already correct; what is missing is that step 4 leaves the commit/enqueue ordering to executor discretion, with no reclaimer defined anywhere in the plan set for a `pending` `erasure_records` row whose enqueue never happened after a crash.

**Required acceptance tests:**

- A crash injected after the erasure transaction (anonymization + suppression + `erasure_records` insert) commits, but before the BullMQ enqueue call completes, leaves an `erasure_records` row in `pending` state.
- A subsequent reclaimer pass (scheduled tick or boot-time sweep) finds that pending row and enqueues the scrub job for it.
- The reclaimer's job id is deterministically derived from the erasure record (matching Task 2 step 4's existing deterministic-jobId requirement), so a duplicate reclaim of the same row is a no-op rather than a second scrub.
- A `pending` `erasure_records` row that is not yet lease-expired (recently created, enqueue may simply be in flight) is not reclaimed prematurely.

**Threat-model update:** `T-13-10-02` ("Erasure with no auditable proof it occurred", high/mitigate) stays valid as written — the transactional write of `erasure_records` is the correct fix for that threat. But `T-13-10-06` ("Duplicate scrub jobs from a retried request", medium/mitigate) needs the reclaimer's job-id derivation folded into its mitigation text, and a new row is needed for the un-enqueued-pending-record class of failure — a committed erasure whose scrub was never queued and nothing currently notices. Note that 13-11's ingestion-health watchdog covers the webhook ingress journal, not `erasure_records`; nothing in the current plan set surfaces a stuck erasure record.

**Suggested fix:** pin the commit/enqueue ordering explicitly in 13-10-PLAN.md Task 2 step 4 (commit first, enqueue after — the plan's own text already leans this way but currently offers it as one of two options), and add, either to 13-10 or 13-13, a scheduled or boot-time reclaimer that scans `erasure_records` for `pending` rows past a lease/age threshold and re-enqueues their scrub job using the same deterministic-jobId convention Task 2 step 4 already establishes. Add the crash-after-commit-before-enqueue test to the acceptance criteria of whichever plan owns the reclaimer.

### Finding 4 — BLOCKER: REDACTION_RULES denylist cannot bound arbitrary tenant-defined PII (13-13)

**Finding (verbatim):**

> 4. BLOCKER — 13-13 must not rely on REDACTION_RULES or a denylist to remove arbitrary PII. Reconstruct send_events.payload from a strict evidence allowlist. Clear events.properties to {} unless an explicit evidence allowlist is defined. Add tests for PII stored under unknown tenant-defined keys.

**Affected plan(s):** 13-13-PLAN.md Task 1 (line 106: "implemented over `@mega-crm/redaction`'s `REDACTION_RULES` rather than any new pattern. Do not write a new ... heuristic") and its key_link at line 37 ("`@mega-crm/redaction`'s `REDACTION_RULES` -> the JSONB field-matching: reusing the tuned vocabulary avoids reintroducing the false positives ..."), both of which mandate reuse of the denylist-style redaction vocabulary for scrubbing `send_events.payload` and `events.properties`. This finding contradicts the plan's current direction rather than refining it: a key/value denylist tuned for log-scrubbing cannot bound PII in tenant-defined `events.properties`, where key names are arbitrary and unenumerable in advance — the plan's own `flagged_assumptions` section (line 264) already concedes "a tenant storing PII under an unusual key name would survive the scrub," but treats that as an accepted residual risk rather than the BLOCKER-level defect this finding identifies it as.

**Required acceptance tests:**

- PII stored under an unknown tenant-defined key (a key name matching no rule in `REDACTION_RULES`) does not survive the scrub for `events.properties`.
- `send_events.payload` after a scrub contains only fields present on a defined evidence allowlist (e.g. `event`, `type`, `timestamp`, `sg_event_id`, and other non-PII correlation ids) — no field outside that allowlist survives, regardless of whether the redaction vocabulary flags it.
- `events.properties` is rewritten to `{}` after a scrub unless an explicit evidence allowlist is defined for that table, in which case only the allowlisted fields survive.
- A payload field containing PII under a key name never seen before by `REDACTION_RULES` is removed exactly as reliably as a known PII key.

**Threat-model update:** amends `T-13-13-01` ("PII surviving in `send_events.payload` after erasure", high/mitigate) — satisfiable only under an allowlist reconstruction, not a denylist scrub, since a denylist's completeness claim depends on an enumerable set of PII key names that tenant-defined `properties` does not have. Amends `T-13-13-06` ("A new PII heuristic reintroducing known false positives", medium/mitigate) — its stated mitigation ("the existing `REDACTION_RULES` vocabulary is reused rather than re-derived") is itself the defect this finding identifies, not a valid mitigation; the false-positive concern that mitigation protects against becomes moot once payloads are reconstructed from an allowlist rather than filtered by a denylist. The surviving obligation from `T-13-13-03` ("Rows are rewritten, never deleted", high/mitigate) still applies: `event_type`, `occurred_at`, and `received_at` (or their `send_events`/`events`-specific equivalents) must be named on whatever allowlist is chosen, or the evidence guarantee this plan exists to preserve breaks.

**Suggested fix:** rewrite 13-13-PLAN.md Task 1 to define an explicit evidence-field allowlist per table (`send_events.payload`: event type, timestamp(s), `sg_event_id`, and any other fields the plan's own behavior list already requires to survive; `events.properties`: none, unless a specific tenant-defined field is later proven necessary as evidence) and reconstruct each scrubbed JSONB value by copying only allowlisted fields forward, rather than walking the existing value and removing keys `REDACTION_RULES` flags. Delete the `REDACTION_RULES`-reuse instruction at line 106 and the corresponding key_link at line 37, and add the unknown-tenant-key test to Task 1's acceptance criteria.
