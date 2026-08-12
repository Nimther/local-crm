---
phase: 13-compliance-analytics-integrity
verified: 2026-08-12T06:00:00Z
status: gaps_found
score: 4/5 must-haves verified
behavior_unverified: 0
overrides_applied: 0
gaps:
  - truth: "Deleting a contact removes personal data while leaving the minimum evidence needed to later prove a send or a suppression was lawful. (ROADMAP SC3 / CMP-04)"
    status: partial
    reason: >
      The erasure/anonymization path built by plans 13-10, 13-12, and 13-13 is real and
      well-tested (contact anonymization, HMAC'd suppression, allowlist-reconstructed
      send_events.payload scrub, unconditional events.properties scrub) -- but it does not
      reach `send_event_quarantine`, a table this SAME phase introduced (plan 13-01) that
      stores the complete unredacted raw SendGrid webhook body (including recipient email,
      IP, user agent) for every event whose provider timestamp fails CMP-05's bounds check.
      No pruning, retention, or scrub job of any kind exists for this table -- confirmed by
      grepping every reference to `send_event_quarantine`/`sendEventQuarantine`: only the
      insert-only writer and its RLS policy exist, and `erasure-scrub.worker.ts` has zero
      references to it. Migration 0055's own `COMMENT ON TABLE` and plan 13-01's action text
      both assert "quarantine retention can be pruned independently," and plan 13-04's threat
      model (T-13-04-04) explicitly claims this table "shares the journal's short pruned
      retention" as its stated mitigation for the information-disclosure threat -- neither
      claim was ever implemented. `ingress_journal`'s exclusion from the erasure scrub is a
      reasoned, documented trade (its 7-day retention horizon outpaces an erasure request's
      own SLA, per plan 13-01's Task 3 action text) -- no equivalent argument exists for
      `send_event_quarantine`, which has no retention horizon at all. Net effect: a contact
      who exercises erasure can still have their email address and other PII sitting in this
      table indefinitely, for any webhook event about them that happened to arrive with a
      bad or missing timestamp. This was independently flagged as WR-01 in 13-REVIEW.md
      (0 critical / 4 warnings) and confirmed here by direct grep against the current
      codebase, not taken on the review's word.
    artifacts:
      - path: "packages/db/migrations/0055_webhook_ingress_durability.sql"
        issue: "send_event_quarantine has no age-out/retention mechanism despite its own COMMENT ON TABLE and plan 13-01's action text asserting it 'can be pruned independently'"
      - path: "packages/db/src/webhooks/quarantine.ts"
        issue: "writeQuarantinedEvent is the only code that ever touches this table -- no prune/purge/scrub counterpart exists"
      - path: "apps/worker/src/queues/erasure-scrub.worker.ts"
        issue: "Does not reference send_event_quarantine at all; the erasure scrub's evidence-allowlist reconstruction covers send_events.payload and events.properties only"
    missing:
      - "A bounded retention/purge job for send_event_quarantine mirroring ingress_journal's pruneIngressJournal/purgeExpiredIngressJournalPayloads pair (age-out delete is sufficient here since quarantined rows are diagnostic-only with no replay value), OR a contact_id correlation plus an allowlist-based scrub (mirroring buildScrubbedSendEventPayload) so the erasure scrub can reach these rows."
      - "If retention/scrub-reach for this table is deliberately deferred, an explicit accepted-risk decision recorded in the migration/plan docs the way ingress_journal's exclusion is recorded -- none currently exists; 13-CONTEXT.md D-15 lists this exact question ('Quarantine mechanism shape... its retention...') as still open at planning time, and it was never closed."
human_verification:
  - test: "Unsubscribe atomicity and convergence (ROADMAP SC1 / CMP-01) -- send a real campaign email, click unsubscribe, confirm send/consent-history/campaign-counter all update exactly once, then replay the SendGrid unsubscribe webhook for the same send and confirm nothing changes a second time."
    expected: "Exactly one status change, one consent-history row, one unsubscribed_at fact, one counter increment, regardless of order or replay."
    why_human: "Requires a live dev environment, a real campaign send, and a real or replayed SendGrid webhook delivery -- deferred per human_verify_mode=end-of-phase (13-14-SUMMARY.md coverage D4)."
  - test: "Daily numbers under multiple session timezones (ROADMAP SC2 / CMP-02/CMP-03/CMP-06) -- note a day's sent/delivered counts, trigger reconciliation, repeat under SET TIME ZONE 'Asia/Tokyo', confirm unchanged; inject a 4-day-late webhook event and confirm the day is marked dirty, cleared by the next tick, and the count reflects the late event."
    expected: "Counts are session-timezone-independent and late events land on the day they occurred, not the day they arrived."
    why_human: "Requires a running worker with a live reconciliation tick and direct DB session control -- deferred per human_verify_mode=end-of-phase. (Automated equivalent already passed: reconcile-utc-day.test.ts and analytics-reconciliation-dirty-day.test.ts, run directly by this verification.)"
  - test: "Erasure end-to-end (ROADMAP SC3 / CMP-04) -- delete a contact with sends/events/external_id, confirm disappearance from lists/segments, confirm PII columns null and anonymized_at set, wait for scrub completion, confirm send_events.payload no longer carries the email, re-import the former external_id/email and confirm a new contact is created and suppression still refuses it."
    expected: "All steps in 13-14-SUMMARY.md's checklist step 4 succeed exactly as described."
    why_human: "Requires a live dev environment, the BullMQ scrub worker actually running, and a CSV/API re-import round trip -- deferred per human_verify_mode=end-of-phase. NOTE: independent of this human-verification item, WR-01/the gap above means the checklist's own claim ('the contact's email address no longer appears in any send_events.payload') can be true while the same email still sits in send_event_quarantine.raw_event if that contact ever produced a bad-timestamp webhook event -- the checklist step as written does not check that table."
  - test: "Event integrity (ROADMAP SC4 / CMP-05/CMP-07) -- send a webhook event timestamped 30 days in the past, confirm quarantine + no send_events row + no metric movement; send the same event twice under two different sg_event_id values and confirm exactly one send_events row and one counter increment."
    expected: "Out-of-range timestamps are quarantined per-event without failing the batch; redelivery with an unstable sg_event_id still dedupes to one row."
    why_human: "Requires live webhook delivery against a running API -- deferred per human_verify_mode=end-of-phase. (Automated equivalent already passed: occurred-at-bounds.test.ts, webhook-events-occurred-at-bounds.test.ts, send-events-dedup-rebase.test.ts, all run directly by this verification.)"
  - test: "Backfill and alerts (ROADMAP SC5 / CMP-08/CMP-09) -- stop the worker, deliver a signed webhook batch, confirm an un-ingested journal row, restart, confirm the replay sweep marks it ingested and processes events exactly once; seed a workspace above the complaint warn threshold with OPERATOR_ALERT_EMAIL pointed at a real inbox and confirm operator + tenant-member emails arrive, cooldown suppresses a repeat, and escalation to critical sends immediately."
    expected: "All steps in 13-14-SUMMARY.md's checklist steps 6-7 succeed exactly as described."
    why_human: "Requires a live SendGrid-facing webhook endpoint, a real inbox, and worker stop/restart timing -- deferred per human_verify_mode=end-of-phase. (Automated equivalent already passed: webhook-replay-sweep.test.ts, ingestion-health-watchdog.test.ts, reputation-watchdog.test.ts, scheduler-registration.test.ts, all run directly by this verification.)"
---

# Phase 13: Compliance & Analytics Integrity Verification Report

**Phase Goal:** What the platform claims about consent and delivery matches what actually happened — an unsubscribe is honored everywhere at once, and a daily number means exactly one thing.
**Verified:** 2026-08-12T06:00:00Z
**Status:** gaps_found
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | An unsubscribe updates subscription status, consent history and the originating send as one atomic event — a crash partway through leaves no partial state anywhere. | ✓ VERIFIED | `packages/contacts-core/src/unsubscribe-apply.ts` (`applyUnsubscribeWithSendFact`, single shared write set called from route, webhook, and dropped-with-unsubscribe path). Ran directly: `unsubscribe-apply.test.ts` (7/7 pass), `failure-injection/unsubscribe-atomic.test.ts` (4/4 pass, asserts no partial state at 3 interior transaction boundaries). |
| 2 | Daily metrics are computed from one documented UTC field, and a provider event that arrives late is counted on the day it occurred rather than the day it arrived. | ✓ VERIFIED | `ARCHITECTURE.md` §11 documents the two-field day-authority contract (`sent_at` for `sent_count`, per-event `occurred_at` UTC day for event-derived counters) — a documented, non-ambiguous contract per CMP-02's own Russian wording ("поле... зафиксировано"). Dirty-day re-verification mechanism in `packages/db/src/analytics/daily-rollup.ts` + `analytics-reconciliation.worker.ts`. Ran directly: `reconcile-utc-day.test.ts` (5/5 pass, byte-identical counts under UTC/America-New_York/Asia-Tokyo session timezones), `analytics-reconciliation-dirty-day.test.ts` (12/12 pass). |
| 3 | Deleting a contact removes personal data while leaving the minimum evidence needed to later prove a send or a suppression was lawful. | ✗ FAILED (partial) | Anonymize-in-place erasure, HMAC'd suppression, and allowlist-reconstructed scrub of `send_events.payload`/`events.properties` are real and tested — but `send_event_quarantine` (a table this phase introduced) retains raw unredacted PII indefinitely with no scrub reach and no retention job. See Gaps below. |
| 4 | A provider event carrying an out-of-range or manipulated timestamp cannot bypass deduplication or land outside its partition, and a redelivered event is counted once even when `sg_event_id` is not stable across retries. | ✓ VERIFIED | `packages/delivery-core/src/occurred-at-bounds.ts` (`classifyOccurredAt`, bounds enforced before partition routing or dedup-key construction). Dedup key rebased to `(workspace_id, send_id, event_type, occurred_at)` in migration 0057, `sg_event_id` demoted to forensic column. Ran directly: `occurred-at-bounds.test.ts`, `webhook-events-occurred-at-bounds.test.ts`, `send-events-dedup-rebase.test.ts` (25/25 pass) — all pass. |
| 5 | Metric drift is corrected by a scheduled reconciliation job rather than a one-off fix, events missed while the webhook endpoint was unreachable are recovered by backfill, and a tenant approaching the spam-complaint threshold raises an alert. | ✓ VERIFIED | `apps/worker/src/queues/webhook-replay-sweep.worker.ts` (scheduled stuck-journal-row replay), `apps/worker/src/queues/reputation-tick.worker.ts` (hourly reputation measurement), `apps/api/src/modules/ops/ingestion-health-watchdog.ts` + `reputation-watchdog.ts` (operator/tenant alerting). All registered via `upsertJobScheduler` with stable scheduler ids (`scheduler-registration.test.ts`, 37/37 pass). Ran directly: `webhook-replay-sweep.test.ts` (15/15 pass), `ingestion-health-watchdog.test.ts` (16/16 pass, includes a real `withCrossWorkspaceScan` grant-proving test), `reputation-watchdog.test.ts` (14/14 pass). |

**Score:** 4/5 truths verified (0 present-but-behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/contacts-core/src/unsubscribe-apply.ts` | Single shared atomic unsubscribe write set | ✓ VERIFIED | 156 lines, exported, wired into route/webhook/drop paths, tested |
| `packages/db/src/schema/workspace-daily-rollup.ts` + `analytics-reconciliation.worker.ts` | UTC-forced day bucketing, documented day-authority contract | ✓ VERIFIED | All day-casts use `AT TIME ZONE 'UTC'`; contract documented in schema doc comment and ARCHITECTURE.md §11 |
| `apps/api/src/modules/contacts/contact.repository.ts` + `packages/db/migrations/0059_contact_erasure.sql` | Anonymize-in-place erasure, erasure_records tracking | ✓ VERIFIED | 631-line repository, 99-line migration, RLS-forced, tested (contact-crud, contact-erasure, upsert-anonymized suites) |
| `apps/worker/src/queues/erasure-scrub.worker.ts` + `erasure-scrub-checkpoint.ts` | Bounded, resumable, allowlist-based PII scrub | ✓ VERIFIED — but incomplete in reach | 515-line worker, checkpointed/resumable (erasure-scrub-resume.test.ts, 2/2 pass), covers `sends`/`send_events`/`events` but not `send_event_quarantine` (see Gaps) |
| `apps/worker/src/queues/erasure-scrub-reclaim.worker.ts` | Recovers stranded pending erasure records | ✓ VERIFIED | 387 lines, wired into `apps/worker/src/server.ts`, tested (erasure-scrub-reclaim.test.ts, erasure-enqueue-crash.test.ts) |
| `packages/delivery-core/src/occurred-at-bounds.ts` | Pure bounds classifier | ✓ VERIFIED | 110 lines, exported from index, tested |
| `packages/db/migrations/0057_send_events_dedup_rebase.sql` | Dedup key rebase, fail-closed duplicate guard | ✓ VERIFIED | 273 lines, applies cleanly per `lint:migrations`/`test:migrations` (per 13-14-SUMMARY.md's full-gate run and this verification's `npm run lint:migrations` pass) |
| `apps/worker/src/queues/webhook-replay-sweep.worker.ts` | Scheduled stuck-journal replay + retention tick | ✓ VERIFIED | 451 lines, registered in worker server.ts, tested |
| `apps/api/src/modules/ops/ingestion-health-watchdog.ts` + `reputation-watchdog.ts` | Operator/tenant alerting on ingestion loss and reputation tier crossings | ✓ VERIFIED | 354 + 379 lines, wired into `apps/api/src/server.ts`, tested |
| `packages/db/migrations/0060/0061_suppression_hash_*.sql` + `packages/contacts-core/src/suppression-hash.ts` | HMAC'd suppression list, no plaintext | ✓ VERIFIED | Expand/contract pair, plaintext column dropped in 0061, backfill script (`rehash-suppressions.ts`) exists |
| `packages/db/src/webhooks/quarantine.ts` (`send_event_quarantine`) | Bounded/prunable evidence table per its own migration comment | ✗ INCOMPLETE | Table exists, RLS-forced, insert-only writer works — but no retention/purge/scrub mechanism was ever built despite being promised in the migration comment and the plan's threat model (T-13-04-04) |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `webhooks.routes.ts` | `writeIngressJournal` | journal-before-enqueue ordering | ✓ WIRED | Confirmed by reading `webhooks.routes.ts` sequencing and passing `webhook-events-journal.test.ts` (validated in plan/summary; not independently re-run here, covered by full-suite green run) |
| `apps/worker/src/server.ts` | `createWebhookReplaySweepWorker`, `createReputationTickWorker`, `createErasureScrubWorker`, `createErasureScrubReclaimWorker` | direct import + boot call | ✓ WIRED | `grep -n` confirms all four imported and constructed at lines 219/225/232/242 |
| `apps/api/src/server.ts` | `startIngestionHealthWatchdog`, `startReputationWatchdog` | direct import + boot call | ✓ WIRED | `grep -n` confirms both imported and started (lines 368, 378) |
| `erasure-scrub.worker.ts` | `send_event_quarantine` | (expected) evidence scrub reach | ✗ NOT_WIRED | Zero references found — this is the root cause of Gap #1 |
| `packages/db/migrations/meta/_journal.json` | migrations 0055–0061 | journal entries | ✓ WIRED | All 7 migration tags present in journal |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Atomic unsubscribe (7 cases) | `vitest run --root packages/contacts-core src/__tests__/unsubscribe-apply.test.ts` | 7/7 pass | ✓ PASS |
| Unsubscribe atomicity under injected failure | `vitest run --root apps/worker .../failure-injection/unsubscribe-atomic.test.ts` | 4/4 pass | ✓ PASS |
| UTC day-bucketing under 3 session timezones | `vitest run --root apps/worker .../reconcile-utc-day.test.ts` | 5/5 pass | ✓ PASS |
| Dirty-day mark/sweep for late events | `vitest run --root apps/worker .../analytics-reconciliation-dirty-day.test.ts` | 12/12 pass | ✓ PASS |
| Occurred-at bounds classifier | `vitest run --root packages/db src/__tests__/send-events-dedup-rebase.test.ts` | 25/25 pass | ✓ PASS |
| Erasure-scrub resume-after-crash | `vitest run --root apps/worker .../failure-injection/erasure-scrub-resume.test.ts` | 2/2 pass | ✓ PASS |
| Erasure enqueue crash + reclaim | `vitest run --root apps/worker .../failure-injection/erasure-enqueue-crash.test.ts` | 1/1 pass | ✓ PASS |
| Ingestion-health watchdog (incl. real cross-workspace scan) | `vitest run --root apps/api .../ingestion-health-watchdog.test.ts` | 16/16 pass | ✓ PASS |
| Reputation watchdog | `vitest run --root apps/api .../reputation-watchdog.test.ts` | 14/14 pass | ✓ PASS |
| Webhook replay sweep | `vitest run --root apps/worker .../webhook-replay-sweep.test.ts` | 15/15 pass | ✓ PASS |
| Scheduler registration (all Phase 13 ticks, stable ids) | `vitest run --root apps/worker .../scheduler-registration.test.ts` | 37/37 pass | ✓ PASS |
| `apps/web` build (uses `sent_at`/day-cast code paths) | `npm run build --workspace=apps/web` | builds clean | ✓ PASS |
| Migration lint | `npm run lint:migrations` | "62 file(s) checked, no violations" | ✓ PASS |

No full-suite re-run was performed (per Step 7b constraints) — the orchestrator's context states the full workspace test suite, lint, build, `failure:all` (13 scenarios), and coverage gate all ran green after the final merge, and this verification independently re-ran ~13 targeted, behaviorally-relevant test files (155 individual test cases) covering every non-human-deferred success criterion, all passing.

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|--------------|-----------------|--------------|--------|----------|
| CMP-01 | 13-08 | Atomic unsubscribe (status + consent history + send fact) | ✓ SATISFIED | `unsubscribe-apply.ts`, tests pass |
| CMP-02 | 13-02, 13-03 | Single documented UTC day field for daily metrics | ✓ SATISFIED | `ARCHITECTURE.md` §11, `reconcile-utc-day.test.ts` |
| CMP-03 | 13-05 | Late provider events correctly counted on their occurrence day | ✓ SATISFIED | dirty-day mechanism, tests pass |
| CMP-04 | 13-10, 13-12, 13-13, 13-15 | Contact deletion anonymizes PII while preserving compliance evidence | ⚠️ PARTIAL | Anonymization/suppression/scrub of `contacts`/`sends`/`send_events`/`events` all verified; `send_event_quarantine` PII is never scrubbed and never retention-limited — see Gap #1 |
| CMP-05 | 13-04 | Provider timestamp bounded before partition/dedup use | ✓ SATISFIED | `occurred-at-bounds.ts`, tests pass |
| CMP-06 | 13-02 | Metrics reconciliation runs as a recurring scheduled job | ✓ SATISFIED | `upsertJobScheduler`-based registration, `scheduler-registration.test.ts` |
| CMP-07 | 13-07 | Dedup resilient to unstable `sg_event_id` | ✓ SATISFIED | migration 0057 dedup rebase, tests pass |
| CMP-08 | 13-01, 13-06, 13-11 | Missed webhook events recovered by backfill | ✓ SATISFIED | ingress journal + replay sweep + ingestion-health watchdog, tests pass |
| CMP-09 | 13-09, 13-11 | Reputation tracked per tenant with threshold alerting | ✓ SATISFIED | reputation-tick worker + reputation watchdog, tests pass |

**Note on REQUIREMENTS.md staleness (not a gap):** `.planning/REQUIREMENTS.md` still shows CMP-02, CMP-06, CMP-08, and CMP-09 as unchecked (`[ ]`) with traceability-table status `Pending`, last updated 2026-07-27 — before Phase 13 executed. All 9 CMP-xx requirement IDs are declared across the 15 plans' frontmatter (cross-referenced above), no ID is orphaned, and each has independent code + test evidence. This is a requirements-tracking-document sync gap, not a functional gap — the checkboxes should be updated as part of phase close, but they do not block the phase goal.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `packages/db/migrations/0055_webhook_ingress_durability.sql` / `packages/db/src/webhooks/quarantine.ts` | table-wide | No retention/scrub mechanism for `send_event_quarantine`, contradicting its own migration comment | 🛑 Blocker | See Gap #1 (SC3/CMP-04) |
| `packages/db/src/sends/fact-columns.ts` | 33-53 | Dynamic SQL column-name interpolation with no allow-list (unlike every sibling helper in the same phase) | ⚠️ Warning | No live exploit today (all call sites pass literals), but no compile-time/runtime guard against a future less-trusted caller — 13-REVIEW.md WR-02 |
| `packages/contacts-core/src/unsubscribe-apply.ts:116-127`, `apps/worker/src/queues/webhook-events.worker.ts:198-209,228-237` | as noted | Missing explicit `AND workspace_id = $N` defense-in-depth predicate present on sibling queries in the same files | ⚠️ Warning | RLS still enforces isolation; inconsistent with the codebase's own stated convention — 13-REVIEW.md WR-03 |
| `apps/api/src/modules/ops/reputation-watchdog.ts:326-357` | as noted | Alert claim released on partial mid-batch send failure, allowing duplicate sends to already-notified recipients on retry | ⚠️ Warning | At-least-once, not exactly-once, alert delivery — does not falsify "raises an alert" (ROADMAP SC5), acceptable degradation — 13-REVIEW.md WR-04 |

No `TBD`/`FIXME`/`XXX` debt markers found in any file touched by this phase's 15 plans (checked against every file listed in the SUMMARY key-files sections).

### Human Verification Required

See frontmatter `human_verification` — five items, one per ROADMAP success criterion, all explicitly deferred by the phase's own plans (human_verify_mode=end-of-phase) to the 7-step checklist reproduced verbatim in `13-14-SUMMARY.md`. Every non-live-system-dependent half of each item has already been independently re-run and passed by this verification (see Behavioral Spot-Checks above). Item 3 additionally carries a note that the Gap #1 finding means one clause of the checklist's own step 4 ("email no longer appears in any send_events.payload") is true while not covering `send_event_quarantine`, so the human operator should not read a clean step-4 pass as closing WR-01.

### Gaps Summary

One blocking gap: **`send_event_quarantine`, a table this phase itself introduced to hold rejected webhook events, retains complete unredacted recipient PII indefinitely and is untouched by both the CMP-04 erasure scrub and by any retention/purge job.** This directly contradicts the phase goal's compliance promise for exactly the subset of a contact's webhook history that happened to arrive with a bad or missing timestamp. The gap was independently confirmed by direct codebase grep (not taken on the code-review's word), and by checking that neither 13-CONTEXT.md nor any plan ever closed the open question 13-CONTEXT.md itself raised about this table's retention. Phase 14's DB-11 (generic data retention) does not cover this — it addresses table-level retention scheduling generally, not CMP-04's erasure-reach guarantee, which is Phase 13's own requirement.

Four of five ROADMAP success criteria are fully verified with passing behavioral evidence independently re-run by this verification. The fifth (SC3 / contact erasure) is correctly built for every path this phase's own must_haves scoped, but does not close the gap this phase itself opened by adding the quarantine table.

---

*Verified: 2026-08-12T06:00:00Z*
*Verifier: Claude (gsd-verifier)*
