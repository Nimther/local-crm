---
phase: 06-flows-triggered-chains
plan: 02
subsystem: api
tags: [zod, drizzle-free-contracts, bullmq, flows, discriminated-union]

# Dependency graph
requires:
  - phase: 03-segment-builder-condition-engine
    provides: isContactInSegment/compileSegmentDefinition pattern this phase's branch/trigger conditions will call (not used directly in this plan, but the shared-package skeleton it mirrors)
  - phase: 04-broadcast-campaigns-send-pipeline
    provides: emailBroadcastJobSchema shape + email-triggered queue reservation that this plan's discriminated-union job schema extends
provides:
  - "@mega-crm/flows-core package: flowDefinitionSchema (5 node types + edges) + validateFlowDefinition (D-17 pure publish validator)"
  - "packages/shared-schemas/src/flow.ts: createFlowSchema, updateFlowDraftSchema, flowListQuerySchema route DTOs"
  - "emailTriggeredJobSchema as a discriminated union with a kind:'flow' variant (flowRunId+nodeId+contactId, no campaignId)"
  - "Flow queue-name constants: FLOW_TRIGGER_EVALUATOR_QUEUE, FLOW_RUN_ADVANCE_QUEUE, FLOW_RECONCILIATION_QUEUE, FLOW_SEGMENT_SWEEP_QUEUE"
  - "flowRunAdvanceJobSchema, flowTriggerCheckJobSchema producer contracts"
affects: [06-03, 06-04, 06-05, 06-06, 06-10, 06-11]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "flows-core: pure, DB-free package skeleton mirroring segments-core (package.json/tsconfig/vitest.config/src/index.ts barrel)"
    - "Zod discriminatedUnion for BullMQ job payloads that vary shape by kind (campaign/test/flow), replacing a flat 'everything optional' schema"

key-files:
  created:
    - packages/flows-core/package.json
    - packages/flows-core/tsconfig.json
    - packages/flows-core/vitest.config.ts
    - packages/flows-core/src/index.ts
    - packages/flows-core/src/flow-definition-schema.ts
    - packages/flows-core/src/flow-validate.ts
    - packages/flows-core/src/__tests__/flow-validate.test.ts
    - packages/shared-schemas/src/flow.ts
  modified:
    - packages/shared-schemas/package.json
    - packages/shared-schemas/src/index.ts
    - packages/shared-schemas/src/queues.ts

key-decisions:
  - "flowDefinitionSchema.nodes is a discriminated union on node.type (trigger/delay/branch/send/exit); delay.delay is itself a nested discriminatedUnion on kind (fixed|wait_until), and branch's two D-13 edges are distinguished by edge.sourceHandle ('yes'|'no'), not a node-level field"
  - "validateFlowDefinition only lints branch nodes REACHABLE from the single trigger node (BFS from trigger) -- an orphan/dead branch that is unreachable is never flagged, matching D-17's explicit 'no v2 linting in v1' scope"
  - "shared-schemas/flow.ts imports flowDefinitionSchema directly from @mega-crm/flows-core (added as a workspace dependency) rather than redeclaring the node/edge shape, so the two packages structurally cannot drift"
  - "emailTriggeredJobSchema's discriminated union keeps the campaign/test variants byte-identical to emailBroadcastJobSchema's existing shape; only the new flow variant departs (flowRunId+nodeId+contactId, no campaignId) -- send-dispatch.ts's existing processSendJob body is untouched by this plan (it still runs emailBroadcastJobSchema.parse(data) internally and only handles kind campaign/test; the kind:'flow' dispatch branch is 06-05's job)"

patterns-established:
  - "Pure/DB-free shared package skeleton (flows-core) for any future engine-contract package: package.json name/main/types/scripts mirrors segments-core exactly, vitest.config.ts is a minimal node-environment config with no DB wiring"

requirements-completed: [FLOW-01, FLOW-02, FLOW-03]

coverage:
  - id: D1
    description: "flowDefinitionSchema parses a well-formed trigger/delay/branch/send/exit node+edge JSON and rejects an unknown node type"
    requirement: "FLOW-01"
    verification:
      - kind: unit
        ref: "packages/flows-core/src/__tests__/flow-validate.test.ts#flowDefinitionSchema -- parsing"
        status: pass
    human_judgment: false
  - id: D2
    description: "validateFlowDefinition returns the three D-17 hard errors (no_trigger, empty_send, branch_missing_exit) for their respective malformed flows, [] for a well-formed flow, and [] for an orphan/dead branch that still satisfies the three hard requirements"
    requirement: "FLOW-02"
    verification:
      - kind: unit
        ref: "packages/flows-core/src/__tests__/flow-validate.test.ts#validateFlowDefinition -- D-17 hard errors"
        status: pass
    human_judgment: false
  - id: D3
    description: "emailTriggeredJobSchema accepts a kind:'flow' variant (flowRunId+nodeId+contactId, no campaignId) alongside the existing campaign/test variants, and shared-schemas/apps/worker/apps/api all build clean against the new discriminated union"
    requirement: "FLOW-03"
    verification:
      - kind: unit
        ref: "npm run build -w packages/shared-schemas && npm run build -w apps/worker (both exit 0)"
        status: pass
      - kind: unit
        ref: "npm run test -w apps/worker (68/68 existing tests still pass, unaffected by the schema shape change)"
        status: pass
    human_judgment: false

duration: 5min
completed: 2026-07-10
status: complete
---

# Phase 6 Plan 2: Flow contracts (definition schema, publish validator, job schema) Summary

**Shared, DB-free flow contracts: a five-node-type Zod schema + pure D-17 publish validator in a new `@mega-crm/flows-core` package, plus route DTOs and a `kind:'flow'` discriminated-union variant on the triggered-send job schema.**

## Performance

- **Duration:** 5 min
- **Started:** 2026-07-10T08:42:19+05:00
- **Completed:** 2026-07-10T08:46:43+05:00
- **Tasks:** 3
- **Files modified:** 12 (8 created, 4 modified)

## Accomplishments
- New `@mega-crm/flows-core` package (mirrors `segments-core`'s skeleton exactly) exporting `flowDefinitionSchema` (trigger/delay/branch/send/exit discriminated union + edges) and inferred `FlowDefinition`/`FlowNode`/`FlowEdge` types
- Pure `validateFlowDefinition` walks a parsed `FlowDefinition` and returns exactly the three D-17 hard errors (`no_trigger`, `empty_send`, `branch_missing_exit`) via RED→GREEN TDD (8/8 tests passing), deliberately NOT linting unreachable/orphan branches (v2 scope)
- `packages/shared-schemas/src/flow.ts`: `createFlowSchema`, `updateFlowDraftSchema` (reentry mode D-06/D-07, quiet-hours mode D-09, exit conditions D-15, reusing `flowDefinitionSchema` from flows-core), `flowListQuerySchema`
- `emailTriggeredJobSchema` replaced with a `z.discriminatedUnion("kind", ...)` carrying campaign/test/flow variants -- the `flow` variant is the type seam 06-03/06-05 will produce/consume
- New flow queue-name constants (hyphen-separated) + `flowRunAdvanceJobSchema`/`flowTriggerCheckJobSchema` producer contracts

## Task Commits

Each task was committed atomically:

1. **Task 1: Scaffold flows-core package + flow-definition Zod schema** - `ac0cccd` (feat)
2. **Task 2: Pure publish validator (TDD, D-17 hard errors)** - `61e44b9` (test, RED) + `01e7e8a` (feat, GREEN)
3. **Task 3: Flow route DTOs + email-triggered discriminated-union job schema** - `5fa88b3` (feat)

**Plan metadata:** (final docs commit follows this SUMMARY)

_Note: Task 2 is a TDD task with two commits (test → feat); no refactor commit was needed._

## Files Created/Modified
- `packages/flows-core/package.json` - New package manifest (name @mega-crm/flows-core, mirrors segments-core)
- `packages/flows-core/tsconfig.json` - Extends tsconfig.base.json, noEmit
- `packages/flows-core/vitest.config.ts` - Minimal node-environment vitest config
- `packages/flows-core/src/index.ts` - Barrel re-exporting flow-definition-schema.ts + flow-validate.ts
- `packages/flows-core/src/flow-definition-schema.ts` - flowDefinitionSchema: trigger/delay/branch/send/exit discriminated union + edges (D-13 yes/no via sourceHandle)
- `packages/flows-core/src/flow-validate.ts` - validateFlowDefinition: pure D-17 hard-error walk (no_trigger, empty_send, branch_missing_exit)
- `packages/flows-core/src/__tests__/flow-validate.test.ts` - 8 TDD test cases covering all five behavior specs + schema parsing
- `packages/shared-schemas/src/flow.ts` - createFlowSchema, updateFlowDraftSchema, flowListQuerySchema route DTOs
- `packages/shared-schemas/package.json` - Added @mega-crm/flows-core workspace dependency
- `packages/shared-schemas/src/index.ts` - Re-exports flow.js
- `packages/shared-schemas/src/queues.ts` - emailTriggeredJobSchema now a discriminated union; added flow queue constants + flowRunAdvanceJobSchema/flowTriggerCheckJobSchema

## Decisions Made
- flowDefinitionSchema.nodes is a discriminated union on `type`; delay's own `delay` field is a nested discriminated union on `kind` (fixed|wait_until); branch's D-13 two-edge requirement is expressed via `edge.sourceHandle` ("yes"|"no"), not a node-level field, keeping the edge schema uniform across all node types
- validateFlowDefinition's branch_missing_exit check only considers branch nodes reachable from the (single) trigger node via BFS -- an orphan/dead branch is structurally excluded from the check rather than requiring a separate "is this branch reachable" guard clause at each call site
- shared-schemas/flow.ts imports `flowDefinitionSchema` directly from `@mega-crm/flows-core` (added as a real workspace dependency) instead of redeclaring the node/edge shape, so the API-boundary schema and the engine's own schema cannot structurally drift
- emailTriggeredJobSchema's `campaign`/`test` variants are kept byte-identical in shape to the existing `emailBroadcastJobSchema` (this plan does not touch `send-dispatch.ts`'s `processSendJob`, which still internally calls `emailBroadcastJobSchema.parse(data)` and only branches on kind campaign/test -- the `kind:'flow'` dispatch branch is explicitly out of scope for this plan, deferred to 06-05 per the plan's own file list)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- First run of the schema-parsing test in Task 2 failed because the test's placeholder `SEGMENT_ID` UUID (`11111111-1111-1111-1111-111111111111`) does not satisfy RFC 4122's variant-nibble requirement that Zod 4's `.uuid()` validator enforces (fourth group's first hex digit must be 8/9/a/b) -- fixed by using a valid v4-shaped UUID (`11111111-1111-4111-8111-111111111111`) in the test fixture. This was a test-fixture bug, not a schema bug; caught immediately by the RED→GREEN loop and fixed before the GREEN commit.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- `@mega-crm/flows-core`'s schema + validator are ready for 06-04 (flow CRUD/publish routes, which re-run `validateFlowDefinition` server-side inside the publish transaction per T-06-02-01) and 06-05 (flow engine worker, which produces/consumes the `kind:'flow'` job variant)
- `updateFlowDraftSchema` covers reentry/quiet-hours/exit-condition fields at the schema level; the actual `flows`/`flow_versions`/`flow_runs` DB tables and repository layer are 06-01's/06-04's responsibility, not this plan's
- No blockers for downstream plans in this wave

---
*Phase: 06-flows-triggered-chains*
*Completed: 2026-07-10*

## Self-Check: PASSED

All 8 created files verified present on disk; all 4 task commit hashes (ac0cccd, 61e44b9, 01e7e8a, 5fa88b3) verified present in git log.
