---
phase: 07-analytics-dashboard-send-log
plan: 11
subsystem: ui
tags: [cmdk, react, send-log, gap-closure]

# Dependency graph
requires:
  - phase: 07-analytics-dashboard-send-log
    provides: "CampaignFlowFilter.tsx selector and send-log-filters.ts helpers built in plan 07-10"
provides:
  - "sendTargetItemValue(name, id) pure helper giving cmdk a unique per-id selection identity"
  - "Duplicate-name-safe send-log campaign/flow selector (Task 3 human-verified in browser)"
affects: [07-analytics-dashboard-send-log]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "cmdk CommandItem value derived as `${name} ${id}` (name-prefixed) to keep identity unique while preserving name-substring search"

key-files:
  created: []
  modified:
    - apps/web/src/features/send-log/send-log-filters.ts
    - apps/web/src/features/send-log/CampaignFlowFilter.tsx
    - apps/web/src/features/send-log/__tests__/send-log-filters.test.ts

key-decisions:
  - "sendTargetItemValue joins name and id with a single space (name first) — unique per id, still a substring match for name-based cmdk search"
  - "onSelect closures, Check-icon id comparisons, key props, and the __clear__ item were left untouched — identity fix isolated to the two CommandItem value props"

patterns-established:
  - "cmdk CommandItem value identity: when display names can collide (any 'Дублировать'-style copy action), always append the entity id to the value string, keeping the name as a prefix for search"

requirements-completed: [ANLT-05]

coverage:
  - id: D1
    description: "sendTargetItemValue(name, id) exported from send-log-filters.ts, producing a unique-per-id, name-searchable cmdk identity"
    requirement: "ANLT-05"
    verification:
      - kind: unit
        ref: "apps/web/src/features/send-log/__tests__/send-log-filters.test.ts#sendTargetItemValue"
        status: pass
    human_judgment: false
  - id: D2
    description: "CampaignFlowFilter.tsx wires both campaign and flow CommandItem value props through sendTargetItemValue, so selecting the second of two identically-named campaigns/flows resolves to that entity's own id in the browser"
    requirement: "ANLT-05"
    verification:
      - kind: manual_procedural
        ref: "Task 3 checkpoint:human-verify — user typed 'approved' after confirming URL gains the second entity's own id, Check icon lands on the clicked item, name search still matches both entries, flow path behaves identically, and Очистить clears the filter"
    human_judgment: true
    rationale: "Real in-browser cmdk selection/highlight/keyboard-filter behavior cannot be exercised by a pure-function unit test; this is exactly the scenario VERIFICATION.md flagged as needing human confirmation."

# Metrics
duration: 4min
completed: 2026-07-14
status: complete
---

# Phase 07 Plan 11: Send-log selector cmdk duplicate-name identity fix Summary

**Unique cmdk selection identity (`sendTargetItemValue(name, id)`) closes WR-02 — duplicate-named campaigns/flows in the send-log selector no longer collide on selection, taking Phase 07 from 8/9 to 9/9 verified must-haves.**

## Performance

- **Duration:** 4 min (Tasks 1-2 automated work; Task 3 human-verify checkpoint spanned a separate session)
- **Started:** 2026-07-14T13:51:49Z
- **Completed:** 2026-07-14T15:52:43Z
- **Tasks:** 3 (2 automated + 1 human-verify checkpoint)
- **Files modified:** 3

## Accomplishments
- Added `sendTargetItemValue(name, id)` pure helper (name-prefixed, id-suffixed cmdk identity) with a doc-comment explaining the cmdk `value`-collision root cause
- Wired both the campaign and flow `CommandItem` elements in `CampaignFlowFilter.tsx` to derive their `value` from the new helper, leaving `onSelect`, Check-icon comparisons, `key` props, and the `__clear__` item untouched
- Added a `describe("sendTargetItemValue")` regression block proving distinct ids produce distinct identities under a duplicate name, and that the name remains a searchable prefix
- Human verified in-browser: selecting the second of two identically-named campaigns (and flows) resolves to that entity's own id, Check icon lands correctly, name search ("Осенн") still matches both entries, and «Очистить» clears the filter

## Task Commits

Each task was committed atomically:

1. **Task 1: Add failing regression test for duplicate-name cmdk identity (RED)** - `3c8b1dc` (test)
2. **Task 2: Implement sendTargetItemValue helper and wire both selector items (GREEN)** - `fafa8fb` (feat)
3. **Task 3: Human verification — duplicate-name selection resolves to the correct id** - checkpoint approved by user ("approved"); no code changes

**Plan metadata:** (this commit) `docs(07-11): complete send-log selector duplicate-name gap closure plan`

_Note: This plan followed the plan-level TDD gate (RED then GREEN); see TDD Gate Compliance below._

## Files Created/Modified
- `apps/web/src/features/send-log/send-log-filters.ts` - Added exported `sendTargetItemValue(name, id)` pure helper
- `apps/web/src/features/send-log/CampaignFlowFilter.tsx` - Campaign and flow `CommandItem` `value` props now derive from `sendTargetItemValue`
- `apps/web/src/features/send-log/__tests__/send-log-filters.test.ts` - New `describe("sendTargetItemValue")` regression block (uniqueness, name-prefix search, id-inclusion)

## TDD Gate Compliance

- RED gate: `3c8b1dc` `test(07-11): add failing regression test for cmdk duplicate-name identity collision`
- GREEN gate: `fafa8fb` `feat(07-11): make send-log campaign/flow cmdk selection identity unique per id`
- No REFACTOR commit was needed (implementation was minimal and clean on first pass).

Both required gate commits are present in git log in the correct order — full compliance.

## Decisions Made
- `sendTargetItemValue` joins name and id with a single space (name first) rather than any delimiter — keeps the name a true string-prefix so cmdk's substring filter still matches partial name search, while guaranteeing uniqueness per id.
- Left `onSelect` closures, Check-icon `campaignId === campaign.id` / `flowId === flow.id` comparisons, `key` props, and the `value="__clear__"` action item completely untouched — the fix is isolated to the two `value` props, minimizing blast radius on a previously-verified selector.

## Deviations from Plan

None - plan executed exactly as written. Tasks 1-2 matched the plan's `<action>`/`<behavior>` specs exactly; Task 3's checkpoint was approved by the user with all six verification steps confirmed (second-entry id resolution, Check icon placement, name search on both duplicate entries, identical flow-path behavior, and Очистить clearing the filter).

## Issues Encountered
None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Phase 07 (analytics-dashboard-send-log) now has all 9/9 VERIFICATION.md must-haves verifiable, closing the last outstanding WR-02 gap from 07-REVIEW.md. No further gap-closure plans are pending for this phase; remaining 07-REVIEW.md findings (WR-01, WR-03..WR-08, IN-01..IN-09) were explicitly out of scope for this round and remain tracked separately if/when prioritized.

---
*Phase: 07-analytics-dashboard-send-log*
*Completed: 2026-07-14*

## Self-Check: PASSED
- FOUND: .planning/phases/07-analytics-dashboard-send-log/07-11-SUMMARY.md
- FOUND: 3c8b1dc (git log)
- FOUND: fafa8fb (git log)
- Test suite: 12/12 passing (`npx vitest run src/features/send-log/__tests__/send-log-filters.test.ts`)
- Build: `npm run build -w @mega-crm/web` exits 0
