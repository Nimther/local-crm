---
phase: 07-analytics-dashboard-send-log
plan: 02
subsystem: api+web
tags: [analytics, fastify, drizzle, postgres, union-query, react, timeline]

requires:
  - phase: 07-analytics-dashboard-send-log
    plan: 01
    provides: "subscription_status_history table + sends.open_count/click_count counters"
provides:
  - "registerAnalyticsRoutes aggregator (apps/api/src/modules/analytics/index.ts), single registration point in server.ts for all future Phase 7 analytics routes"
  - "GET /api/workspaces/:slug/contacts/:id/timeline -- tenant-safe UNION ALL contact-activity timeline"
  - "Evolved ContactEventFeed unified timeline UI with record-type filter"
affects: [07-05-send-log, 07-04-dashboard]

tech-stack:
  added: []
  patterns:
    - "UNION ALL across events/sends/subscription_status_history/flow_runs normalized to one {kind, occurredAt, label, detail} row shape, filtered via kind = ANY($n::text[]) in an outer SELECT wrapping the union"
    - "D-06 current-status priority chain (bounced/dropped/spam > clicked > opened > delivered > base status) expressed as a SQL CASE, mirroring @mega-crm/delivery-core's deriveCurrentStatus JS helper"
    - "IDOR double-gate (explicit getContact 404 + RLS) reused verbatim from listContactEvents' T-02-08-01 precedent for a new route"

key-files:
  created:
    - apps/api/src/modules/analytics/index.ts
    - apps/api/src/modules/analytics/timeline.routes.ts
    - apps/api/src/modules/analytics/timeline.repository.ts
    - apps/api/src/modules/analytics/__tests__/contact-timeline.test.ts
  modified:
    - apps/api/src/server.ts
    - apps/web/src/features/contacts/ContactEventFeed.tsx

key-decisions:
  - "The record-type filter's 4 UI values (Всё/События/Письма/Статусы) map to the API's KINDS_BY_TYPE_FILTER, where «Статусы» buckets BOTH status_change and flow_entry_exit kinds together -- the UI-SPEC copywriting contract defines exactly 4 filter values for what is structurally 4 underlying timeline kinds, so status_change and flow_entry_exit share one filter bucket rather than getting a 5th filter value"
  - "The send row's exclusion_reason/bounce_reason/drop_reason are folded into one 'reason' detail field selected by the same CASE priority as status, rather than three separate optional fields, keeping the client-side rendering branch-free"
  - "occurred_at for a flow_entry_exit row is the run's entered_at (not exited_at) -- exit info (exitedAt/exitReason) travels inside detail so a still-active run still sorts correctly by its entry time"

requirements-completed: [ANLT-03]

coverage:
  - id: D1
    description: "Timeline endpoint unions events + sends + subscription_status_history + flow_runs into one {kind, occurredAt, label, detail} shape, sorted occurredAt DESC, paginated"
    requirement: "ANLT-03"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/analytics/__tests__/contact-timeline.test.ts#returns a union of events + sends + status changes, sorted newest-first, with ×N collapse from open_count/click_count"
        status: pass
    human_judgment: false
  - id: D2
    description: "Send row's current status is computed via the D-06 priority chain in SQL (bounced/dropped/spam > clicked > opened > delivered > base status), with the bounce/drop/exclusion reason surfaced"
    requirement: "ANLT-03"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/analytics/__tests__/contact-timeline.test.ts#collapses a bounced send's status via the D-06 priority chain, not opened/clicked facts"
        status: pass
    human_judgment: false
  - id: D3
    description: "Repeated opens/clicks collapse to a single send row with ×N (open_count/click_count), never a per-row send_events COUNT(*) subquery"
    requirement: "ANLT-03"
    verification:
      - kind: static
        ref: "grep -c 'COUNT(*) FROM send_events' apps/api/src/modules/analytics/timeline.repository.ts == 0"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/analytics/__tests__/contact-timeline.test.ts (sendRow.detail matches { status: 'clicked', openCount: 5, clickCount: 3 })"
        status: pass
    human_judgment: false
  - id: D4
    description: "Cross-workspace contact id 404s (IDOR double-gate), never an empty 200"
    requirement: "ANLT-03"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/analytics/__tests__/contact-timeline.test.ts#404s for a contact id belonging to another workspace (IDOR double-gate)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Record-type filter (all/events/emails/statuses) narrows the returned kinds server-side"
    requirement: "ANLT-03"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/analytics/__tests__/contact-timeline.test.ts#the type filter narrows to a single kind (emails)"
        status: pass
    human_judgment: false
  - id: D6
    description: "ContactEventFeed reads the new timeline endpoint, renders all 4 row kinds, offers the record-type Select filter (no tabs), and shows the unified empty state"
    requirement: "ANLT-03"
    verification:
      - kind: unit
        ref: "npm run build -w apps/web (tsc --noEmit + vite build, clean); acceptance greps for /timeline, Всё/Статусы, Активности пока нет all match"
        status: pass
    human_judgment: true

duration: 20min
completed: 2026-07-14
status: complete
---

# Phase 7 Plan 2: Contact Activity Timeline Summary

**UNION ALL contact-timeline endpoint (events + sends + subscription-status changes + flow entries/exits) behind a new analytics module, with ContactEventFeed evolved into a unified, record-type-filterable timeline UI**

## Performance

- **Duration:** ~20 min
- **Completed:** 2026-07-14
- **Tasks:** 2 (both completed)
- **Files modified:** 6 (4 created, 2 modified)

## Accomplishments

- New `apps/api/src/modules/analytics/` module: `registerAnalyticsRoutes` aggregator (`index.ts`) registered once in `server.ts`, the single future registration point for the phase's remaining analytics/dashboard/send-log routes
- `timeline.repository.ts`'s `listContactTimeline` runs one UNION ALL query across `events`, `sends`, `subscription_status_history`, and `flow_runs`, normalizing every source into `{ kind, occurredAt, label, detail }`, newest-first, offset/limit paginated
- The send branch computes its current status via a SQL `CASE` mirroring `@mega-crm/delivery-core`'s `deriveCurrentStatus` D-06 priority chain (bounced/dropped/spam > clicked > opened > delivered > base status, with `excluded` taking top priority), and reads `open_count`/`click_count` directly (O(1) per row) rather than a per-row `send_events` aggregate -- satisfying D-11's «×N» collapse for free
- `GET /api/workspaces/:slug/contacts/:id/timeline` enforces the same IDOR double-gate as `listContactEvents` (explicit `getContact` existence check 404s a foreign-workspace contact id, RLS underneath as defense-in-depth) and accepts an `all|events|emails|statuses` type filter validated by a local zod schema
- `ContactEventFeed` evolved from an events-only feed into the full unified timeline: event rows keep the expandable JSON `Collapsible`; send rows show a status badge (reusing the UI-SPEC's 3-hue send-status vocabulary) plus «×N» repeat opens/clicks and the bounce/drop/exclusion reason; status-change rows show `{old} → {new}` with a human-readable source label; flow entry/exit rows show entry (and exit + reason, once the run has exited) -- all behind a single `Select` record-type filter (no separate tabs), with the unified «Активности пока нет» empty state

## Task Commits

Each task was committed atomically:

1. **Task 1: analytics module + contact-timeline UNION repository + route** - `4e900fe` (test, RED) then `385a360` (feat, GREEN)
2. **Task 2: Evolve ContactEventFeed into the unified timeline UI with a record-type filter** - `91ff153` (feat)

**Plan metadata:** (this commit)

## Files Created/Modified

- `apps/api/src/modules/analytics/index.ts` - `registerAnalyticsRoutes` aggregator
- `apps/api/src/modules/analytics/timeline.routes.ts` - `GET .../contacts/:id/timeline`, IDOR double-gate, zod query validation
- `apps/api/src/modules/analytics/timeline.repository.ts` - `listContactTimeline`'s UNION ALL query
- `apps/api/src/modules/analytics/__tests__/contact-timeline.test.ts` - union shape/sort, ×N collapse, D-06 status priority, IDOR 404, type filter
- `apps/api/src/server.ts` - registers `registerAnalyticsRoutes` once
- `apps/web/src/features/contacts/ContactEventFeed.tsx` - evolved into the unified timeline UI with the record-type filter

## Decisions Made

- The record-type filter's 4 UI values map to the API's `KINDS_BY_TYPE_FILTER`, where «Статусы» buckets BOTH `status_change` and `flow_entry_exit` kinds together, since the UI-SPEC's copywriting contract defines exactly 4 filter values for 4 underlying timeline kinds.
- The send row's `exclusion_reason`/`bounce_reason`/`drop_reason` are folded into one `reason` detail field selected by the same CASE priority as `status`, keeping the client-side rendering branch-free (one `if (reason)` check rather than three).
- `occurred_at` for a `flow_entry_exit` row is the run's `entered_at` (not `exited_at`) -- exit info travels inside `detail` so a still-active run still sorts correctly by its entry time, and an exited run's timeline position reflects when the contact entered the flow, not when they left it.

## Deviations from Plan

None - plan executed as written.

## Issues Encountered

None.

## User Setup Required

None.

## Next Phase Readiness

- `registerAnalyticsRoutes` is the established registration point for 07-04 (dashboard) and 07-05 (send-log) routes to add to.
- No blockers identified for downstream plans in this phase.

---
*Phase: 07-analytics-dashboard-send-log*
*Completed: 2026-07-14*

## Self-Check: PASSED

All created files verified present on disk; all three task commit hashes (`4e900fe`, `385a360`, `91ff153`) verified present in git history.
