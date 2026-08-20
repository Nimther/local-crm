---
phase: 11-delivery-correctness
plan: 10
subsystem: delivery
tags: [send-log, reconciler, worker, react, fastify, bullmq, vitest]

# Dependency graph
requires:
  - phase: 11-delivery-correctness (plan 11-01)
    provides: "SEND_STATUSES/SendStatus vocabulary and the DLV-07 delivery-model prose in ARCHITECTURE.md ##9, which this plan's UI copy must stay honest to"
  - phase: 11-delivery-correctness (plan 11-05/11-06)
    provides: "classifyTransportError and handleAmbiguousSendMailError -- the shared ambiguity classification this plan's test-send branch reuses rather than re-deriving"
  - phase: 11-delivery-correctness (plan 11-08)
    provides: "The full reconciler verdict wiring (resolve_sent/resolve_unknown/sweep_to_reconciling) whose output (sends.status IN ('reconciling','unknown')) this plan makes visible"
provides:
  - "SEND_LOG_STATUSES (API) and the web SendLogStatus union both carry reconciling/unknown, with a drift test pinning them together"
  - "COMPUTED_STATUS_SQL's CASE ladder resolves reconciling BEFORE the delivery-fact chain and unknown AFTER it -- an unknown row with no facts never renders as sent, and a reconciling row's copy wins over a not-yet-adjudicated fact"
  - "SendJobResult's { outcome: 'unknown'; sendId } variant -- the test-send-only ambiguous disposition, returned (never thrown) so BullMQ completes the job instead of redelivering it"
  - "handleEmailBroadcastJob/handleEmailTriggeredJob -- the two Workers' inline processors factored into exported, deps-injectable functions so the unknown-outcome-never-throws behavior is directly testable"
  - "TestSendPanel.tsx's confirmation copy describes queuing, not delivery, and carries D-11's check-the-inbox-before-re-sending guidance"
affects: [11-11, phase-12, phase-13, phase-15]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Hand-maintained cross-app vocabulary pinned by a commented copy, not a cross-package import -- apps/web has no package dependency on apps/api, so send-log-status-vocabulary.test.ts asserts SEND_LOG_STATUS_VALUES against a literal copy of SEND_LOG_STATUSES with a comment naming the source file, rather than importing backend source into a Vite/node test project"
    - "Asymmetric CASE-ladder placement for two ledger states that both fall through the same fact chain, for opposite reasons -- reconciling checked BEFORE the delivery-fact chain (still being adjudicated, a fact must not jump ahead of the sole writer), unknown checked AFTER it (late evidence wins, matching the reconciler's own re-scan semantics)"
    - "Exported, deps-injectable Worker processors (handleEmailBroadcastJob/handleEmailTriggeredJob) mirroring processSendJob's own exported-standalone convention, deps defaulting to {} for full backward compatibility with the existing createEmailBroadcastWorker/createEmailTriggeredWorker call sites"

key-files:
  created:
    - apps/web/src/features/send-log/__tests__/send-log-status-vocabulary.test.ts
    - apps/worker/src/queues/__tests__/test-send-outcome.test.ts
  modified:
    - apps/api/src/modules/send-log/send-log.repository.ts
    - apps/api/src/modules/send-log/__tests__/send-log-filters.test.ts
    - apps/api/src/modules/analytics/timeline.repository.ts
    - apps/web/src/features/send-log/api.ts
    - apps/web/src/features/send-log/SendLogPage.tsx
    - apps/worker/src/queues/send-dispatch.ts
    - apps/worker/src/queues/email-broadcast.worker.ts
    - apps/worker/src/queues/email-triggered.worker.ts
    - apps/web/src/features/campaigns/TestSendPanel.tsx
    - SPECIFICATION.md

key-decisions:
  - "apps/web's drift test pins a commented copy of the API's SEND_LOG_STATUSES rather than cross-importing apps/api source, per the plan's own explicitly-sanctioned fallback -- apps/web declares no package dependency on apps/api, and importing app source across app boundaries would drag backend-only runtime deps (pg, @mega-crm/tenant-context) into a Vite/node test project."
  - "timeline.repository.ts's parallel CASE ladder needed only a one-line reconciling fix (checked before its fact chain) -- its existing ELSE already returns the raw status text after the fact chain, which is already the correct late-evidence-wins behavior for unknown, so no explicit unknown arm was added there (documented inline so a future reader doesn't wonder why send-log's ladder has one more arm than timeline's)."
  - "email-broadcast.worker.ts/email-triggered.worker.ts (NOT listed in the plan's files_modified frontmatter) were modified anyway: the plan's own Task 2 <action> text explicitly requires 'Add an explicit comment' in both files, and its <behavior>/acceptance criteria require a Worker-level test proving an unknown outcome never throws. Since the two Workers' processors were anonymous inline closures with no deps-injection seam, proving that behavior directly (rather than duplicating the two-line conditional in a test, which the plan warns risks drift) required factoring each into an exported, deps-injectable function. Deps default to {}, so every existing call site (createEmailBroadcastWorker(connection), unchanged in apps/worker/src/server.ts) behaves byte-identically to before."
  - "The test-send route's already-live 202 { queued: true, to } contract (unchanged this plan) is documented for the first time in SPECIFICATION.md SS6, alongside the three-outcome vocabulary -- it existed before this plan but had no SS6 entry."

requirements-completed: [DLV-02, DLV-07]

coverage:
  - id: D1
    description: "The send log displays and filters reconciling/unknown -- a marketer sees a genuinely unresolved send as such, never as an old status that misrepresents it"
    requirement: "DLV-07"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/send-log/__tests__/send-log-filters.test.ts#11-10 (DLV-02/DLV-07): renders and filters `reconciling`/`unknown`"
        status: pass
      - kind: unit
        ref: "apps/web/src/features/send-log/__tests__/send-log-status-vocabulary.test.ts (4 tests)"
        status: pass
    human_judgment: false
  - id: D2
    description: "The computed-status CASE maps reconciling/unknown to themselves rather than falling through to a delivery fact -- an unknown row with no facts never renders as sent; a reconciling row with a fact still renders as reconciling"
    requirement: "DLV-02"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/send-log/__tests__/send-log-filters.test.ts#11-10 (DLV-02/DLV-07): renders and filters `reconciling`/`unknown`"
        status: pass
    human_judgment: false
  - id: D3
    description: "An ambiguous test send is reported as an unknown outcome, never a success or plain failure, and is not automatically retried"
    requirement: "DLV-07"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/test-send-outcome.test.ts (7 tests, including the Worker-level handleEmailBroadcastJob resolves-not-throws case)"
        status: pass
    human_judgment: false
  - id: D4
    description: "A test send still creates no sends row, participates in no reconciliation, and contributes to no analytics -- D-11's boundary is intact"
    requirement: "DLV-07"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/test-send-outcome.test.ts#sendsRowCountForCampaign assertions (unknown/failed cases)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Test-send confirmation copy no longer claims delivery it cannot observe -- describes queuing and carries the check-the-inbox-before-re-sending guidance"
    requirement: "DLV-07"
    verification:
      - kind: unit
        ref: "apps/web/src/features/campaigns __tests__ suite (existing 4 tests, unaffected; acceptance-criteria grep for the removed literal string confirmed manually)"
        status: pass
    human_judgment: false
  - id: D6
    description: "Daily rollups continue to exclude unknown from sent/failed counts"
    requirement: "DLV-07"
    verification: []
    human_judgment: true
    rationale: "Not re-verified by this plan -- 11-08's SUMMARY already documents the rollup's fact-column-driven exclusion (an unknown row has no sent_at), and this plan touches no rollup code. Flagged for human confirmation rather than silently assumed."

# Metrics
duration: ~70min
completed: 2026-08-09
status: complete
---

# Phase 11 Plan 10: Send-Log Vocabulary and Honest Test-Send Copy Summary

**`reconciling`/`unknown` are now filterable, correctly-computed statuses in the send log on both sides of the API boundary, test sends report a third `unknown` outcome that never auto-retries, and the test-send confirmation toast stopped claiming delivery it never observed.**

## Performance

- **Duration:** ~70 min
- **Completed:** 2026-08-09
- **Tasks:** 3
- **Files modified:** 11 (2 created, 9 modified)

## Accomplishments

- **Task 1 -- send-log vocabulary:** `SEND_LOG_STATUSES` (API) grew from 9 to 11 members; `COMPUTED_STATUS_SQL`'s CASE ladder gained `reconciling` (checked BEFORE the D-06 delivery-fact chain -- a row can be `reconciling` while a webhook has already written a fact the reconciler hasn't adjudicated yet) and `unknown` (checked AFTER the fact chain -- late evidence wins, matching the reconciler's own re-scan semantics). `timeline.repository.ts`'s sibling CASE ladder needed only a one-line `reconciling` fix; its `unknown` behavior was already correct via its existing `ELSE`. The web `SendLogStatus` union, `SEND_STATUS_LABELS`/`SEND_STATUS_CLASSES`/`STATUS_OPTIONS` all gained matching entries -- labels ("Уточняется" / "Исход неизвестен") and classes (amber, never green or red) are honest to ARCHITECTURE.md ##9's DLV-07 delivery model. A drift test pins the API and web vocabularies together despite apps/web having no package dependency on apps/api.
- **Task 2 -- test-send outcome vocabulary:** `SendJobResult` gained `{ outcome: "unknown"; sendId }`. The `kind='test'` branch in `send-dispatch.ts` now wraps its `sendMail` call in the same `classifyTransportError`-driven try/catch the campaign/flow branches use (11-05/11-06): `pre_connection_retryable` rethrows (no row to release, transport proved nothing was sent), `ambiguous` logs via `scrubbedConsole` (campaign id + outcome only, never the recipient) and returns `{ outcome: "unknown" }` without throwing, so BullMQ completes the job instead of redelivering it (D-11). Both Workers' inline processors were factored into exported `handleEmailBroadcastJob`/`handleEmailTriggeredJob` functions (deps default `{}`, fully backward compatible) so the "an unknown outcome never throws" behavior is directly testable through the existing `ProcessSendJobDeps` seam rather than duplicated in a test. 7 new tests cover every `<behavior>` item.
- **Task 3 -- honest test-send copy:** `TestSendPanel.tsx`'s success toast changed from "Тестовое письмо отправлено на ..." (a delivery claim the `202` response cannot support) to "поставлено в очередь на ..." plus a description carrying D-11's guidance: check the inbox before manually re-sending, since an outcome the platform could not determine is never re-sent automatically. `TEST_SEND_FAILURE` is unchanged for genuine HTTP errors. No polling/result-callback surface was added.
- `SPECIFICATION.md` SS6 gained a new paragraph documenting the test-send route's three-outcome vocabulary and the no-automatic-retry rule (the route's pre-existing `202 { queued: true, to }` contract had no SS6 entry before this plan).

## Task Commits

1. **Task 1: Send-log vocabulary gains reconciling and unknown, on both sides of the API boundary** - `b406e17` (feat)
2. **Task 2: Test sends report an unknown outcome and never auto-retry** - `9bbb540` (feat)
3. **Task 3: Test-send confirmation copy describes what the system can observe** - `3356de1` (fix)

**Plan metadata:** (this commit) — docs: complete plan

## Files Created/Modified

- `apps/api/src/modules/send-log/send-log.repository.ts` - `SEND_LOG_STATUSES` widened to 11 members; `COMPUTED_STATUS_SQL` gains the two asymmetric `reconciling`/`unknown` arms
- `apps/api/src/modules/send-log/__tests__/send-log-filters.test.ts` - new test covering all four ambiguous-state render/filter behaviors
- `apps/api/src/modules/analytics/timeline.repository.ts` - one-line `reconciling` arm added to the parallel CASE ladder
- `apps/web/src/features/send-log/api.ts` - `SEND_LOG_STATUS_VALUES` runtime array + widened `SendLogStatus` type
- `apps/web/src/features/send-log/SendLogPage.tsx` - `SEND_STATUS_LABELS`/`SEND_STATUS_CLASSES`/`STATUS_OPTIONS` exported and widened with `reconciling`/`unknown`
- `apps/web/src/features/send-log/__tests__/send-log-status-vocabulary.test.ts` - new, 4 tests (drift, member count, label/class/option completeness, DLV-07 honesty check)
- `apps/worker/src/queues/send-dispatch.ts` - `SendJobResult` gains `unknown`; `kind='test'` branch's `sendMail` call wrapped in classify-and-dispose try/catch
- `apps/worker/src/queues/email-broadcast.worker.ts` - inline processor factored into exported `handleEmailBroadcastJob(job, worker, deps = {})`
- `apps/worker/src/queues/email-triggered.worker.ts` - inline processor factored into exported `handleEmailTriggeredJob(job, worker, deps = {})`
- `apps/worker/src/queues/__tests__/test-send-outcome.test.ts` - new, 7 tests covering every Task 2 `<behavior>` item
- `apps/web/src/features/campaigns/TestSendPanel.tsx` - success toast copy corrected, D-11 guidance added
- `SPECIFICATION.md` - SS6 gains the test-send outcome vocabulary paragraph

## Decisions Made

See `key-decisions` in frontmatter. In short: the web/API vocabulary drift test pins a commented copy rather than cross-importing app source (no package dependency exists between apps/web and apps/api); `timeline.repository.ts` needed only a one-line fix since its `ELSE` already handled `unknown` correctly; the two email Workers were touched despite not being in the plan's `files_modified` list because the plan's own Task 2 action/acceptance criteria required it, and doing so needed a small deps-injection refactor (backward compatible) rather than duplicating branching logic in a test.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `email-broadcast.worker.ts`/`email-triggered.worker.ts` needed a deps-injection seam to satisfy the plan's own Worker-level test requirement**
- **Found during:** Task 2
- **Issue:** The plan's Task 2 `<behavior>` requires "Neither send Worker throws when `processSendJob` returns `{ outcome: "unknown" }`" to be proven by a test, and its `<action>` explicitly requires adding a comment to both Worker files. Both files' processors were anonymous inline closures with no way to inject a fake `sendMail` and no way to invoke them directly from a test -- the plan's own fallback text ("invokes the processor function directly with a fake job") implies they must be invokable.
- **Fix:** Factored each Worker's inline processor into an exported function (`handleEmailBroadcastJob`/`handleEmailTriggeredJob`) accepting an optional `ProcessSendJobDeps` parameter defaulting to `{}`, forwarded to `processSendJob`. Every existing call site (`createEmailBroadcastWorker(connection)`/`createEmailTriggeredWorker(connection)`, used unchanged in `apps/worker/src/server.ts`) behaves byte-identically -- verified by the full 44-file/241-test `apps/worker` suite passing unchanged.
- **Files modified:** `apps/worker/src/queues/email-broadcast.worker.ts`, `apps/worker/src/queues/email-triggered.worker.ts`, `apps/worker/src/queues/__tests__/test-send-outcome.test.ts`
- **Verification:** `npx tsc -p apps/worker/tsconfig.json --noEmit` exits 0; full `apps/worker` suite (44 files, 241 tests) passes; the new Worker-level test asserts `handleEmailBroadcastJob(...)` resolves rather than rejects for an `unknown` outcome.
- **Committed in:** `9bbb540` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (a necessary, plan-anticipated consequence of the plan's own Task 2 action/acceptance-criteria text -- mirrors 11-08's own precedent of touching files not literally in `files_modified` when a plan's `<action>` explicitly requires it).
**Impact on plan:** None beyond the two named Worker files -- no new access path, no scope creep, fully backward-compatible default parameter.

## Issues Encountered

None beyond the deviation above.

## Known Stubs

None.

## Threat Flags

None -- every new surface (the widened `?status=` enum, the ambiguous test-send log line, the `unknown` outcome's non-throwing return) is already covered by this plan's own `<threat_model>` (T-11-10-01 through T-11-10-05), and this plan's tests exercise each one directly:
- T-11-10-01 (send-log computed status repudiation) -- mitigated, proven by the CASE-ladder test asserting an `unknown` row with no facts never renders as `sent`.
- T-11-10-02 (test-send confirmation copy repudiation) -- mitigated, copy corrected; the removed literal string was confirmed absent by direct grep.
- T-11-10-03 (`?status=` query parameter tampering) -- unchanged, already closed by the pre-existing `z.enum(SEND_LOG_STATUSES)` validation + parameterized `= ANY($n::text[])` binding, which automatically widened with the constant (no new code needed, confirmed by the adversarial-injection test still passing).
- T-11-10-04 (test-send retry storm) -- mitigated; the `unknown` outcome returns rather than throws, proven at both the `processSendJob` and the Worker-processor level.
- T-11-10-05 (ambiguous test-send log line information disclosure) -- mitigated; the `scrubbedConsole.warn` call names only `campaignId` and `outcome`, never `testTo`.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The send log now tells a marketer the truth about every state the ledger can hold, and the web/API vocabularies cannot silently drift apart.
- The test-send flow surfaces ambiguity instead of hiding it, and D-11's no-automatic-retry guarantee is proven at both the `processSendJob` and Worker-processor levels.
- Explicitly NOT built here, and owned by named later phases: campaign-card `unknown` stats and dashboard treatment (Phases 13/15, D-13), operator/marketer re-send tooling for lost-but-unproven sends (deferred), and a test-send polling/result-callback surface (deliberately out of scope per this plan's own flagged assumption).
- No stub was left where an architectural decision belongs -- every gap above is a functional omission already named to a specific later phase or explicitly deferred by this plan's own text.

---
*Phase: 11-delivery-correctness*
*Completed: 2026-08-09*

## Self-Check: PASSED

- FOUND: apps/web/src/features/send-log/__tests__/send-log-status-vocabulary.test.ts
- FOUND: apps/worker/src/queues/__tests__/test-send-outcome.test.ts
- FOUND: this SUMMARY.md on disk
- FOUND commit: b406e17 (Task 1)
- FOUND commit: 9bbb540 (Task 2)
- FOUND commit: 3356de1 (Task 3)
