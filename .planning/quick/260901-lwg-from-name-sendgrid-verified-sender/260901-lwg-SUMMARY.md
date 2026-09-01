---
phase: quick-260901-lwg
plan: 01
subsystem: campaigns
tags: [sendgrid, from-name, campaigns, test-send, worker, drizzle]

requires: []
provides:
  - "Verified sender `from_name` capture and atomic campaign persistence for launch, schedule, and test-send preparation"
  - "Backward-compatible optional test-send `fromName` snapshot with row fallback"
  - "Exact SendGrid `{ email, name }` From payload for named campaign senders and legacy `{ email }` fallback"
affects: [campaign-api, email-broadcast-worker, delivery-core, database]

tech-stack:
  added: []
  patterns:
    - "Persist resolved provider sender identity under the existing campaign lock/version update"
    - "Use additive optional queue snapshots for rolling-deploy compatibility"

key-files:
  created:
    - packages/db/migrations/0071_campaign_from_name.sql
    - packages/db/migrations/meta/0071_snapshot.json
  modified:
    - apps/api/src/modules/tenancy/sendgrid-client.ts
    - apps/api/src/modules/campaigns/sender-resolver.ts
    - apps/api/src/modules/campaigns/campaign.repository.ts
    - apps/api/src/modules/campaigns/campaigns.routes.ts
    - apps/worker/src/queues/send-dispatch.ts
    - packages/delivery-core/src/send-mail.ts
    - packages/shared-schemas/src/queues.ts
    - packages/db/src/schema/campaigns.ts
    - packages/db/src/__tests__/migration-rollback-rehearsal.test.ts

key-decisions:
  - "Map SendGrid `from_name` independently from `nickname`; never use the account/UI nickname as the inbox-visible name"
  - "Manual sender emails resolve with a null From Name, preserving the legacy email-only payload"
  - "Test-send snapshots override email and name independently; old jobs without `fromName` fall back to `campaigns.from_name`"
  - "Ordinary campaign jobs ignore queue sender overrides and use the persisted campaign sender identity"

requirements-completed: [QT-260901-lwg]

coverage:
  - packages/delivery-core/src/__tests__/send-mail.test.ts
  - apps/api/src/modules/tenancy/__tests__/sendgrid-key-connect.test.ts
  - apps/api/src/modules/campaigns/__tests__/sender-resolution.test.ts
  - apps/api/src/modules/campaigns/__tests__/campaigns-routes.test.ts
  - apps/worker/src/queues/__tests__/test-send-template-snapshot.test.ts

duration: ~45min
completed: 2026-09-01
status: complete
---

# Quick Task 260901-lwg: SendGrid Verified Sender From Name Summary

**Campaign test sends and ordinary broadcasts now carry the verified sender's real SendGrid `from_name` through durable campaign state to the final SendGrid v3 payload, while manual senders, legacy rows, and old queued jobs retain the email-only fallback.**

## Performance

- **Duration:** ~45 min
- **Completed:** 2026-09-01T11:23:56Z
- **Tasks:** 3 completed
- **Commits:** 3 source-code commits

## Accomplishments

- Added nullable `campaigns.from_name` via the normal Drizzle schema/generation flow and registered migration `0071` in the repository's migration-tier and metadata checks.
- Preserved SendGrid `from_name` separately from `nickname`, then resolved and atomically persisted email/name for launch, schedule, and test-send preparation.
- Added optional, additive `fromName` to test-send queue payloads without a schema-version bump. Old jobs fall back to the campaign row; ordinary campaign jobs cannot override sender identity from queue data.
- Built exact SendGrid `from: { email, name }` payloads only for non-blank names; null, empty, blank, manual, legacy, and unchanged flow callers continue to emit `from: { email }`.
- Added regressions for mapping, persistence, snapshot immutability, old-job fallback, ordinary campaign dispatch, override rejection, and exact delivery payload shape.
- Registered and rehearsed the exact safe inverse for migration `0071`: drop only `campaigns.from_name`, then roll forward through the production migration runner to an identical schema fingerprint.

## Task Commits

1. **Task 1: Capture and persist verified sender From Name** — `dd6a6a6e` (`fix(quick-260901-lwg): persist verified sender From Name`)
2. **Task 2: Carry From Name through dispatch and SendGrid payload** — `9bb896cc` (`fix(quick-260901-lwg): send campaign From Name to SendGrid`)
3. **Task 3: Register and verify migration `0071` rollback inverse** — `e5c0b4ed` (`test(quick-260901-lwg): register campaign From Name inverse`)

**Branch:** `codex/fix-campaign-from-name`

Planning artifacts, including this SUMMARY, were intentionally not committed.

## Verification

Passed:

- `npm run test -w packages/db -- src/__tests__/migration-tiers.test.ts src/__tests__/migration-empty-diff.test.ts` — 2 files, 14 tests passed.
- `npm run test -w packages/db -- src/__tests__/migration-rollback-rehearsal.test.ts` — 1 file, 1 test passed; revert and production roll-forward produce identical schema fingerprints.
- `npm run test:migrations` — full packages/db suite passed: 31 files, 263 tests passed, 1 skipped.
- `npm run test -w packages/delivery-core -- src/__tests__/send-mail.test.ts` — 1 file, 18 tests passed.
- Focused API tests (`sendgrid-key-connect`, `sender-resolution`, `campaigns-routes`) — 3 files, 48 tests passed.
- Focused worker test (`test-send-template-snapshot`) — 1 file, 7 tests passed.
- `npm run build` — all workspaces passed.
- `npm run lint` — passed with zero lint warnings/errors (Node emitted the repository's existing module-type performance warning).
- `git diff --check d73d183c..HEAD` — passed.
- Final diff inspection confirmed no `nickname` fallback, no required queue field or schema-version bump, no per-recipient verified-sender lookup, and no unrelated product changes.

## Deviations from Plan

### Auto-fixed blocking repository convention

- **Found during:** Task 1 migration verification
- **Issue:** A newly generated migration must be classified in `packages/db/src/migration-tiers.ts`, and the static empty-diff test pins the newest snapshot/counts. Without updating these files, `test:migrations` reported `0071_campaign_from_name.sql` as unclassified and its metadata expectations as stale.
- **Fix:** Classified `0071` as auto-reversible and advanced the static journal/snapshot expectations to `0071`.
- **Files:** `packages/db/src/migration-tiers.ts`, `packages/db/src/__tests__/migration-tiers.test.ts`, `packages/db/src/__tests__/migration-empty-diff.test.ts`
- **Commit:** `dd6a6a6e`

### Auto-fixed missing rollback rehearsal registration

- **Found during:** Follow-up full packages/db verification
- **Issue:** Migration `0071` was correctly classified auto-reversible, but the repository's hand-verified `MIGRATION_INVERSES` registry had no entry for it, so the rollback rehearsal failed closed.
- **Fix:** Added the exact inverse `ALTER TABLE campaigns DROP COLUMN from_name;`; the focused rehearsal now applies the full history, drops only that column, rolls forward with the production runner, and confirms an identical schema fingerprint.
- **File:** `packages/db/src/__tests__/migration-rollback-rehearsal.test.ts`
- **Commit:** `e5c0b4ed`

## Issues Encountered

- Initial DB-backed verification was blocked by migration `0038`'s date guard. After that independent repository issue was resolved on the branch, rerunning the full packages/db suite exposed the missing `0071` inverse registration; this task added the safe inverse and all affected gates now pass.

## User Setup Required

None.

## Next Phase Readiness

- Source implementation is committed and ready for parent-agent push/merge/deploy handling.
- Full packages/db, focused API/worker/delivery-core, workspace build, and lint gates are green.

---
*Quick task: 260901-lwg*
*Completed: 2026-09-01*
