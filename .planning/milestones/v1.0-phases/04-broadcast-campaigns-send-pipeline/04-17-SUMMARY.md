---
phase: 04-broadcast-campaigns-send-pipeline
plan: 17
subsystem: api
tags: [sendgrid, worker, bullmq, vitest, react, ux-copy]

requires:
  - phase: 04-broadcast-campaigns-send-pipeline
    provides: processSendJob's kind='test' dispatch branch (04-04), the kind='campaign' >=400 -> failed disposition (04-12), and the test-send sample-data endpoint/panel (04-08)
provides:
  - kind='test' branch in send-dispatch.ts now returns outcome 'failed' (not 'sent') for any SendGrid >=400 response, mirroring the kind='campaign' branch
  - a regression test pinning SEND-07 for the test-send path
  - TestSendPanel.tsx copy clarifying the auto-filled JSON is sample data from a real segment contact
affects: [04-UAT, phase-04 verification]

tech-stack:
  added: []
  patterns:
    - "kind='test' and kind='campaign' dispatch branches in send-dispatch.ts now agree on the same >=400 -> failed disposition -- no divergent 4xx handling between the two send sources"

key-files:
  created: []
  modified:
    - apps/worker/src/queues/send-dispatch.ts
    - apps/worker/src/queues/__tests__/send-dispatch-durability.test.ts
    - apps/web/src/features/campaigns/TestSendPanel.tsx

key-decisions:
  - "test-send 4xx guard placed after the existing 429/5xx check and before the final sent return, returning { outcome: 'failed', sendId } with no ledger write (D-12: the test path never inserts a sends row)"
  - "Sample-data clarification is a single muted helper paragraph directly under the dynamic_template_data label, not a CardDescription rewrite -- keeps the recipient input and JSON block visually distinct"

requirements-completed: [SEND-07, CAMP-04]

coverage:
  - id: D1
    description: "A test send whose SendGrid call returns a non-retryable 4xx (400/401/403/413) is reported as outcome 'failed', not silently swallowed as 'sent'"
    requirement: "SEND-07"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/send-dispatch-durability.test.ts#SEND-07: a test-send 4xx is reported failed, never sent"
        status: pass
    human_judgment: false
  - id: D2
    description: "The test-send panel labels the auto-filled dynamic_template_data JSON as sample data from a real segment contact, distinct from the typed recipient address"
    requirement: "CAMP-04"
    verification:
      - kind: other
        ref: "npm run build -w @mega-crm/web (typecheck+build) and grep for clarifying copy in TestSendPanel.tsx"
        status: pass
    human_judgment: true
    rationale: "Copy clarity is a UX judgment call -- automated checks confirm the text exists and the build is clean, but whether it reads as clear/self-explanatory to a marketer needs human eyes at phase UAT re-run."

duration: 8min
completed: 2026-07-06
status: complete
---

# Phase 04 Plan 17: Test-send 4xx observability + sample-data copy clarification Summary

**Closed the last two non-env items from the UAT Test 4 diagnosis: a test send rejected by SendGrid with a 4xx now reports `outcome: "failed"` instead of a false "sent", and the test-send panel now labels its auto-filled JSON as sample data from a real segment contact.**

## Performance

- **Duration:** 8 min
- **Started:** 2026-07-06T19:44:00Z
- **Completed:** 2026-07-06T19:52:40Z
- **Tasks:** 2 completed
- **Files modified:** 3

## Accomplishments
- `apps/worker/src/queues/send-dispatch.ts`'s `kind='test'` branch now returns `{ outcome: "failed", sendId }` for any SendGrid response `>= 400`, mirroring the `kind='campaign'` branch's existing disposition (~line 333) — the two branches no longer diverge on 4xx handling.
- Added a regression test (`SEND-07: a test-send 4xx is reported failed, never sent`) to `send-dispatch-durability.test.ts`, reusing the suite's existing fixtures (`freshWorkspaceId`, `connectFixtureSendgridKey`, `createFixtureCampaign`, `countingSendMail`) and asserting both the outcome and a single SendGrid call.
- `TestSendPanel.tsx` now shows a one-sentence Russian helper line under the `dynamic_template_data` label explaining the JSON is sample data from a real segment contact and that only the «Получатель» field controls delivery — closing the as-designed "wrong email" complaint (D-18/D-19) as self-explanatory behavior.

## Task Commits

Each task was committed atomically:

1. **Task 1: Surface SendGrid 4xx on a test send as failed (mirror the campaign branch) + regression test** - `690971b` (fix)
2. **Task 2: Clarify the test-send panel sample-data copy** - `7231bda` (docs)

**Plan metadata:** (this commit, following SUMMARY.md creation)

## Files Created/Modified
- `apps/worker/src/queues/send-dispatch.ts` - kind='test' branch gained a `response.status >= 400 -> { outcome: "failed", sendId }` guard, placed after the existing 429/5xx check
- `apps/worker/src/queues/__tests__/send-dispatch-durability.test.ts` - new regression test pinning the SEND-07 test-send 4xx disposition
- `apps/web/src/features/campaigns/TestSendPanel.tsx` - added a muted helper paragraph under the `dynamic_template_data` label clarifying the JSON is sample data from a real segment contact

## Decisions Made
- The 4xx guard in the test branch returns no ledger write (the test path skips the sends-table insert entirely per D-12) — only the returned `outcome` value changes, from a false `"sent"` to `"failed"`.
- Sample-data clarification placed as its own `<p className="text-sm text-muted-foreground">` directly under the JSON label rather than folded into the panel's top-level `CardDescription`, so it visually associates with the JSON block specifically (not the whole panel, which also contains the unrelated recipient input).

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
Both non-env items from the UAT Test 4 diagnosis (`.planning/debug/test-send-no-delivery.md`) are now closed at the code level. The env root cause itself was already fixed in 04-16. Recommend a phase UAT re-run of Test 4 (send a test to a misconfigured sender/template) to confirm the full end-to-end fix, since this plan's D2 deliverable is marked `human_judgment: true` pending that re-run.

---
*Phase: 04-broadcast-campaigns-send-pipeline*
*Completed: 2026-07-06*

## Self-Check: PASSED

All created/modified files confirmed present on disk; both task commits (690971b, 7231bda) confirmed in git log.
