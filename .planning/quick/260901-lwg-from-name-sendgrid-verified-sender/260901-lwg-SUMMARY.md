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

duration: ~25min
completed: 2026-09-01
status: complete
---

# Quick Task 260901-lwg: SendGrid Verified Sender From Name Summary

**Campaign test sends and ordinary broadcasts now carry the verified sender's real SendGrid `from_name` through durable campaign state to the final SendGrid v3 payload, while manual senders, legacy rows, and old queued jobs retain the email-only fallback.**

## Performance

- **Duration:** ~25 min
- **Completed:** 2026-09-01T11:02:45Z
- **Tasks:** 3 completed
- **Commits:** 2 source-code commits

## Accomplishments

- Added nullable `campaigns.from_name` via the normal Drizzle schema/generation flow and registered migration `0071` in the repository's migration-tier and metadata checks.
- Preserved SendGrid `from_name` separately from `nickname`, then resolved and atomically persisted email/name for launch, schedule, and test-send preparation.
- Added optional, additive `fromName` to test-send queue payloads without a schema-version bump. Old jobs fall back to the campaign row; ordinary campaign jobs cannot override sender identity from queue data.
- Built exact SendGrid `from: { email, name }` payloads only for non-blank names; null, empty, blank, manual, legacy, and unchanged flow callers continue to emit `from: { email }`.
- Added regressions for mapping, persistence, snapshot immutability, old-job fallback, ordinary campaign dispatch, override rejection, and exact delivery payload shape.

## Task Commits

1. **Task 1: Capture and persist verified sender From Name** — `dd6a6a6e` (`fix(quick-260901-lwg): persist verified sender From Name`)
2. **Task 2: Carry From Name through dispatch and SendGrid payload** — `9bb896cc` (`fix(quick-260901-lwg): send campaign From Name to SendGrid`)
3. **Task 3: Cross-package verification and diff inspection** — no source changes

**Branch:** `codex/fix-campaign-from-name`

Planning artifacts, including this SUMMARY, were intentionally not committed.

## Verification

Passed:

- `npm run test -w packages/db -- src/__tests__/migration-tiers.test.ts src/__tests__/migration-empty-diff.test.ts` — 2 files, 14 tests passed.
- `npm run test -w packages/delivery-core -- src/__tests__/send-mail.test.ts` — 1 file, 18 tests passed.
- `npm run build` — all workspaces passed.
- `npm run lint` — passed with zero lint warnings/errors (Node emitted the repository's existing module-type performance warning).
- `git diff --check d73d183c..HEAD` — passed.
- Final diff inspection confirmed no `nickname` fallback, no required queue field or schema-version bump, no per-recipient verified-sender lookup, and no unrelated product changes.

Blocked by pre-existing migration deadline guard:

- `npm run test:migrations` — exits 1 before DB-backed suites can bootstrap: migration `0038_partition_catchup_and_maintenance_runs.sql` deliberately raises `migration 0038 (partition catch-up) refuses to apply on/after 2026-09-01`. Final result: 25 failed files, 6 passed; 4 failed tests, 72 passed, 187 skipped. The focused `0071` static metadata/tier checks pass independently as recorded above.
- Focused API tests — blocked in suite setup by the same migration `0038` exception; 48 tests skipped. The afterAll `app` errors are secondary to setup aborting before app creation.
- Focused worker test — blocked in suite setup by the same migration `0038` exception; 7 tests skipped. The afterAll pool error is secondary to setup aborting before pool creation.

The guard's cutoff is exactly the current date (`2026-09-01 00:00:00+00`). It is unrelated to this change and explicitly instructs operators not to bypass it without confirming/relocating DEFAULT-partition rows, so migration `0038` was not modified as part of this quick task.

## Deviations from Plan

### Auto-fixed blocking repository convention

- **Found during:** Task 1 migration verification
- **Issue:** A newly generated migration must be classified in `packages/db/src/migration-tiers.ts`, and the static empty-diff test pins the newest snapshot/counts. Without updating these files, `test:migrations` reported `0071_campaign_from_name.sql` as unclassified and its metadata expectations as stale.
- **Fix:** Classified `0071` as auto-reversible and advanced the static journal/snapshot expectations to `0071`.
- **Files:** `packages/db/src/migration-tiers.ts`, `packages/db/src/__tests__/migration-tiers.test.ts`, `packages/db/src/__tests__/migration-empty-diff.test.ts`
- **Commit:** `dd6a6a6e`

## Issues Encountered

- The repository-wide DB-backed gates cannot currently apply the historical migration chain because migration `0038` reached its hard safety deadline on the current date. This is an operational migration issue outside the From Name path; no unsafe bypass or unrelated migration edit was made.

## User Setup Required

None for the From Name feature. Separately, the repository's migration `0038` deadline requires operational review before DB-backed test environments can apply the full migration history again.

## Next Phase Readiness

- Source implementation is committed and ready for parent-agent push/merge/deploy handling.
- Build, lint, delivery-core tests, and new migration static checks are green.
- API/worker/full migration runtime suites should be rerun after the migration `0038` safety guard is resolved through its prescribed operational process.

---
*Quick task: 260901-lwg*
*Completed: 2026-09-01*
