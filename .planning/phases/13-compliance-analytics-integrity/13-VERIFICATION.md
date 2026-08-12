---
phase: 13-compliance-analytics-integrity
verified: 2026-08-12T10:00:00Z
status: human_needed
score: 5/5 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 4/5
  gaps_closed:
    - "Deleting a contact removes personal data while leaving the minimum evidence needed to later prove a send or a suppression was lawful. (ROADMAP SC3 / CMP-04) -- send_event_quarantine now has a bounded, versioned retention horizon (pruneSendEventQuarantine, SEND_EVENT_QUARANTINE_RETENTION_DAYS=7) wired into the existing webhook-replay-sweep tick, keyed exclusively on the server-set received_at column."
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Unsubscribe atomicity and convergence (ROADMAP SC1 / CMP-01) -- send a real campaign email, click unsubscribe, confirm send/consent-history/campaign-counter all update exactly once, then replay the SendGrid unsubscribe webhook for the same send and confirm nothing changes a second time."
    expected: "Exactly one status change, one consent-history row, one unsubscribed_at fact, one counter increment, regardless of order or replay."
    why_human: "Requires a live dev environment, a real campaign send, and a real or replayed SendGrid webhook delivery -- deferred per human_verify_mode=end-of-phase (13-14-SUMMARY.md coverage D4)."
  - test: "Daily numbers under multiple session timezones (ROADMAP SC2 / CMP-02/CMP-03/CMP-06) -- note a day's sent/delivered counts, trigger reconciliation, repeat under SET TIME ZONE 'Asia/Tokyo', confirm unchanged; inject a 4-day-late webhook event and confirm the day is marked dirty, cleared by the next tick, and the count reflects the late event."
    expected: "Counts are session-timezone-independent and late events land on the day they occurred, not the day they arrived."
    why_human: "Requires a running worker with a live reconciliation tick and direct DB session control -- deferred per human_verify_mode=end-of-phase. (Automated equivalent already passed: reconcile-utc-day.test.ts and analytics-reconciliation-dirty-day.test.ts, re-confirmed by the prior verification pass and unaffected by 13-16.)"
  - test: "Erasure end-to-end, extended by gap-closure plan 13-16 (ROADMAP SC3 / CMP-04) -- delete a contact with sends/events/external_id, confirm disappearance from lists/segments, confirm PII columns null and anonymized_at set, wait for scrub completion, confirm send_events.payload no longer carries the email, re-import the former external_id/email and confirm a new contact is created and suppression still refuses it. THEN, as the 13-16 extension to this same checklist step: delete a contact that previously produced at least one webhook event with an out-of-bounds timestamp (so a send_event_quarantine row carrying that contact's address exists); confirm the erasure completes as above; confirm the quarantine row is STILL PRESENT immediately afterward (not scrubbed, by design); confirm it is gone after SEND_EVENT_QUARANTINE_RETENTION_DAYS (7 days) has elapsed for that row, with no manual SQL."
    expected: "All steps in 13-14-SUMMARY.md's checklist step 4 succeed exactly as described, AND the quarantine row survives erasure but ages out on its own retention horizon without operator action."
    why_human: "Requires a live dev environment, the BullMQ scrub worker actually running, a CSV/API re-import round trip, and (for the 13-16 extension) either a real 7-day wait or a controlled received_at backdate plus a live webhook-replay-sweep tick -- deferred per human_verify_mode=end-of-phase. NOTE: this item now closes the prior verification's caveat -- a clean step-4 pass on send_events.payload alone never covered send_event_quarantine; the walkthrough must explicitly observe the quarantine row's survive-then-expire behavior to close SC3/CMP-04 in a live environment, not just in the codebase."
  - test: "Event integrity (ROADMAP SC4 / CMP-05/CMP-07) -- send a webhook event timestamped 30 days in the past, confirm quarantine + no send_events row + no metric movement; send the same event twice under two different sg_event_id values and confirm exactly one send_events row and one counter increment."
    expected: "Out-of-range timestamps are quarantined per-event without failing the batch; redelivery with an unstable sg_event_id still dedupes to one row."
    why_human: "Requires live webhook delivery against a running API -- deferred per human_verify_mode=end-of-phase. (Automated equivalent already passed: occurred-at-bounds.test.ts, webhook-events-occurred-at-bounds.test.ts, send-events-dedup-rebase.test.ts, unaffected by 13-16.)"
  - test: "Backfill and alerts (ROADMAP SC5 / CMP-08/CMP-09) -- stop the worker, deliver a signed webhook batch, confirm an un-ingested journal row, restart, confirm the replay sweep marks it ingested and processes events exactly once; seed a workspace above the complaint warn threshold with OPERATOR_ALERT_EMAIL pointed at a real inbox and confirm operator + tenant-member emails arrive, cooldown suppresses a repeat, and escalation to critical sends immediately."
    expected: "All steps in 13-14-SUMMARY.md's checklist steps 6-7 succeed exactly as described."
    why_human: "Requires a live SendGrid-facing webhook endpoint, a real inbox, and worker stop/restart timing -- deferred per human_verify_mode=end-of-phase. (Automated equivalent already passed: webhook-replay-sweep.test.ts -- including 13-16's new quarantine-retention cases, 59/59 -- ingestion-health-watchdog.test.ts, reputation-watchdog.test.ts, scheduler-registration.test.ts.)"
---

# Phase 13: Compliance & Analytics Integrity Verification Report

**Phase Goal:** What the platform claims about consent and delivery matches what actually happened — an unsubscribe is honored everywhere at once, and a daily number means exactly one thing.
**Verified:** 2026-08-12T10:00:00Z
**Status:** human_needed
**Re-verification:** Yes — after gap-closure plan 13-16 executed (6 commits, 4369a14..e19f26b)

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | An unsubscribe updates subscription status, consent history and the originating send as one atomic event — a crash partway through leaves no partial state anywhere. | ✓ VERIFIED (regression-checked) | `packages/contacts-core/src/unsubscribe-apply.ts` still 156 lines, unchanged by 13-16. Not re-run this pass (13-16 does not touch this file); prior pass's `unsubscribe-apply.test.ts` (7/7) and `failure-injection/unsubscribe-atomic.test.ts` (4/4) evidence stands. |
| 2 | Daily metrics are computed from one documented UTC field, and a provider event that arrives late is counted on the day it occurred rather than the day it arrived. | ✓ VERIFIED (regression-checked) | `ARCHITECTURE.md` §11 day-authority contract unchanged by 13-16. Not re-run this pass; prior pass's `reconcile-utc-day.test.ts` (5/5) and `analytics-reconciliation-dirty-day.test.ts` (12/12) evidence stands. |
| 3 | Deleting a contact removes personal data while leaving the minimum evidence needed to later prove a send or a suppression was lawful. | ✓ VERIFIED — Gap #1 closed | `send_event_quarantine` now has a disposal counterpart: `pruneSendEventQuarantine` (`packages/db/src/webhooks/quarantine.ts`), horizon `SEND_EVENT_QUARANTINE_RETENTION_DAYS = 7`, keyed exclusively on the server-set `received_at`, wired as a third call inside `webhook-replay-sweep.worker.ts`'s existing per-workspace tick, reported as its own `quarantineRowsPruned` field. Read the code directly (not the SUMMARY): predicate is `WHERE received_at < now() - make_interval(days => $1)`, `PoolClient`-scoped, no new queue/scheduler/env var. Ran directly: `quarantine-retention.test.ts` (10/10 pass, includes ancient-`occurred_at_candidate`-survives and ancient-provider-`timestamp`-in-`raw_event`-survives cases proving provider-supplied values cannot influence disposal), `webhook-replay-sweep.test.ts` + `scheduler-registration.test.ts` (59/59 pass, includes independently-settable-horizons case). `erasure-scrub.worker.ts`'s exclusion of this table is now a recorded, falsifiable comment (confirmed via `git show 700eed7` — comment-only diff). All three of the prior report's named `artifacts:` complaints answered (see Gap Closure Verification below). |
| 4 | A provider event carrying an out-of-range or manipulated timestamp cannot bypass deduplication or land outside its partition, and a redelivered event is counted once even when `sg_event_id` is not stable across retries. | ✓ VERIFIED (regression-checked) | `packages/delivery-core/src/occurred-at-bounds.ts` still 110 lines, unchanged by 13-16. Not re-run this pass; prior pass's `occurred-at-bounds.test.ts`/`webhook-events-occurred-at-bounds.test.ts`/`send-events-dedup-rebase.test.ts` (25/25) evidence stands. |
| 5 | Metric drift is corrected by a scheduled reconciliation job rather than a one-off fix, events missed while the webhook endpoint was unreachable are recovered by backfill, and a tenant approaching the spam-complaint threshold raises an alert. | ✓ VERIFIED (re-run, extended by 13-16) | `webhook-replay-sweep.worker.ts` grew from 451 to 499 lines (the quarantine-retention call + comment) but registers exactly one `upsertJobScheduler(` call site (confirmed by direct grep), same scheduler id. Ran directly this pass: `webhook-replay-sweep.test.ts` + `scheduler-registration.test.ts` (59/59 pass, superset of the prior pass's coverage). `ingestion-health-watchdog.ts`/`reputation-watchdog.ts` unchanged by 13-16 (354/379 lines, matching prior pass); their tests not re-run this pass (no code changed) — prior pass's evidence (16/16, 14/14, 15/15) stands. |

**Score:** 5/5 truths verified (0 present-but-behavior-unverified)

### Gap Closure Verification (13-16, closing prior Gap #1)

The prior report named exactly three artifacts as needing an answer. All three are re-checked directly against the current codebase, not against the SUMMARY's claim:

| Artifact named in prior Gap #1 | Prior complaint | Current state | Verdict |
|---|---|---|---|
| `packages/db/migrations/0055_webhook_ingress_durability.sql` | `send_event_quarantine` has no age-out/retention mechanism despite its own `COMMENT ON TABLE` asserting it "can be pruned independently" | File itself is unmodified (`git diff --quiet -- packages/db/migrations` exits 0); the claim is now true by construction — `pruneSendEventQuarantine` exists with an independently-settable horizon, proven by the differing-horizons test case in `webhook-replay-sweep.test.ts` | ✓ ANSWERED |
| `packages/db/src/webhooks/quarantine.ts` | `writeQuarantinedEvent` is the only code that ever touches this table — no prune/purge/scrub counterpart exists | `pruneSendEventQuarantine` added in the same module, same file read directly (lines 96-138 above), 10/10 tests pass | ✓ ANSWERED |
| `apps/worker/src/queues/erasure-scrub.worker.ts` | Does not reference `send_event_quarantine` at all; the erasure scrub's allowlist reconstruction covers `send_events.payload`/`events.properties` only | Behavior is unchanged (comment-only diff, confirmed via `git show 700eed7`) — the scrub still does not reach this table, but that exclusion is now a recorded, falsifiable decision (names both retention constants, states the condition under which the exemption stops holding) rather than an unexplained absence | ✓ ANSWERED (by documentation, not by widening scrub reach — the plan's chosen closure shape was retention, not scrub-reach, and the verifier's own prior report named retention as the sufficient shape) |

### Prohibitions Disposition (13-16 must_haves.prohibitions)

All six were `status: flagged, verification: unverified` in the plan frontmatter. Each now has direct codebase/test evidence gathered by this verification pass (not the plan author's claim):

| Prohibition | Evidence | Disposition |
|---|---|---|
| Prune selects rows by `received_at` only; no provider-supplied value participates | `quarantine-retention.test.ts` cases "ancient `occurred_at_candidate` survives" and "ancient provider `timestamp` in `raw_event` survives" (both pass); SQL predicate reads `WHERE received_at < now() - make_interval(days => $1)` — no other column referenced | ✓ enforced, evidenced |
| Quarantine prune never touches `ingress_journal` rows; separate functions, separate horizon constants | `quarantine-retention.test.ts` case "leaves both a completed and an incomplete expired `ingress_journal` row untouched, including a non-null `raw_batch`" (passes); `pruneSendEventQuarantine` and `pruneIngressJournal` are distinct exported functions with distinct constants | ✓ enforced, evidenced |
| No new queue, scheduler id, worker, or environment variable | `grep -c "upsertJobScheduler(" apps/worker/src/queues/webhook-replay-sweep.worker.ts` → `1` (confirmed directly); no new file under `apps/worker/src/queues/` | ✓ enforced, evidenced |
| Quarantine prune count never summed into `journalRowsPruned`/`journalPayloadsPurged` | Code at lines 315-323 of `webhook-replay-sweep.worker.ts`: three separate `const` bindings returned as three separate object fields; `webhook-replay-sweep.test.ts` case asserts 1/1 in two separate fields, not 2 in one | ✓ enforced, evidenced |
| Every quarantine read/delete inside a tenant-scoped transaction; no new `mega_crm_scan` grant | `pruneSendEventQuarantine` takes a `PoolClient` and issues one statement, called from inside `runWorkspaceTick`'s existing `withTenantTransaction`; two-workspace isolation test in `quarantine-retention.test.ts` passes; migration 0055 (unmodified) grants this table no scan-role access | ✓ enforced, evidenced |
| No migration file added or edited; `_journal.json` byte-identical | `git diff --quiet -- packages/db/migrations` exits 0 (confirmed directly); `npm run lint:migrations` reports 62 files, unchanged count | ✓ enforced, evidenced |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/db/src/webhooks/quarantine.ts` | Disposal counterpart to insert-only writer, versioned horizon with erasure-interaction rationale | ✓ VERIFIED | 139 lines; `SEND_EVENT_QUARANTINE_RETENTION_DAYS = 7`, `pruneSendEventQuarantine` exported, doc comment carries all four required rationale points; read directly |
| `packages/db/src/__tests__/quarantine-retention.test.ts` | Behavioral proof of retention, server-timestamp-only predicate, tenant isolation, journal non-interference | ✓ VERIFIED | New file, 277 lines, 10 test cases matching plan's `<behavior>` list exactly; ran directly, 10/10 pass |
| `apps/worker/src/queues/webhook-replay-sweep.worker.ts` | Quarantine prune wired into existing tick, reported as its own never-summed field | ✓ VERIFIED | 499 lines (was 451); `pruneSendEventQuarantine` call confirmed inside `runWorkspaceTick`, after both journal calls; `quarantineRowsPruned` on `WorkspaceTickResult`/`WebhookReplaySweepTickSummary`; one scheduler call site (grep-confirmed) |
| `apps/worker/src/queues/__tests__/webhook-replay-sweep.test.ts` | 7 new cases per plan's `<behavior>` list | ✓ VERIFIED | Ran directly with `scheduler-registration.test.ts`: 59/59 pass |
| `apps/worker/src/queues/erasure-scrub.worker.ts` | Scope-boundary comment naming both retention constants and the falsifiability condition | ✓ VERIFIED | 528 lines (was 515); `git show 700eed7` confirms comment-only diff; both constant names present |
| `SPECIFICATION.md` §4.2/§5.13 | As-built description of the retention mechanism, cross-referenced | ✓ VERIFIED | `send_event_quarantine` paragraph names plan 13-04 as writer's caller and the retention mechanism/horizon; §5.13 retention-step bullet names three calls, tick-summary bullet enumerates `quarantineRowsPruned` under the never-summed rule |
| `ARCHITECTURE.md` §12 | "Deliberately NOT scrubbed" paragraph states HOW both tables self-prune, plus falsifiability | ✓ VERIFIED | Read directly (lines 239-253): equal horizons, delete-vs-tombstone distinction stated, falsifiability condition present, closing pointer line lists §5.13 |
| (Regression) `packages/contacts-core/src/unsubscribe-apply.ts` | Unchanged by 13-16 | ✓ VERIFIED | 156 lines, matches prior pass exactly |
| (Regression) `packages/delivery-core/src/occurred-at-bounds.ts` | Unchanged by 13-16 | ✓ VERIFIED | 110 lines, matches prior pass exactly |
| (Regression) `apps/api/src/modules/ops/ingestion-health-watchdog.ts` / `reputation-watchdog.ts` | Unchanged by 13-16 | ✓ VERIFIED | 354 / 379 lines, matches prior pass exactly |
| (Regression) `apps/worker/src/queues/erasure-scrub-reclaim.worker.ts` | Unchanged by 13-16 | ✓ VERIFIED | 387 lines, matches prior pass exactly |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `writeQuarantinedEvent` (plan 13-01) | `pruneSendEventQuarantine` (plan 13-16) | disposal counterpart in the same module | ✓ WIRED | Both exported from `packages/db/src/webhooks/quarantine.ts`; read directly |
| `classifyOccurredAt`'s rejected/unusable verdicts (plan 13-04) | quarantine writer → 13-16 retention horizon | inherited disposal obligation | ✓ WIRED | `webhook-events.worker.ts` calls `writeQuarantinedEvent`; the row it creates is now disposed of by the horizon |
| `runWorkspaceTick`'s retention step (plan 13-06) | quarantine prune | third call, same tenant transaction, after both journal calls | ✓ WIRED | Confirmed at lines 299-315 of `webhook-replay-sweep.worker.ts`: `pruneIngressJournal` → `purgeExpiredIngressJournalPayloads` → `pruneSendEventQuarantine`, all inside one `withTenantTransaction` |
| `SEND_EVENT_QUARANTINE_RETENTION_DAYS` | `INGRESS_JOURNAL_RETENTION_DAYS` | equality + independent settability | ✓ WIRED | Equality asserted via import-based test (not literal comparison); independent settability proven by the differing-horizons test case |
| `erasure-scrub.worker.ts` | quarantine/journal retention constants | pointer comment, not code reach | ✓ WIRED (as documentation, not as scrub-reach — this is the plan's chosen closure shape) | `git show 700eed7` confirms comment naming both constants |
| (Regression) `apps/worker/src/server.ts` | four worker constructors | direct import + boot call | ✓ WIRED | Not re-checked by line number this pass; no file in this link was touched by 13-16 |
| (Regression) `apps/api/src/server.ts` | two watchdog starts | direct import + boot call | ✓ WIRED | Not re-checked by line number this pass; no file in this link was touched by 13-16 |
| `packages/db/migrations/meta/_journal.json` | migrations 0055-0061 | journal entries | ✓ WIRED (unchanged) | `git diff --quiet -- packages/db/migrations` exits 0 — 13-16 added no migration |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Quarantine retention: expired deleted, fresh kept, provider-value-immune, tenant-isolated, journal-untouched, independently-settable | `npx vitest run --root packages/db src/__tests__/quarantine-retention.test.ts` | 10/10 pass | ✓ PASS (run directly this pass) |
| Webhook replay sweep incl. quarantine wiring + scheduler registration unchanged | `npx vitest run --root apps/worker src/queues/__tests__/webhook-replay-sweep.test.ts src/queues/__tests__/scheduler-registration.test.ts` | 59/59 pass | ✓ PASS (run directly this pass) |
| Migration files untouched by gap-closure plan | `git diff --quiet -- packages/db/migrations` | exit 0 | ✓ PASS (run directly this pass) |
| Migration lint (must report same file count as before) | `npm run lint:migrations` | "62 file(s) checked, no violations" | ✓ PASS (run directly this pass; matches prior pass's count, confirming no migration added) |
| Worker build with new quarantine wiring | `npm run build --workspace=apps/worker` | exits 0 | ✓ PASS (run directly this pass) |
| Debt-marker scan on all 13-16-touched files | `grep -n -E "TBD|FIXME|XXX|TODO|HACK|PLACEHOLDER"` across quarantine.ts, quarantine-retention.test.ts, webhook-replay-sweep.worker.ts, webhook-replay-sweep.test.ts, erasure-scrub.worker.ts | no matches | ✓ PASS (run directly this pass) |
| `writeQuarantinedEvent` caller still wired (regression) | `grep -rn "writeQuarantinedEvent" apps/worker/src/` | found in `webhook-events.worker.ts` | ✓ PASS (run directly this pass) |

No full-suite re-run was performed this pass (per Step 7b constraints and to avoid re-running everything the prior pass already covered). This pass targeted exactly the files touched by the gap-closure plan plus line-count regression checks on the files the prior pass verified; 13-16-SUMMARY.md's own claim of a full-suite green run (1,632 tests) was not independently re-run in full but is consistent with the targeted subset (69 tests across 3 files) passing cleanly.

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|--------------|-----------------|--------------|--------|----------|
| CMP-01 | 13-08 | Atomic unsubscribe (status + consent history + send fact) | ✓ SATISFIED (unchanged) | `unsubscribe-apply.ts`, prior pass's tests |
| CMP-02 | 13-02, 13-03 | Single documented UTC day field for daily metrics | ✓ SATISFIED (unchanged) | `ARCHITECTURE.md` §11, prior pass's tests |
| CMP-03 | 13-05 | Late provider events correctly counted on their occurrence day | ✓ SATISFIED (unchanged) | dirty-day mechanism, prior pass's tests |
| CMP-04 | 13-10, 13-12, 13-13, 13-15, 13-16 | Contact deletion anonymizes PII while preserving compliance evidence | ✓ SATISFIED (gap closed this pass) | Anonymization/suppression/scrub of `contacts`/`sends`/`send_events`/`events` (prior pass) plus `send_event_quarantine` retention (this plan, this pass); Gap #1 closed |
| CMP-05 | 13-04 | Provider timestamp bounded before partition/dedup use | ✓ SATISFIED (unchanged) | `occurred-at-bounds.ts`, prior pass's tests |
| CMP-06 | 13-02 | Metrics reconciliation runs as a recurring scheduled job | ✓ SATISFIED (unchanged) | `upsertJobScheduler`-based registration |
| CMP-07 | 13-07 | Dedup resilient to unstable `sg_event_id` | ✓ SATISFIED (unchanged) | migration 0057 dedup rebase, prior pass's tests |
| CMP-08 | 13-01, 13-06, 13-11 | Missed webhook events recovered by backfill | ✓ SATISFIED (unchanged, sweep worker re-tested this pass) | ingress journal + replay sweep + ingestion-health watchdog |
| CMP-09 | 13-09, 13-11 | Reputation tracked per tenant with threshold alerting | ✓ SATISFIED (unchanged) | reputation-tick worker + reputation watchdog |

**Note on REQUIREMENTS.md staleness (not a gap, carried forward):** `.planning/REQUIREMENTS.md`'s traceability table still shows CMP-01/03/04/05/07 as "Gaps Found" and CMP-02/06/08/09 as "Pending" (checked directly, lines 210-218). The checkbox list (lines 68-76) shows CMP-04 now marked `[x]` — 13-16-SUMMARY.md's `requirements mark-complete` call landed that half. 13-16-SUMMARY.md itself states the traceability-table row was intentionally left at "Gaps Found" pending this phase-level re-verification ("that row is owned by phase-level re-verification... It should flip once re-verification confirms Gap #1's three artifacts complaints are answered"). This re-verification now confirms exactly that. The traceability table should be updated to "Complete" (or equivalent) for all 9 CMP rows as part of phase close — this is a tracking-document sync task, not a functional gap, and does not block the phase goal.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `packages/db/src/sends/fact-columns.ts` | 33-53 | Dynamic SQL column-name interpolation with no allow-list | ⚠️ Warning | Carried forward unchanged from prior pass (13-REVIEW.md WR-01, renumbered from prior WR-02). No live exploit; not touched by 13-16. |
| `packages/contacts-core/src/unsubscribe-apply.ts`, `apps/worker/src/queues/webhook-events.worker.ts` | as noted | Missing explicit `AND workspace_id = $N` defense-in-depth predicate on 3 queries | ⚠️ Warning | Carried forward unchanged from prior pass (13-REVIEW.md WR-02, renumbered from prior WR-03). RLS still enforces isolation; not touched by 13-16. |
| `apps/api/src/modules/ops/reputation-watchdog.ts:326-357` | as noted | Alert claim released on partial mid-batch send failure — duplicate sends possible on retry | ⚠️ Warning | Carried forward unchanged from prior pass (13-REVIEW.md WR-03, renumbered from prior WR-04). Not touched by 13-16. |
| `apps/worker/src/queues/erasure-scrub.worker.ts:444,469,513` | as noted | Bare `console.error` instead of `scrubbedConsole.error`, contradicting SPECIFICATION.md §7's documented redaction invariant | ⚠️ Warning | **New finding, surfaced by the code-review re-pass (13-REVIEW.md WR-04), not introduced by 13-16** — confirmed via `git show 700eed7` that 13-16's own diff to this file is comment-only. Line 469 is the substantive risk (a `pg` error's `detail`/`message` can echo statement values). Pre-existing code, out of this gap-closure plan's scope; does not block SC3/CMP-04's truth (which concerns `send_event_quarantine`, not this worker's logging). |
| `apps/worker/src/queues/webhook-replay-sweep.worker.ts:362-378` | `runWebhookReplaySweep`'s main loop | No per-workspace error isolation (`try/catch`) around `runWorkspaceTick`, unlike `erasure-scrub-reclaim.worker.ts`'s documented pattern | ⚠️ Warning | **New finding (13-REVIEW.md WR-05).** Pre-existing pattern shared by `reputation-tick.worker.ts`/`analytics-reconciliation.worker.ts`, not a 13-16 regression — but 13-16's addition of the quarantine prune inside the same unprotected per-workspace transaction means one workspace's failure now also delays quarantine retention (not just replay/journal retention) for every workspace enumerated after it in that tick. Does not falsify SC5 ("raises an alert") or SC3 (retention still runs correctly for every workspace that doesn't error); a robustness gap under a failure scenario the prior pass's SC5 verification already accepted as a documented at-least-once trade-off for sibling workers. |
| `apps/api/src/modules/analytics/dashboard.repository.ts:145-153` | growth-chart day bucketing | `contacts.created_at` is a naive `timestamp` column with no verified UTC pinning at the connection/pool level | ⚠️ Warning | **New finding (13-REVIEW.md WR-06), lower confidence per the review itself.** Narrower-scope variant of the hazard class CMP-02/03 closed for `sends`/`send_events`/`workspace_daily_rollup`; not part of this phase's `must_haves` scope (dashboard growth chart is not named in any of the 16 plans' artifacts) and not touched by 13-16. Flagged for awareness, not a phase-goal blocker. |

No `TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/`PLACEHOLDER` markers found in any file touched by plan 13-16 (checked directly this pass). Prior pass's "no debt markers" finding across the other 15 plans' files was not re-checked this pass (unchanged files).

### Human Verification Required

See frontmatter `human_verification` — five items, one per ROADMAP success criterion, all explicitly deferred by the phase's own plans (human_verify_mode=end-of-phase). Item 3 (erasure end-to-end) is extended this pass by 13-16's own `<human-check>` block, appended to the 13-14 checklist's step 4 rather than replacing it: the human operator must now also confirm that a quarantine row carrying a deleted contact's address (a) survives the erasure walkthrough by design and (b) is gone once its retention horizon has elapsed, with no manual SQL. This closes the prior report's caveat that a clean step-4 pass on `send_events.payload` alone never covered `send_event_quarantine` — the live-environment walkthrough must now explicitly observe both halves of that table's behavior to fully close SC3/CMP-04 outside the codebase.

### Gaps Summary

No gaps. The prior report's single blocking gap — `send_event_quarantine`'s unbounded PII retention — is closed: `pruneSendEventQuarantine` exists, is wired into the existing five-minute tick, is keyed exclusively on the server-set `received_at` (proven behaviorally, not just by inspection), runs within the correct tenant scope, and is documented at all three sites the prior verification named plus the two SPECIFICATION.md sections and ARCHITECTURE.md section the gap-closure plan additionally targeted. All 9 CMP-xx requirements are satisfied with codebase evidence. Three new non-blocking warnings surfaced by the phase's own code-review re-pass (bare `console.error`, missing per-workspace error isolation, unverified UTC pinning on one dashboard column) are recorded above for awareness; none falsify any ROADMAP success criterion and none were in this gap-closure plan's scope.

Status is `human_needed`, not `passed`, solely because five end-of-phase human-verification items remain outstanding by design (`human_verify_mode=end-of-phase`) — every one of them has its automatable half already passed by this or the prior verification pass.

---

*Verified: 2026-08-12T10:00:00Z*
*Verifier: Claude (gsd-verifier)*
