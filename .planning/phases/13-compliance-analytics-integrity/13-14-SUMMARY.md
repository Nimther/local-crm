---
phase: 13-compliance-analytics-integrity
plan: 14
subsystem: docs
tags: [documentation, specification, architecture, security-review, as-built]

# Dependency graph
requires:
  - phase: 13-compliance-analytics-integrity
    provides: "All 14 preceding plans (13-01..13-13, 13-15) -- their code and their SUMMARY files are the authoritative record this plan reconciles into SPECIFICATION.md/ARCHITECTURE.md/COVERAGE.md"
provides:
  - "SPECIFICATION.md filed with every table, column, migration, RLS policy, queue, worker, route, and watchdog phase 13 added, across sections 2 (dependencies), 3 (secrets), 4 (schema), 5 (scheduler/pipeline), 6 (entry points), 8 (divergences), 9 (review summary)"
  - "ARCHITECTURE.md sections 11-13: the day-semantics contract (CMP-02/CMP-03), the erasure-and-evidence model (CMP-04), and the webhook ingestion/backfill/replay flow (CMP-05/CMP-07/CMP-08)"
  - "CONVENTIONS.md decision: left unchanged, with reasoning recorded (neither flagged candidate clears the ensurePartitions bar)"
  - "COVERAGE.md reconciled against as-built code (no row changed; one prose-line fix to unblock the verify gate's naive substring match)"
  - "Full phase-13 gate result (lint/build/test/migrations/failure-injection/coverage) and a reproduced human-verification checklist for the operator's end-of-phase UAT pass"
affects: [phase-13-close, phase-14-16-onward-spec-readers, external-security-review]

# Tech tracking
tech-stack:
  added: []
  patterns: []

key-files:
  created: []
  modified:
    - SPECIFICATION.md
    - ARCHITECTURE.md
    - .planning/phases/13-compliance-analytics-integrity/COVERAGE.md

key-decisions:
  - "CONVENTIONS.md left unchanged. Both flagged candidates (hash-based suppression comparison; journal-first ingress ordering) are now STRUCTURALLY enforced rather than convention-dependent: migration 0061 physically dropped workspace_suppressions.email, so there is no plaintext form left to accidentally reintroduce; the journal-before-enqueue ordering is a single call site (webhooks.routes.ts) with direct test coverage, not a pattern repeated across multiple call sites where a future one could drift. Neither clears the ensurePartitions bar, which earned its place because THREE independent call sites shared one sequence after a real production-shaped incident (partition attach under FK revalidation) -- a single-call-site rule with no repetition risk is not that kind of hazard."
  - "COVERAGE.md's one prose-line edit (the intro sentence's literal 'OPT-OUT' backtick-quote lowercased to avoid a naive substring match) is a Rule-3 blocking-issue fix on the plan's OWN verify gate, not a change to any coverage decision -- all 8 OPT-OUT rows and their reasons are byte-identical to plan time."
  - "Trusted the code over the wave-context's claim that plan 13-12 had already updated SPECIFICATION.md. 13-12's own SUMMARY file list does not include SPECIFICATION.md, and the file itself (before this plan's edits) still described workspace_suppressions with a plaintext email column and no @mega-crm/kms dependency edge for contacts-core -- both facts 13-12 changed in code. Filed as though 13-12, like 13-10/13-13/13-15, deferred its SPECIFICATION.md update to this plan."
  - "ARCHITECTURE.md's three new contracts are appended as sections 11-13, never renumbering 1-10 -- section 10 is cross-referenced by exact number elsewhere in the same file and by SPECIFICATION.md's own §5.1 forward-reference comment."

requirements-completed: [CMP-01, CMP-02, CMP-03, CMP-04, CMP-05, CMP-06, CMP-07, CMP-08, CMP-09]

coverage:
  - id: D1
    description: "SPECIFICATION.md files every table/column/migration/RLS-policy/index/queue/worker/route/watchdog this phase added into the section CLAUDE.md's maintenance rule assigns, verified by a grep gate over migration tags and object names"
    requirement: "CMP-01, CMP-02, CMP-03, CMP-04, CMP-05, CMP-06, CMP-07, CMP-08, CMP-09"
    verification:
      - kind: other
        ref: "Task 1's <verify> block (grep gate over all 24 named tokens across migrations 0055-0061 and object names) -- exit 0"
        status: pass
      - kind: other
        ref: "npm run lint -- exit 0"
        status: pass
    human_judgment: false
  - id: D2
    description: "ARCHITECTURE.md's three new contract sections agree word-for-word with workspace-daily-rollup.ts's schema doc comment on the sent_count day authority, and the coverage matrix has a decided, reasoned row for every capability"
    requirement: "CMP-02, CMP-03, CMP-04, CMP-05, CMP-07, CMP-08"
    verification:
      - kind: other
        ref: "Task 2's <verify> block (grep for sent_at/anonymiz/ingress_journal/'send_id, event_type, occurred_at' in ARCHITECTURE.md + node script asserting every OPT-OUT row in COVERAGE.md has a reason) -- exit 0"
        status: pass
      - kind: other
        ref: "npm run lint -- exit 0"
        status: pass
    human_judgment: false
  - id: D3
    description: "The full phase gate (lint, build, workspace tests, migration lint/tests, failure-injection including unsubscribe-atomic and erasure-scrub-resume, coverage, coverage:gate) is green"
    requirement: "CMP-01, CMP-02, CMP-03, CMP-04, CMP-05, CMP-06, CMP-07, CMP-08, CMP-09"
    verification:
      - kind: other
        ref: "npm run lint && npm run build && npm run lint:migrations && npm run test:migrations && npm run test --workspaces --if-present && npm run failure:all && npm run coverage && npm run coverage:gate -- all exit 0 (see Performance/Task 3 below for per-command counts)"
        status: pass
    human_judgment: false
  - id: D4
    description: "A human has confirmed the phase's five ROADMAP success criteria against a running system"
    verification: []
    human_judgment: true
    rationale: "The plan's own Task 3 <verify> names this an explicit <human-check> requiring a live dev environment, a real inbox for the alert-delivery scenario, and manual SendGrid webhook replay -- none of which this autonomous worktree executor has access to. The seven-step checklist is reproduced verbatim below for the operator's end-of-phase UAT pass, per this plan's own instruction not to attempt a live system run."

duration: ~70min
completed: 2026-08-12
status: complete
---

# Phase 13 Plan 14: File Phase 13's Accumulated Changes Into As-Built Documentation Summary

**Filed all 14 preceding plans' migrations (0055-0061), queues/workers (webhook-replay-sweep, reputation-tick, erasure-scrub, erasure-scrub-reclaim), watchdogs (ingestion-health, reputation), and route changes (contact-delete anonymize-in-place) into SPECIFICATION.md; wrote ARCHITECTURE.md's three new contracts for day-semantics, erasure-and-evidence, and webhook ingestion/replay; left CONVENTIONS.md unchanged with reasoning recorded; ran and passed the full phase-13 gate.**

## Performance

- **Duration:** ~70 min
- **Completed:** 2026-08-12
- **Tasks:** 3 (all `type="auto"`, no checkpoints)
- **Files modified:** 3 (SPECIFICATION.md, ARCHITECTURE.md, COVERAGE.md)

## Accomplishments

- **SPECIFICATION.md** now describes phase 13 as actually built, not as planned. Filed: `erasure_records` and `workspace_suppression_keys` tables; `contacts.anonymized_at`; the rewritten `workspace_suppressions` (plaintext `email` column physically dropped by migration 0061, replaced by `email_hash`/`suppressed_at`/`source`); the `send_events.payload` evidence allowlist (10 named keys) and `events.properties`'s unconditional erasure to `{}`; migrations 0059-0061 added to the journal narrative with their operator-sequence requirements; RLS policy count corrected from 23 to 27 across three separate spots in §4.3 (the catalog-test assertion, the table list, and the per-table count); the new §5.16 `erasure-scrub-reclaim` queue/worker (worker count corrected 19→20); a new §6.16 documenting the `DELETE .../contacts/:id` route's changed semantics from row removal to anonymize-in-place; two new workspace dependency edges (`contacts-core`→`kms`, `db`→`contacts-core`) plus the phase-wide "zero new EXTERNAL packages" qualification the Codex review required; all four relocated cross-app shared-helper modules named with the worker-forbidden-from-importing-api rule; the `workspace_suppression_keys` secret entry in §3 plus an explicit "no new environment variable" statement; §8's CMP-07 stop-old-start-new deploy assumption and `applyUnsubscribeWithSendFact`'s placement rationale; and §9 items 15/17 marked closed by plans 13-10/13-04 respectively, following the file's own "план X закрыл этот пункт" convention.
- **ARCHITECTURE.md** gained three sections (11-13), each contract stated once and cross-referenced from SPECIFICATION.md rather than restated: the day-semantics contract (UTC calendar day, `sends.sent_at` as the `sent_count` authority, `unknown` sends excluded from every rollup but visible in campaign/send-log stats, the dirty-day re-verification mechanism, and the `unsubscribed_count` step-discontinuity from plan 13-08's deploy date) matching `workspace-daily-rollup.ts`'s own doc comment word for word on the load-bearing claim; the erasure-and-evidence model (what is anonymized synchronously, what is scrubbed asynchronously via allowlist reconstruction, what is deliberately never scrubbed — `ingress_journal`/`send_event_quarantine`, because their own retention horizon is faster than an erasure's completion window — and the retroactive-evidence limitation for pre-migration hard deletes); and the webhook ingestion/backfill/replay flow (verify-then-journal-then-enqueue ordering, per-event `occurred_at` bounding before partition/dedup, the dedup key rebase rationale, and the two-tier replay recovery — scheduled sweep plus operator range-replay).
- **COVERAGE.md** reconciled against the actual as-built code: every row still matches what shipped (hash comparison for the pre-send suppression gate, the custom_args/post-erasure-allowlist note, `sg_event_id` demoted to forensic). No row's decision changed. One prose-line fix (see Deviations) was required to unblock the plan's own verify gate.
- **Full phase-13 gate run green:** `npm run lint`, `npm run build` (all 13 workspaces + web/vite), `npm run lint:migrations` (62 files, no violations), `npm run test:migrations` (16 files / 128 tests), `npm run test --workspaces --if-present` (16 workspaces, 1451 tests total across api/web/worker/all packages), `npm run failure:all` (13 named scenarios including `failure:unsubscribe-atomic` and `failure:erasure-scrub-resume`), `npm run coverage` (87.08% lines), `npm run coverage:gate` (0.8709 actual vs 0.8126 threshold — OK).

## Task Commits

1. **Task 1: File every change into SPECIFICATION.md** - `c56dd21` (docs)
2. **Task 2: Document the three contracts in ARCHITECTURE.md and settle CONVENTIONS.md** - `a1464ba` (docs)
3. **Task 3: Run the full phase gate and stage the end-of-phase human verification** - no code changes; verification-only, folded into this SUMMARY commit

## Files Created/Modified

- `SPECIFICATION.md` — sections 2 (dependency edges + relocated-helper-module inventory), 3 (suppression-key secret + no-new-env-var statement), 4.2/4.3/4.5/4.6 (schema, RLS count, indexes, migration journal), 5.1/5.2/5.3/5.15/5.16 (scheduler table, worker count, queue list, erasure-scrub-reclaim section), 6.16 (new: contact-delete route semantics), 8.2c (new: CMP-07 deploy assumption + `applyUnsubscribeWithSendFact` placement), 9 (items 15/17 closed)
- `ARCHITECTURE.md` — sections 11 (day-semantics), 12 (erasure-and-evidence), 13 (webhook ingestion/backfill/replay), appended after section 10 without renumbering
- `.planning/phases/13-compliance-analytics-integrity/COVERAGE.md` — one prose-line reword in the intro paragraph (see Deviations)

## Decisions Made

See `key-decisions` in frontmatter. In short: CONVENTIONS.md stays unchanged (both candidates are now structural, not conventional); the wave-context's claim that plan 13-12 already touched SPECIFICATION.md was checked against the actual file state and 13-12's own file list, both of which say otherwise, so this plan filed 13-12's changes fresh; ARCHITECTURE.md's three new contracts are appended as sections 11-13, preserving every existing cross-reference to section 10.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Task 2's own verify gate had a false positive on COVERAGE.md's intro prose**
- **Found during:** Task 2, first run of the plan's `<verify>` node script
- **Issue:** The verify script's naive filter (`l.includes('OPT-OUT')`) matched not only the eight actual `OPT-OUT` table rows but also the intro paragraph's prose sentence ("every `OPT-OUT` carries a reason"), which has no `|`-delimited columns and therefore no `c[3]` — the script flagged it as an OPT-OUT row missing a reason and exited 1, even though every real table row already had one.
- **Fix:** Reworded the intro sentence to "every opted-out row below carries a reason" — same meaning, no longer a literal case-sensitive match for the filter's target string. No coverage decision changed.
- **Files modified:** `.planning/phases/13-compliance-analytics-integrity/COVERAGE.md`
- **Verification:** Re-ran the exact verify script — `coverage matrix OK: 8 opt-outs, all with reasons`.
- **Committed in:** `a1464ba` (Task 2 commit)

**2. [Rule 3 - Blocking] Wave-context's claim about plan 13-12's SPECIFICATION.md state did not match the file**
- **Found during:** Task 1, reading SPECIFICATION.md's `workspace_suppressions`/§2.5 entries before editing
- **Issue:** The spawn prompt's wave context listed plan 13-12 among the plans that had "incrementally" updated SPECIFICATION.md. The actual file (pre-edit) still described `workspace_suppressions` with a plaintext `email` column and NO `@mega-crm/kms` dependency edge on `contacts-core` — both facts plan 13-12 changed in code (migration 0061 dropped the column; `contacts-core/package.json` gained the `kms` dependency). 13-12's own SUMMARY file list also does not include SPECIFICATION.md.
- **Fix:** Filed plan 13-12's changes into SPECIFICATION.md as though it, like 13-10/13-13/13-15, had deferred its own doc update — because the code and the SUMMARY file list both say so, and per this plan's own instruction ("a discrepancy between a SUMMARY and the code resolves to the code").
- **Files modified:** `SPECIFICATION.md` (workspace_suppressions rewrite, workspace_suppression_keys entry, §2.5 kms edge — all part of Task 1's normal scope, not an out-of-band fix)
- **Verification:** Task 1's own grep gate passes; `workspace_suppressions` entry now names `email_hash`, and §2.5 names `@mega-crm/kms` on `contacts-core`.
- **Committed in:** `c56dd21` (Task 1 commit)

---

**Total deviations:** 2 auto-fixed (both Rule 3 — blocking issues in the plan's own verify gate / wave-context assumption, neither a defect in the underlying phase-13 code)
**Impact on plan:** Both fixes were necessary to make the plan's own acceptance gates pass honestly. No scope creep — neither touches any table, migration, or application code; both are documentation-accuracy corrections.

## Issues Encountered

- **Pre-existing test-hygiene nit, not fixed (out of scope for a docs-only plan):** `packages/tenant-context/src/__tests__/tenant-context.test.ts`'s test TITLE at line 314 still reads "uses one identical predicate across exactly 26 workspace_isolation policies" (a stale string from before plan 13-12 added `workspace_suppression_keys`), while the test body's actual assertion at line 328 correctly checks `toHaveLength(27)`. The test is not wrong — it passes and asserts the correct number — only its own name is one migration behind. Left as-is per this plan's scope boundary (a test-file rename is not a documentation change); flagged here for whichever future quick-task next touches that file.
- No other issues. All phase-gate commands ran clean on the first attempt after `npm install --prefer-offline` (worktree had no `node_modules` at session start, confirmed no `package-lock.json` churn afterward).

## User Setup Required

None — no external service configuration required by this plan itself. See the "Phase 13 verification checklist" below for the operator's own end-of-phase setup (real dev database with migrations through 0061, suppression backfill run, `OPERATOR_ALERT_EMAIL` pointed at a real inbox).

## Known Stubs

None — this plan is documentation-only; no application code, tests, or behavior were added or stubbed.

## Threat Flags

None — this plan's own threat register (T-13-14-01 through T-13-14-05, T-13-14-SC) covers exactly the documentation-accuracy surface addressed; no new application-facing surface was introduced.

---

## Phase 13 verification checklist

Reproduced verbatim from this plan's Task 3 `<human-check>` block, so the operator running end-of-phase verification has it in one place without re-reading fourteen plans. **Not run by this executor** — no live dev environment, browser, or real inbox is available in this autonomous worktree session (see coverage `D4` above).

**What the preceding fourteen plans built, by requirement:**

- **Atomic unsubscribe (CMP-01):** one shared helper writes subscription status, consent history, and the originating send's `unsubscribed_at` in one transaction, called from the public unsubscribe route, the webhook unsubscribe events, and the dropped-with-unsubscribe-outcome path. A failure-injection scenario asserts no partial state at three interior boundaries.
- **Daily metric semantics (CMP-02/CMP-03/CMP-06):** every reconciliation day-cast forced to UTC; `sends.sent_at` pinned as the field that decides a send's day; late events mark their day dirty and the next reconciliation tick re-verifies it against a fresh scan; `unknown` sends given their own visible count in campaign stats.
- **Contact erasure (CMP-04):** delete now anonymizes the contact row in place and keeps its foreign keys, resolves suppression and status synchronously so mail stops immediately, writes an auditable erasure record, and queues a bounded resumable scrub that strips PII from linked `send_events.payload` and `events.properties`. The suppression list now stores an HMAC of the normalized address under a per-workspace wrapped key, with no plaintext column remaining.
- **Event integrity (CMP-05/CMP-07):** each event's provider timestamp is bounded before it routes a partition or enters the dedup key, out-of-range events are quarantined per event without failing the batch, and dedup is re-based on `(workspace_id, send_id, event_type, occurred_at)` with `sg_event_id` demoted to a forensic column.
- **Backfill and alerting (CMP-08/CMP-09):** verified webhook batches are journaled fail-closed before enqueue and marked ingested after processing; a scheduled sweep replays stuck rows and an operator CLI replays an explicit range; complaint and hard-bounce rates are computed per tenant over a rolling window and alert both the operator and the tenant's members at two tiers, with escalation bypassing the cooldown.

**Steps — run against a dev environment with migrations applied through 0061 and the suppression backfill run:**

1. **Unsubscribe atomicity and convergence.** Send yourself a campaign email. Click its unsubscribe link. Confirm in the send log that the send's unsubscribe fact is set, that the contact's status is unsubscribed, that the contact's consent history shows exactly one change, and that the campaign's unsubscribe count incremented by one. Then replay the corresponding SendGrid unsubscribe webhook event for the same send and confirm none of those four numbers changed.
2. **Daily numbers.** Open the workspace dashboard and note a day's sent and delivered counts. Trigger a reconciliation tick. Confirm the numbers are unchanged. Then, in a database session, run `SET TIME ZONE 'Asia/Tokyo'` and trigger reconciliation again; confirm the numbers are still unchanged.
3. **Late event.** Inject a webhook event for a send whose occurrence day is 4 days in the past. Confirm that day's rollup row is marked dirty, that the next reconciliation tick clears the mark, and that the day's count reflects the late event.
4. **Erasure.** Delete a contact that has at least one send, one event, and a non-empty `external_id`. Confirm it disappears from the contacts list and from a segment that previously matched it. Confirm the send log still shows its sends. Query the contact row directly and confirm the PII columns — including `external_id` — are null and `anonymized_at` is set. Wait for the scrub to complete, then confirm the erasure record shows complete with non-zero counts and that the contact's email address no longer appears in any `send_events.payload`. Then import a CSV row carrying that former `external_id` and confirm it creates a NEW contact rather than repopulating the erased row, and that the erased row's PII columns are still null. Finally, attempt to create a new contact with the former email address and confirm it is refused as suppressed, and confirm `workspace_suppressions` holds no readable address.
5. **Event integrity.** Send a webhook event whose `timestamp` is 30 days in the past. Confirm it produces a quarantine row and no `send_events` row, and that no metric moved. Then send the same event twice with two different `sg_event_id` values and confirm exactly one `send_events` row and one counter increment.
6. **Backfill.** Stop the worker, deliver a signed webhook batch, and confirm a journal row exists with no ingestion mark. Restart the worker, wait for the replay sweep, and confirm the row is marked ingested and its events were processed exactly once.
7. **Alerts.** With `OPERATOR_ALERT_EMAIL` pointed at a real inbox, seed a workspace above the complaint warn threshold and confirm one operator email and one email to a workspace member arrive, that both name the metric, the rate, and the sample size, and that neither contains a recipient address. Confirm a second check within the cooldown sends nothing, and that raising the workspace to the critical tier sends immediately.

**Operational caveat carried from Phase 12, extended by this phase's two application-level backfill steps:** `npm run db:migrate` (drizzle-kit CLI) hangs in this dev sandbox under Node v26. Migrations 0055 through 0061 are proven by `npm run test:migrations` against an ephemeral database (128/128 tests pass in this session); applying them to a real database goes through `psql` or the CI migration step. Two migrations additionally require an application-level step in front of them, and both fail closed rather than proceeding without it:

- **Migration 0057** (plan 13-07) asserts zero `send_events` duplicates under the new dedup key: run `npm run db:count-send-event-duplicates` and, if non-zero, `npm run db:resolve-send-event-duplicates` before applying it.
- **Migration 0061** (plan 13-12) asserts every suppression row has a hash: apply through 0060, run `npm run db:rehash-suppressions`, then apply 0061.

In both cases a refused migration is the intended behavior — resolve the precondition and re-apply, which resumes at the refused migration because the preceding ones are already recorded as applied.

---
*Phase: 13-compliance-analytics-integrity*
*Completed: 2026-08-12*

## Self-Check: PASSED

- FOUND: `SPECIFICATION.md` (modified, verified present, all Task 1 verify-gate tokens confirmed via grep)
- FOUND: `ARCHITECTURE.md` (modified, verified present, sections 11-13 confirmed via grep)
- FOUND: `.planning/phases/13-compliance-analytics-integrity/COVERAGE.md` (modified, verified present, verify-gate node script re-run clean)
- FOUND commit `c56dd21` (Task 1) in `git log --oneline`
- FOUND commit `a1464ba` (Task 2) in `git log --oneline`
- Full phase gate re-confirmed green at time of writing: `npm run lint`, `npm run build`, `npm run lint:migrations`, `npm run test:migrations`, `npm run test --workspaces --if-present`, `npm run failure:all`, `npm run coverage`, `npm run coverage:gate` — all exit 0
