---
phase: 16-live-sendgrid-verification
plan: 05
subsystem: testing
tags: [sendgrid, webhook, ecdsa, fixture, fastify, bullmq, postgres, dedup]

# Dependency graph
requires:
  - phase: 16-live-sendgrid-verification
    provides: "16-04's decoded, inspected and committed real SendGrid-signed four-key fixture"
provides:
  - "Permanent CI fixture-integrity guard that fails hard when the live artifact is absent or malformed"
  - "Real-account ECDSA replay through the complete Fastify raw-body route with frozen signed time"
  - "One-byte and wrong-valid-key fail-closed regression cases with zero rejected-request ingestion"
  - "End-to-end duplicate proof: two HTTP deliveries, two journal/queue entries, production processor results [1,0], one migration-0057 send_events row"
affects: [16-07-uat-report, webhook-signature-regression, send-events-dedup]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Permanent signed fixtures freeze Date at the captured header timestamp instead of weakening WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS"
    - "Cross-service integration tests may dynamically load the exact production worker processor at runtime while keeping apps/api's TypeScript rootDir/build boundary intact"

key-files:
  created:
    - apps/api/src/modules/webhooks/__tests__/webhooks-signature-replay.test.ts
    - apps/api/src/modules/webhooks/__tests__/fixtures/README.md
  modified: []

key-decisions:
  - "Import the fixture unconditionally and validate its exact four-key/canonical-base64/JSON-array/numeric-timestamp contract; absence must fail collection"
  - "Freeze Date tightly around every request and around downstream event-bound classification; never set a freshness-tolerance override"
  - "Seed the signed body's exact send_id in each fresh test tenant and process the two real BullMQ payloads with processWebhookEventBatch so the send_events assertion exercises production dedup rather than observing an inert route"

requirements-completed: [UAT-03, UAT-04]

coverage:
  - id: D1
    description: "The real signed fixture is mandatory, structurally validated and documented with provenance/replacement rules"
    requirement: "UAT-03"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/webhooks/__tests__/webhooks-signature-replay.test.ts#real SendGrid signed replay fixture integrity (4 cases)"
        status: pass
      - kind: other
        ref: "Temporary fixture rename makes the suite exit non-zero; restoration returns it to green"
        status: pass
    human_judgment: false
  - id: D2
    description: "Captured bytes and headers are accepted through the real raw-body HTTP route, while one changed byte and a different valid public key are rejected with zero ingestion"
    requirement: "UAT-03"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/webhooks/__tests__/webhooks-signature-replay.test.ts#POST /webhooks/sendgrid/:pathToken real signed replay"
        status: pass
    human_judgment: false
  - id: D3
    description: "Two identical accepted HTTP deliveries reach journal and enqueue twice but production processing inserts the exact dedup key once"
    requirement: "UAT-04"
    verification:
      - kind: integration
        ref: "webhooks-signature-replay.test.ts#enqueues two identical deliveries but retains one exact send_events dedup row"
        status: pass
    human_judgment: false
  - id: D4
    description: "The permanent test remains fresh without changing signed bytes or weakening the timestamp tolerance"
    requirement: "UAT-03"
    verification:
      - kind: other
        ref: "Frozen-Date code path plus grep proving no WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS assignment"
        status: pass
    human_judgment: false

# Metrics
duration: 11min
completed: 2026-08-18
status: complete
---

# Phase 16 Plan 05: Permanent Real-Signature Replay CI Summary

**The live Phase 16 capture is now a mandatory 8-case regression suite proving real-account signature acceptance, two independent rejection paths, and downstream exactly-once persistence without weakening freshness.**

## Performance

- **Duration:** ~11 min
- **Started:** 2026-08-18T13:56:21+05:00
- **Completed:** 2026-08-18T14:07+05:00
- **Tasks:** 2 completed (Task 2 RED -> GREEN)
- **Files modified:** 2

## Accomplishments

- Added four fixture-integrity cases using an unconditional JSON import: exact four non-empty fields, canonical base64, JSON event-array shape and numeric signed timestamp. Temporarily removing the fixture makes the suite fail before behavior can be skipped.
- Added four full-stack behavior cases using the exact 663 captured bytes: captured key accepts with 200; one changed byte rejects with 400 and writes neither journal nor queue; a different valid ECDSA key rejects with 400; two exact deliveries both return 200.
- Proved both dedup layers non-vacuously. The duplicate case records two `ingress_journal` rows and two workspace-scoped `webhookEventsQueue.add` calls, feeds those real job payloads through `processWebhookEventBatch`, observes insertion results `[1,0]`, then queries exactly `(workspace_id, send_id, event_type, occurred_at)` and finds one row.
- Added a fixture README recording production/UAT provenance, the plan 16-04 inspection gate, signature portability across endpoint URLs, and the mandatory recapture/no-edit/no-resign replacement procedure without exposing an address or credential.

## Task Commits

1. **Task 1: Fixture integrity guard + fixture README**
   - `a0caa2c` test(16-05): guard live signed replay fixture
2. **Task 2: Full-HTTP-stack replay test — accept, reject, deduplicate**
   - `9668c74` test(16-05): add failing real signed replay assertions
   - `2df1bf8` test(16-05): process real replay through downstream dedup

Task 2's RED was genuine and targeted: 7/8 cases passed, while the downstream assertion failed with `expected 0 to be 1` because the HTTP route correctly stops after journal + enqueue. The GREEN commit then drove the two emitted queue payloads through the production processor.

## Files Created/Modified

- `apps/api/src/modules/webhooks/__tests__/webhooks-signature-replay.test.ts` - mandatory fixture guards and real signed accept/reject/dedup integration coverage
- `apps/api/src/modules/webhooks/__tests__/fixtures/README.md` - safe fixture provenance and replacement contract

## Decisions Made

- **Freeze Date, never tolerance.** `postCaptured()` fakes only `Date` at the signed header instant and restores real time in `finally`. Downstream processing gets the same scoped freeze because `classifyOccurredAt` independently bounds event time; no test assignment to `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` exists.
- **Use a different valid key for the second negative case.** Reusing SendGrid's published ECDSA public key proves the verifier rejects a genuine-but-wrong key, rather than merely catching malformed ASN.1.
- **Preserve the captured send ID and run the real worker processor.** Signed bytes cannot be rewritten. The test seeds that exact UUID in its isolated tenant, then dynamically imports `apps/worker/src/queues/webhook-events.worker.ts` via `import.meta.url`. The dynamic boundary keeps `npm run build -w apps/api` green without copying processor behavior or widening `rootDir`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Make downstream dedup assertion executable rather than vacuous**
- **Found during:** Task 2 RED run
- **Issue:** The HTTP route only journals and enqueues; no worker runs in an API test process. A direct `send_events` query therefore correctly returned zero. In addition, a fresh tenant lacks the immutable fixture `send_id`, so the production worker would classify it as an orphan and null it, preventing the four-column non-null unique key from being exercised.
- **Fix:** Seeded the fixture's derived send UUID in the isolated test tenant, selected the two workspace-scoped real queue jobs, and invoked the exported production `processWebhookEventBatch` for each under the same frozen event time before querying the exact dedup key.
- **Files modified:** `apps/api/src/modules/webhooks/__tests__/webhooks-signature-replay.test.ts`
- **Verification:** Processor returns one insert then one conflict (`[1,0]` after sorting); queue and journal counts are 2; exact send_events count is 1; API TypeScript build passes.
- **Committed in:** `2df1bf8`

---

**Total deviations:** 1 auto-fixed (1 missing critical test bridge)
**Impact on plan:** The implementation stays within the planned test file and exercises more production code than a mock would; no runtime source, schema or dependency changed.

## Issues Encountered

- The first sandboxed Vitest attempt could not reach local PostgreSQL (`EPERM`). Re-running the same integration command with the approved local-service permission succeeded; no source workaround was introduced.
- The first dynamic worker path was resolved relative to Vitest's project root and pointed at `/worker`. Converting it to a file URL based on `import.meta.url` made resolution stable in both Vitest source execution and the emitted API build.
- ESLint flagged destructuring a method-shaped processor type as a possible unbound method. The interface now declares an arrow-function property, matching the export's actual no-`this` contract.

## Verification

- New suite: 8/8 passed
- Existing `webhooks-signature.test.ts`: 7/7 passed
- Fixture temporarily absent: expected RED confirmed; restored suite green
- `npm run build -w apps/api`: passed
- `npm run lint`: passed
- `npm run check:root-hygiene`: passed
- `SENTRY_DSN_API= SENTRY_DSN_WORKER= npm test`: passed across every workspace
  - API: 553/553
  - Web: 84/84
  - Worker: 645/645
  - DB: 224 passed, 2 skipped
  - All remaining package suites passed

## User Setup Required

None. The test uses the already inspected committed fixture and isolated local/CI services; it performs no external SendGrid request.

## Next Phase Readiness

- UAT-03/UAT-04 now have both one-time live evidence (16-04) and permanent CI evidence (16-05).
- Plan 16-07 can cite the 8-case suite and the confirmed fixture-absence RED behavior in the final audit report.
- Plan 16-06 remains the next execution item for UAT-05 fault injection.

## Self-Check: PASSED

- Both new files exist and are tracked.
- All three plan commits exist in git history.
- No skip helper, try/catch around fixture import, fixture credential, recipient address, or freshness-tolerance assignment was added.
- Targeted, build, lint, hygiene and full-workspace tests all exit 0.

---
*Phase: 16-live-sendgrid-verification*
*Completed: 2026-08-18*
