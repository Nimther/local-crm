---
phase: 16-live-sendgrid-verification
plan: 04
subsystem: testing
tags: [sendgrid, webhook, signature, replay, dedup, uat, postgres]

# Dependency graph
requires:
  - phase: 16-live-sendgrid-verification
    provides: "16-01's live SendGrid tracer and 16-03's workspace-scoped raw-payload capture seam"
provides:
  - "uat-verify dedup snapshot/compare automation for the exact migration-0057 key and both persistence layers"
  - "scripts/uat-replay.sh byte-exact public-HTTP replay harness with one-byte mutation mode"
  - "A decoded, inspected, genuinely SendGrid-signed UAT payload committed as the permanent Phase 16 fixture"
  - "Live UAT-03/UAT-04 evidence: accepted replay, fail-closed mutation, one send_event, one journal-row delta, unchanged counters"
affects: [16-05-signature-replay-ci, 16-07-uat-report]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Dedup UAT snapshots key journal rows by the captured raw_batch digest, while send_events use exactly (workspace_id, send_id, event_type, occurred_at) from migration 0057"
    - "Replay capture files are strict four-key artifacts whose base64 must be canonical before any request is attempted"

key-files:
  created:
    - scripts/uat-replay.sh
    - scripts/__tests__/uat-replay-script.test.mjs
    - apps/api/src/modules/webhooks/__tests__/fixtures/uat-signed-payload.json
  modified:
    - scripts/uat-verify.mjs
    - scripts/__tests__/uat-verify.test.mjs
    - docs/runbooks/uat-live-sendgrid.md
    - package.json

key-decisions:
  - "The journal delta is scoped to the captured raw_batch digest, not the workspace-wide journal total, so unrelated SendGrid fan-out cannot falsify the replay verdict"
  - "The live fixture was quarantined until its workspace, send, contact, endpoint public key and recipient hash were verified against the current production database/configuration"
  - "The fixture is stored byte-for-byte as captured; no payload byte, signature, timestamp or public key was edited or regenerated"

requirements-completed: [UAT-03, UAT-04]

coverage:
  - id: D1
    description: "Dedup snapshot/compare CLI proves one exact send_event, one captured-batch journal delta and unchanged rollup/campaign counters"
    requirement: "UAT-04"
    verification:
      - kind: unit
        ref: "scripts/__tests__/uat-verify.test.mjs#dedup snapshot and compare"
        status: pass
    human_judgment: false
  - id: D2
    description: "Byte-exact replay harness preserves raw bytes and headers, supports one-byte mutation, and rejects malformed capture artifacts before networking"
    requirement: "UAT-03"
    verification:
      - kind: unit
        ref: "scripts/__tests__/uat-replay-script.test.mjs (dry-run, mutation, validation and no-request cases)"
        status: pass
    human_judgment: false
  - id: D3
    description: "A genuinely signed live delivery was accepted on byte-exact replay, its one-byte mutation was rejected, and the duplicate changed only the expected journal layer"
    requirement: "UAT-03"
    verification:
      - kind: manual_procedural
        ref: "docs/runbooks/uat-live-sendgrid.md#UAT-03/UAT-04; accepted executor checkpoint plus saved dedup-before evidence"
        status: pass
    human_judgment: true
    rationale: "Only SendGrid can produce the account's real signature, and the public TLS/Caddy path plus decoded-recipient inspection require live evidence."
  - id: D4
    description: "The committed fixture contains only the designated throwaway UAT recipient's event and matches the current UAT workspace endpoint key"
    requirement: "UAT-03"
    verification:
      - kind: manual_procedural
        ref: "Plan 16-04 step 8 decode-and-inspect plus tenant-scoped production DB/key verification"
        status: pass
    human_judgment: true
    rationale: "Avoiding permanent third-party data disclosure requires inspecting and attributing the decoded live payload before commit."

# Metrics
duration: "multi-session (checkpoint pause included)"
completed: 2026-08-18
status: complete
---

# Phase 16 Plan 04: Live Signed Replay and Dedup Proof Summary

**A real SendGrid-signed UAT payload now has a strict byte-exact replay path, two-layer dedup proof, fail-closed mutation evidence, and an inspected committed fixture ready for permanent CI coverage.**

## Performance

- **Started:** 2026-08-17T21:11:22+05:00
- **Completed:** 2026-08-18
- **Tasks:** 3 completed (including one blocking live-host checkpoint)
- **Files modified:** 7
- **Latest targeted verification:** 67/67 tests passed

## Accomplishments

- Added `uat-verify dedup` snapshot/compare modes. The verdict requires exactly one `send_events` row for migration 0057's four-column key, exactly one new `ingress_journal` row for the captured raw-batch digest, and byte-identical rollup/campaign counter snapshots.
- Added `scripts/uat-replay.sh`, which writes decoded bytes to a file and sends them without shell interpolation or JSON re-serialization. It can flip exactly one byte for the negative signature check and now rejects missing fields or non-canonical base64 before networking.
- Completed the live gate with the captured `click` event for send `bf8355a4-6df3-5cbd-884e-385d46534d16`: the accepted checkpoint records success for the exact replay and fail-closed rejection for the mutated replay. The saved compare evidence is `sendEventsCount=1`, `ingressJournalBefore=2`, `ingressJournalAfter=3`, `ingressJournalDelta=1`, `rollupUnchanged=true`, `campaignCountersUnchanged=true`, `captureDigestMatches=true`, `passed=true`.
- Retrieved the missing capture from the production VPS, decoded and inspected all 663 bytes, and committed it only after confirming one event, one UAT workspace, one UAT send, one throwaway recipient, and no sibling-workspace or platform-mail data.

## Task Commits

1. **Task 1: dedup subcommand — the two-layer exactly-once assertion**
   - `1ca9b33` test(16-04): add failing tests for uat-verify dedup subcommand
   - `8b28a23` feat(16-04): add uat-verify dedup subcommand
   - `d52e6f1` fix(uat): scope dedup verification to captured batch
2. **Task 2: byte-exact replay harness + runbook**
   - `1de9cc1` feat(16-04): add byte-exact replay harness + runbook sections
   - `3e84c72` test(16-04): reject malformed replay captures
   - `9648b24` fix(uat): fail fast on malformed replay captures
3. **Task 3: live UAT checkpoint and inspected fixture**
   - `28776a3` test(16-04): add inspected live signed payload fixture

## Files Created/Modified

- `scripts/uat-verify.mjs` - `dedup` snapshot/compare collection, digest scoping and verdict output
- `scripts/__tests__/uat-verify.test.mjs` - exact-once, journal-polarity, digest-scope and malformed-snapshot coverage
- `scripts/uat-replay.sh` - byte-exact valid/mutated replay and strict four-field capture validation
- `scripts/__tests__/uat-replay-script.test.mjs` - dry-run, byte mutation, argument and fixture-shape coverage
- `docs/runbooks/uat-live-sendgrid.md` - live extraction, freshness choreography, dedup and mandatory restoration procedure
- `apps/api/src/modules/webhooks/__tests__/fixtures/uat-signed-payload.json` - inspected real signed UAT payload
- `package.json` - `uat:replay` and replay-harness test scripts

## Decisions Made

- **Use the capture digest for journal attribution.** The SendGrid account fans many deliveries into the same deployment, so a workspace-wide journal count is vulnerable to unrelated traffic. `d52e6f1` ties before/after evidence to the exact captured JSON batch while retaining migration 0057's exact key for `send_events`.
- **Treat the earlier workspace ID as stale evidence, not as authority over current production state.** Earlier summaries name `171285c6-a489-46be-9ee9-ba4ed6964356`; the effective production `WEBHOOK_RAW_CAPTURE_WORKSPACE_ID`, the endpoint record/public-key hash, the send/contact tenant ownership and the capture itself all independently identify the current dedicated Phase 16 UAT workspace as `fe8fbbc6-6b25-490b-b3f5-7c739e325c9a`. Plan 16-07 must use the current ID.
- **Keep signed material opaque in documentation.** The summary records safe identifiers, structure and hashes/verdicts, but no recipient address, endpoint path token, signature or public key.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Reject malformed capture artifacts before replay**
- **Found during:** Task 2 review
- **Issue:** The harness originally did not require every four-key field to be non-empty and did not enforce canonical base64, allowing malformed captures to reach the network and produce misleading signature failures.
- **Fix:** Added RED cases for missing `signature`, `timestamp`, `publicKey` and non-canonical `rawBodyBase64`, then added strict preflight validation.
- **Files modified:** `scripts/__tests__/uat-replay-script.test.mjs`, `scripts/uat-replay.sh`
- **Verification:** Combined replay/dedup run passes 67/67 tests.
- **Committed in:** `3e84c72`, `9648b24`

**2. [Rule 1 - Bug] Scope journal verification to the captured batch**
- **Found during:** Task 3 live evidence review
- **Issue:** A workspace-wide journal delta could be changed by unrelated concurrent webhook traffic and falsely fail a correct replay.
- **Fix:** Snapshot/compare now keys journal evidence by the captured raw-batch digest; runbook and tests were updated together.
- **Files modified:** `scripts/uat-verify.mjs`, `scripts/__tests__/uat-verify.test.mjs`, `docs/runbooks/uat-live-sendgrid.md`
- **Verification:** Digest match and journal delta both pass in the saved live compare output; targeted tests pass.
- **Committed in:** `d52e6f1`

---

**Total deviations:** 2 auto-fixed (1 missing critical guard, 1 correctness bug)
**Impact on plan:** Both changes make failure evidence more trustworthy; no scope expansion or dependency addition.

## Issues Encountered

- The required fixture did not exist in the local checkout at the checkpoint. It was recovered from `/tmp/mega-crm-uat16/capture.json` on the production VPS and kept out of the repo until its decoded contents and ownership were verified.
- The capture's workspace differed from the ID recorded in the earlier 16-01/16-02 summaries. The file was temporarily quarantined; current production capture configuration, tenant-scoped database checks, recipient hashing, send ownership and endpoint public-key hashing all agreed that the newer workspace is the dedicated UAT workspace.
- The signed timestamp corresponds to `2026-08-18T05:58:49Z`; the session used the staged freshness-tolerance fallback. The original production setting was restored: `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` is currently unset, so the effective default is 600 seconds.
- Caddy's standard configuration records proxy errors but does not retain successful access logs. The recovery turn therefore did not invent a new historical status record: it relies on the already-accepted checkpoint for the replay/rejection statuses and on the persisted database/digest evidence for ingestion and deduplication.

## Verification

- `npx vitest run --root scripts __tests__/uat-verify.test.mjs __tests__/uat-replay-script.test.mjs` - 67/67 passed
- `npm run check:runbook-coverage` - passed
- `npm run check:root-hygiene` - passed
- `npm run lint` - passed with zero warnings/errors (Node emitted only the existing module-type performance notice)
- Full `SENTRY_DSN_API= SENTRY_DSN_WORKER= npm test` - passed across all workspaces before fixture commit; the fixture is inert until plan 16-05 imports it

## User Setup Required

None. The raw-capture session is complete, the fixture is local and committed, and the temporary timestamp fallback has been restored.

## Next Phase Readiness

- Plan 16-05 is ready: the strict four-key real signed fixture exists on disk and in git.
- The current UAT workspace ID and safe live verdict values above must replace the stale workspace reference in plan 16-07's final report.
- No remaining blocker for autonomous CI replay-test implementation.

## Self-Check: PASSED

- Fixture file exists, is committed, has exactly four required keys and canonical base64.
- Fixture body decoded to 663 bytes and one JSON event; no signed material was edited or re-signed.
- All seven task/deviation commits listed above exist in git history.
- Targeted tests, lint, runbook coverage and root hygiene all exit 0.

---
*Phase: 16-live-sendgrid-verification*
*Completed: 2026-08-18*
