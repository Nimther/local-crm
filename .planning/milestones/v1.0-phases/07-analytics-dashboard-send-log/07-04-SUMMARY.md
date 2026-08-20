---
phase: 07-analytics-dashboard-send-log
plan: 04
subsystem: api+web
tags: [analytics, fastify, drizzle, postgres, xyflow, tanstack-table, react]

requires:
  - phase: 07-analytics-dashboard-send-log
    plan: 02
    provides: "registerAnalyticsRoutes aggregator (apps/api/src/modules/analytics/index.ts)"
provides:
  - "getFlowNodeAnalytics(flowId) repository -- per-node_id distinct-contact pass counts + send-node delivery counts, aggregated across ALL flow versions"
  - "GET /api/workspaces/:slug/flows/:id/analytics -- tenant-safe flow-analytics endpoint (IDOR double-gate)"
  - "FlowAnalyticsTable -- sortable «Аналитика» comparison tab on FlowDetailPage"
  - "FlowCanvas/nodeTypes.tsx read-only per-node metric badge overlay, driven by the same analytics response"
affects: [07-05-send-log]

tech-stack:
  added: []
  patterns:
    - "GROUP BY node_id over flow_run_steps JOIN flow_runs (scoped by flow_runs.flow_id, not flow_version_id) aggregates a node_id across every published version of a flow, including nodes removed from the live definition (D-05)"
    - "COUNT(DISTINCT contact_id) as the per-node pass-count grain -- a contact re-entering and passing through the same node twice contributes 1, never 2 (Pitfall 4)"
    - "One GET /flows/:id/analytics response, keyed by nodeId, drives both a TanStack Table comparison tab and a canvas node badge overlay via a shared TanStack Query cache entry"

key-files:
  created:
    - apps/api/src/modules/analytics/flow-analytics.repository.ts
    - apps/api/src/modules/analytics/flow-analytics.routes.ts
    - apps/api/src/modules/analytics/__tests__/flow-node-analytics.test.ts
    - apps/web/src/features/flows/detail/FlowAnalyticsTable.tsx
  modified:
    - apps/api/src/modules/analytics/index.ts
    - apps/web/src/features/flows/api.ts
    - apps/web/src/features/flows/detail/FlowDetailPage.tsx
    - apps/web/src/features/flows/canvas/nodeTypes.tsx
    - apps/web/src/features/flows/canvas/FlowCanvas.tsx

key-decisions:
  - "getFlowNodeAnalytics runs two separate queries (node-visit aggregation + send-node delivery aggregation) joined in application code by nodeId, rather than one query with a LEFT JOIN to sends -- keeps the COUNT(DISTINCT contact_id) grain isolated from the send-fact COUNT(*) FILTER aggregation, avoiding any fan-out double-counting risk between flow_run_steps and sends"
  - "The metrics badge overlay is threaded through CanvasNodeData as an optional field (metrics?: CanvasNodeMetrics | null), mirroring the existing invalidMessage pattern -- FlowCanvas computes a nodeId-keyed Map from the analytics response and injects it into displayNodes, so nodeTypes.tsx's NodeShell stays a pure presentational component with no data-fetching of its own"
  - "FlowDetailPage fetches the analytics response once (useFlowAnalytics) and passes it to FlowCanvas as a metrics prop for the canvas tab; FlowAnalyticsTable independently calls the same hook for its own tab -- both resolve to the same TanStack Query cache entry (identical query key), so only one network request happens regardless of which tab is active"

requirements-completed: [ANLT-02]

coverage:
  - id: D1
    description: "getFlowNodeAnalytics aggregates flow_run_steps by node_id across ALL flow versions (via the flow_runs.flow_id join, not flow_version_id) using COUNT(DISTINCT contact_id) so a re-entering contact counts once, not twice"
    requirement: "ANLT-02"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/analytics/__tests__/flow-node-analytics.test.ts#aggregates per node_id across versions with COUNT(DISTINCT contact_id), and send-node delivery counts"
        status: pass
    human_judgment: false
  - id: D2
    description: "A node_id shared across two published flow versions is aggregated into one row, including a node_id since removed from the live definition (D-05)"
    requirement: "ANLT-02"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/analytics/__tests__/flow-node-analytics.test.ts#aggregates a node_id shared across two flow versions (D-05), including nodes removed from the live version"
        status: pass
    human_judgment: false
  - id: D3
    description: "Send-node rows carry sent/delivered/opened/clicked/bounced counts from a sends join on (flow_run_id, node_id); the flow-analytics endpoint 404s for a flow id in another workspace (IDOR double-gate)"
    requirement: "ANLT-02"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/analytics/__tests__/flow-node-analytics.test.ts#404s for a flow id belonging to another workspace (IDOR double-gate)"
        status: pass
      - kind: static
        ref: "grep -i 'count(distinct' apps/api/src/modules/analytics/flow-analytics.repository.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "FlowDetailPage has a fourth «Аналитика» tab (FlowAnalyticsTable) listing per-node metrics, sortable, with nodes removed from the live version still listed, a «Данных пока нет» empty state, and a send-log deep link"
    requirement: "ANLT-02"
    verification:
      - kind: unit
        ref: "npm run build -w apps/web (tsc --noEmit + vite build, clean); acceptance greps for Аналитика/analytics/прошли/metrics all match"
        status: pass
    human_judgment: true
    rationale: "Visual placement, badge styling, and tooltip readability on the live canvas were not exercised by an automated E2E/screenshot check in this plan -- carried to phase-level UAT alongside the phase's other deferred visual checks"
  - id: D5
    description: "FlowCanvas node badges (metrics prop on NodeShell/nodeTypes.tsx) show a read-only «{count} прошли» overlay for every node type, plus a delivered% sub-badge for send nodes, driven by the same GET /flows/:id/analytics response as the table tab"
    requirement: "ANLT-02"
    verification:
      - kind: unit
        ref: "npm run build -w apps/web (tsc --noEmit + vite build, clean); acceptance greps for прошли/metrics in nodeTypes.tsx match"
        status: pass
    human_judgment: true
    rationale: "Badge overlay positioning/legibility over the actual xyflow canvas (zoom levels, overlapping nodes) requires visual human verification -- carried to phase-level UAT"

duration: 25min
completed: 2026-07-14
status: complete
---

# Phase 7 Plan 4: Flow-Step Analytics Summary

**Per-flow-node metrics endpoint (COUNT(DISTINCT contact_id) across all versions, send-node delivery counts) surfaced as both read-only canvas badges and a sortable «Аналитика» comparison table**

## Performance

- **Duration:** ~25 min
- **Completed:** 2026-07-14
- **Tasks:** 2 (both completed)
- **Files modified:** 9 (4 created, 5 modified)

## Accomplishments

- New `getFlowNodeAnalytics(flowId)` repository: `flow_run_steps JOIN flow_runs` grouped by `node_id`, scoped by `flow_runs.flow_id` (not `flow_version_id`) so a node_id shared across every published version of a flow is aggregated into one row -- including a node_id since removed from the live definition (D-05). Pass count is `COUNT(DISTINCT contact_id)`, never a raw `COUNT(*)`, so a contact re-entering and passing through the same node twice contributes 1 to the count (Pitfall 4, test-pinned)
- Send-node rows additionally carry `sent`/`delivered`/`opened`/`clicked`/`bounced` from a second query joining `sends` on `(flow_run_id, node_id)`, merged into the node-visit rows by `nodeId` in application code
- `GET /api/workspaces/:slug/flows/:id/analytics` registered inside `registerAnalyticsRoutes`, member-readable, with the same IDOR double-gate pattern as `flows.routes.ts` (`getFlow(id)` existence check 404s a foreign-workspace flow id)
- `FlowAnalyticsTable`: a sortable TanStack Table tab (fourth «Аналитика» tab on `FlowDetailPage`) listing every node's type, distinct-contact «прошли» count, and for send nodes the delivery funnel with computed rates (`computeRate`), a «Данных пока нет» empty state, and a «Смотреть в журнале отправок» link pre-filtered by `flowId`
- `nodeTypes.tsx`'s `NodeShell` gained an optional `metrics` prop rendering a read-only badge overlay (`{count} прошли` for every node type, plus a delivered% sub-badge for send nodes) with a hover tooltip matching the UI-SPEC's `«{count} прошли · {rate}% доставлено»` format; `FlowCanvas` threads the same `GET /flows/:id/analytics` response (keyed by `nodeId`) into each node's data alongside the existing `invalidMessage` injection

## Task Commits

Each task was committed atomically:

1. **Task 1: Flow-analytics repository + route** - `35d3cb9` (test, RED) then `892e335` (feat, GREEN)
2. **Task 2: FlowAnalyticsTable tab + FlowCanvas node metric badges** - `f7cb9e9` (feat)

**Plan metadata:** (this commit)

## Files Created/Modified

- `apps/api/src/modules/analytics/flow-analytics.repository.ts` - `getFlowNodeAnalytics` (node-visit + send-fact aggregation)
- `apps/api/src/modules/analytics/flow-analytics.routes.ts` - `GET .../flows/:id/analytics`, IDOR double-gate
- `apps/api/src/modules/analytics/__tests__/flow-node-analytics.test.ts` - distinct-contact/re-entry, cross-version aggregation, send-node counts, IDOR 404
- `apps/api/src/modules/analytics/index.ts` - registers `registerFlowAnalyticsRoutes`
- `apps/web/src/features/flows/api.ts` - `FlowNodeAnalyticsResponse`, `getFlowAnalytics`, `useFlowAnalytics`
- `apps/web/src/features/flows/detail/FlowAnalyticsTable.tsx` - new sortable comparison tab
- `apps/web/src/features/flows/detail/FlowDetailPage.tsx` - fourth «Аналитика» tab, threads `metrics` into `FlowCanvas`
- `apps/web/src/features/flows/canvas/nodeTypes.tsx` - `CanvasNodeMetrics` type, `MetricsBadge`, `NodeShell` `metrics` prop
- `apps/web/src/features/flows/canvas/FlowCanvas.tsx` - `metrics` prop, nodeId-keyed `Map` injected into `displayNodes`

## Decisions Made

- `getFlowNodeAnalytics` runs two separate queries (node-visit aggregation + send-node delivery aggregation) joined by `nodeId` in application code, rather than one query with a `LEFT JOIN` to `sends` -- keeps the `COUNT(DISTINCT contact_id)` grain isolated from the send-fact `COUNT(*) FILTER` aggregation, avoiding any fan-out double-counting risk between `flow_run_steps` and `sends`.
- The metrics badge overlay is threaded through `CanvasNodeData` as an optional field (`metrics?: CanvasNodeMetrics | null`), mirroring the existing `invalidMessage` pattern -- `FlowCanvas` computes a `nodeId`-keyed `Map` from the analytics response and injects it into `displayNodes`, so `nodeTypes.tsx`'s `NodeShell` stays a pure presentational component with no data-fetching of its own.
- `FlowDetailPage` fetches the analytics response once (`useFlowAnalytics`) and passes it to `FlowCanvas` as a `metrics` prop for the canvas tab; `FlowAnalyticsTable` independently calls the same hook for its own tab -- both resolve to the same TanStack Query cache entry (identical query key), so only one network request happens regardless of which tab is active.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `GET /api/workspaces/:slug/flows/:id/analytics` is available for 07-05 (send-log)'s `?flow=` deep link, which this plan's `FlowAnalyticsTable` already links into.
- Two visual/placement items deferred to phase-level UAT (per `human_verify_mode: end-of-phase`): the «Аналитика» tab's table layout on a live flow, and the canvas node badge overlay's legibility/positioning at various zoom levels.
- No blockers identified for downstream plans in this phase.

---
*Phase: 07-analytics-dashboard-send-log*
*Completed: 2026-07-14*

## Self-Check: PASSED

All created files verified present on disk; all three task commit hashes (`35d3cb9`, `892e335`, `f7cb9e9`) verified present in git history.
