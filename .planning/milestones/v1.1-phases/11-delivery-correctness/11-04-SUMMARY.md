---
phase: 11-delivery-correctness
plan: 04
subsystem: delivery
tags: [postgres, uuid, node-crypto, idempotency, vitest, sendgrid]

# Dependency graph
requires:
  - phase: 11-delivery-correctness (plan 11-03)
    provides: "resolveReconcilingSend, the reconciling/unknown status branches in dispatchSendGate/claimFlowSend, and the recordExcluded/recordFlowExcluded NOT IN guards this plan's derived-id inserts run through unchanged"
provides:
  - "packages/delivery-core/src/send-id.ts -- SEND_ID_NAMESPACE, uuidv5(name, namespace), deriveCampaignSendId, deriveFlowSendId: a self-contained RFC 4122 SS4.3 UUIDv5 implementation over node:crypto, with no third-party dependency"
  - "sends.id for kind='campaign'/kind='flow' inserts (dispatchSendGate, recordExcluded, claimFlowSend, recordFlowExcluded) is now a pure function of the send intent -- no gen_random_uuid() remains on any of those four insert sites"
  - "Proof that releaseDispatchClaim's DELETE-then-re-claim cycle reproduces the exact same id for the same intent (apps/worker/src/queues/__tests__/send-id-reclaim.test.ts)"
affects: [11-05, 11-06, 11-07, 11-08, 11-09, 12]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Hand-rolled RFC 4122 primitive over node:crypto instead of a third-party package, following a human decision at a blocking-human package-legitimacy checkpoint -- validated against a published, citable test vector (not self-agreement) precisely because there is no library to trust"
    - "Derivation computed INSIDE each ledger-insert function from parameters it already has, never plumbed through from the caller -- prevents the four insert sites from ever drifting onto different ids for the same intent"

key-files:
  created:
    - packages/delivery-core/src/send-id.ts
    - packages/delivery-core/src/__tests__/send-id.test.ts
    - apps/worker/src/queues/__tests__/send-id-reclaim.test.ts
  modified:
    - packages/delivery-core/src/index.ts
    - packages/delivery-core/src/send-ledger.ts
    - SPECIFICATION.md

key-decisions:
  - "HUMAN DECISION at the Task 0 blocking-human package-legitimacy gate: hand-roll UUIDv5 over node:crypto rather than add the `uuid` npm dependency RESEARCH.md recommended. packages/delivery-core/package.json and package-lock.json are therefore UNCHANGED by this plan, despite both being listed in the plan's files_modified -- an expected, human-directed deviation from the plan's assumption that a dependency would be added, not a failure or an omission."
  - "send-id.test.ts's correctness burden replaces what a trusted library would otherwise have discharged: validated against a published RFC 4122 test vector with stated provenance (Python's uuid module documentation example, uuid.uuid5(uuid.NAMESPACE_DNS, 'python.org') == 886313e1-3b8a-5372-9b90-0c9aee199e5d), not merely self-agreement."
  - "Pre-existing sends rows (inserted before this plan) keep their original random id -- no backfill migration was written or implied by the plan. Determinism is a property of NEW inserts from this change forward, not a retroactive guarantee."
  - "The derivation is computed inside dispatchSendGate/recordExcluded/claimFlowSend/recordFlowExcluded themselves, not passed in by callers -- this is what makes it structurally impossible for the four insert sites to compute different ids for the same intent."

requirements-completed: [DLV-05]

coverage:
  - id: D1
    description: "Deriving the send id twice from the same intent produces the same UUID, and two different intents (campaign or flow) produce different UUIDs"
    requirement: "DLV-05"
    verification:
      - kind: unit
        ref: "packages/delivery-core/src/__tests__/send-id.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "After releaseDispatchClaim deletes a dispatching row, the next claim for the same intent inserts a row with the SAME id -- proven end to end via a 429-then-202 processSendJob cycle leaving exactly one sends row"
    requirement: "DLV-05"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/send-id-reclaim.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "No gen_random_uuid() remains on any campaign/flow ledger insert path; kind='test' sends remain outside the ledger entirely (D-11 unaffected)"
    requirement: "DLV-05"
    verification:
      - kind: other
        ref: "grep -c 'gen_random_uuid()' packages/delivery-core/src/send-ledger.ts (0)"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/send-id-reclaim.test.ts (kind='test' row-count-unchanged case)"
        status: pass
    human_judgment: false

# Metrics
duration: 35min
completed: 2026-08-09
status: complete
---

# Phase 11 Plan 04: Deterministic Send-Intent Id (UUIDv5, Hand-Rolled) Summary

**`sends.id` for campaign and flow sends is now a pure UUIDv5 function of the send intent, hand-rolled over `node:crypto` by human decision (no `uuid` dependency added), closing the release-claim phantom-event correlation hole.**

## Performance

- **Duration:** ~35 min (including the Task 0 gate resolution and continuation)
- **Started:** 2026-08-09 (continuation after human "hand-roll" decision)
- **Completed:** 2026-08-09
- **Tasks:** 2 (Task 0 gate resolved via human decision, no code; Task 1 primitive; Task 2 ledger wiring)
- **Files modified:** 5 (3 created, 2 modified) + SPECIFICATION.md

## Accomplishments

- **Task 0 (gate resolution, no code):** The human reviewed RESEARCH.md's `uuid@14.0.1` package-legitimacy audit and chose "hand-roll" instead of installing the dependency. `packages/delivery-core/package.json` and `package-lock.json` remain byte-for-byte unchanged from before this plan.
- **`send-id.ts`:** A self-contained RFC 4122 SS4.3 UUIDv5 implementation (`SHA-1(namespace || name)` via `node:crypto`'s `createHash("sha1")`, with the version nibble forced to `5` and the variant bits forced to the RFC 4122 pattern). `SEND_ID_NAMESPACE = "6f1c9a3e-5d2b-4f8a-9c17-2e0b7d4a6591"` is a fixed, project-specific, non-RFC-predefined namespace, documented as immutable infrastructure. `deriveCampaignSendId(workspaceId, campaignId, contactId)` and `deriveFlowSendId(workspaceId, flowRunId, nodeId)` key-compose with `campaign:`/`flow:` prefixes so the two intent spaces can never collide.
- **`send-id.test.ts` (15 tests):** Validates the hand-rolled `uuidv5` against a published RFC 4122 test vector with stated provenance (Python's `uuid` module documentation: `uuid.uuid5(uuid.NAMESPACE_DNS, 'python.org') == 886313e1-3b8a-5372-9b90-0c9aee199e5d`) -- confirmed independently before writing the test by re-implementing the algorithm in a throwaway script and cross-checking the output. Also asserts version/variant bits across several inputs, malformed-namespace rejection (throws, does not silently hash truncated bytes), canonical `8-4-4-4-12` lowercase formatting, determinism, injectivity for both derivation functions, and a fully-worked golden vector for `SEND_ID_NAMESPACE` itself (the tripwire against accidental drift).
- **`send-ledger.ts`:** Replaced `gen_random_uuid()` at all four insert sites -- `dispatchSendGate`, `recordExcluded` (campaign, via `deriveCampaignSendId`), `claimFlowSend`, `recordFlowExcluded` (flow, via `deriveFlowSendId`) -- with the derivation computed inside each function from parameters it already receives, bound as an additional SQL parameter rather than interpolated. Extended `releaseDispatchClaim`'s doc comment to explain why its `DELETE` is now provably safe, and extended `dispatchSendGate`'s/`claimFlowSend`'s comments to name the `kind='test'` exemption explicitly.
- **`send-id-reclaim.test.ts` (7 tests, live Postgres+Redis):** Proves a fresh `dispatchSendGate`/`claimFlowSend` claim returns the derived id; proves `releaseDispatchClaim` deletes the row and a subsequent claim for the identical intent returns the SAME id; drives `processSendJob` through a 429-release-then-202-retry cycle and asserts the retried send's id equals the derived id with exactly one `sends` row total; proves `recordExcluded`/`recordFlowExcluded` insert rows whose id matches the claim-gate derivation; proves `kind='test'` still creates zero `sends` rows.
- `SPECIFICATION.md` SS4's `sends` table entry gained a paragraph describing the id-derivation change and a paragraph recording the human hand-roll decision, its rationale, and the RFC test-vector provenance. No new SS2 dependency row, since none was added.

## Task Commits

Each task was committed atomically:

1. **Task 1: Deterministic send-id derivation primitive** - `fcd8192` (feat)
2. **Task 2: Ledger inserts derive the id; release-then-re-claim reproduces it** - `e5750dc` (feat)

_Task 0 resolved via human decision at the checkpoint; no code changes of its own._

## Files Created/Modified

- `packages/delivery-core/src/send-id.ts` - `SEND_ID_NAMESPACE`, `uuidv5`, `deriveCampaignSendId`, `deriveFlowSendId`
- `packages/delivery-core/src/__tests__/send-id.test.ts` - RFC-vector, version/variant, malformed-input, determinism/injectivity, golden-vector tests
- `packages/delivery-core/src/index.ts` - Exports `SEND_ID_NAMESPACE`/`deriveCampaignSendId`/`deriveFlowSendId`
- `packages/delivery-core/src/send-ledger.ts` - Four `gen_random_uuid()` sites replaced with the derivation; doc comments extended
- `apps/worker/src/queues/__tests__/send-id-reclaim.test.ts` - End-to-end release-then-re-claim proof against live Postgres/Redis
- `SPECIFICATION.md` - SS4 `sends` entry gains the id-derivation and hand-roll-decision paragraphs

## Decisions Made

See `key-decisions` in frontmatter. In short: the human chose hand-roll over the `uuid` dependency at the Task 0 gate, so `package.json`/`package-lock.json` are unchanged; the test suite validates against a published, independently-provenanced RFC vector rather than self-agreement, since there is no library here to lean on; pre-existing rows keep their old random ids (no backfill); the derivation lives inside the ledger functions, not plumbed through by callers.

## Deviations from Plan

### Human-directed (not a failure -- explicit continuation instruction)

**1. `uuid` npm dependency NOT installed; `packages/delivery-core/package.json` and `package-lock.json` unchanged**
- **Found during:** Task 0 (package-legitimacy checkpoint, resolved by a prior executor run before this continuation)
- **Context:** The plan's `files_modified` list included both files on the assumption a dependency would be added. The human reviewing RESEARCH.md's `uuid@14.0.1` audit at the blocking-human gate chose "hand-roll" instead.
- **Resolution:** `packages/delivery-core/src/send-id.ts` implements UUIDv5 directly over `node:crypto`. Both files are byte-for-byte unchanged from before this plan (confirmed via `git diff --stat` showing no output for either path).
- **Verification:** `git status --short` shows no changes to either file across both task commits.
- **Committed in:** N/A (nothing to commit -- the absence of a change IS the deviation)

### Auto-fixed Issues

None beyond the human-directed deviation above -- no Rule 1/2/3 auto-fixes were needed.

---

**Total deviations:** 1 human-directed (package choice), 0 auto-fixed.
**Impact on plan:** The plan's correctness requirements (determinism, injectivity, RFC-conformant version/variant bits, correlation-preserving release-then-re-claim) are all met by the hand-rolled implementation and proven by tests with the same rigor a library dependency would have required, per the continuation's explicit correctness requirements.

## Issues Encountered

None. The hand-rolled `uuidv5` was cross-validated against a citable RFC 4122 test vector (Python's `uuid` module documentation) via a throwaway script before being committed to `send-id.test.ts`, confirming the version/variant bit manipulation and SHA-1 input framing are correct on the first attempt.

## User Setup Required

None - no external service configuration required. No new environment variables, no new infrastructure.

## Next Phase Readiness

- `sends.id` for campaign and flow sends is now derivable and stable across the release-claim cycle; the reconciler (11-03) and any future plan reading `custom_args.send_id` can rely on this without change.
- Pre-existing rows (inserted before this plan shipped) still carry their original random ids -- any future work that assumes ALL `sends.id` values are re-derivable from their own row's intent columns must account for this, since no backfill was performed.
- `unknown` terminal resolution and the ~24h/~72h windows (11-07), the stale-`dispatching` sweep (D-08), counter backfill on reconciler resolution, the reconciler health row/watchdog (D-14), and the `AbortController` timeout (DLV-06/D-15) remain unbuilt, each already named to a specific later plan per 11-03's own summary.
- No stub was left where an architectural decision belongs -- the plan's own scope (deterministic id derivation, DLV-05) is fully closed by this plan.

---
*Phase: 11-delivery-correctness*
*Completed: 2026-08-09*

## Self-Check: PASSED

- FOUND: packages/delivery-core/src/send-id.ts
- FOUND: packages/delivery-core/src/__tests__/send-id.test.ts
- FOUND: apps/worker/src/queues/__tests__/send-id-reclaim.test.ts
- FOUND: SEND_ID_NAMESPACE/deriveCampaignSendId/deriveFlowSendId exports in packages/delivery-core/src/index.ts
- FOUND: commit fcd8192 in git log
- FOUND: commit e5750dc in git log
- CONFIRMED: package.json and package-lock.json unchanged (git diff --stat shows no output for either path)
- FOUND: this SUMMARY.md on disk
