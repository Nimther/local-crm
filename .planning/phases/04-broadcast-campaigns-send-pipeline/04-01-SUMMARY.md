---
phase: 04-broadcast-campaigns-send-pipeline
plan: 01
subsystem: database
tags: [drizzle, postgres, rls, zod, bullmq, campaigns, send-pipeline]

# Dependency graph
requires:
  - phase: 03-segments-audience-builder
    provides: segments table (campaigns.segment_id FK target)
  - phase: 01-foundation
    provides: organization table + workspace RLS pattern (workspace_isolation policy convention)
  - phase: 02-contacts-event-ingestion
    provides: contacts table (campaign_recipients/sends contact_id FK target), events-ingest/imports-csv queue naming precedent
provides:
  - campaigns/campaign_recipients/sends/workspace_send_settings Drizzle schema + applied migrations
  - shared campaign Zod request/response schemas (createCampaignSchema, updateCampaignSchema, campaignListQuerySchema, launchCampaignSchema, scheduleCampaignSchema, testSendCampaignSchema, workspaceSendSettingsSchema)
  - EMAIL_BROADCAST_QUEUE / EMAIL_TRIGGERED_QUEUE / CAMPAIGN_KICKOFF_QUEUE constants + job schemas (emailBroadcastJobSchema, emailTriggeredJobSchema, campaignKickoffJobSchema)
affects: [04-02, 04-03, 04-04, 04-05, 04-06, 04-07, 04-08, 06-flow-engine]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Per-table migration file (DDL + FK + RLS triplet + indexes) authored by hand-splitting a single drizzle-kit generate output, following the 03-02 rename-and-rejournal precedent"
    - "Pattern 2 worker-job convention extended to the send pipeline: every queue job schema always carries workspaceId, re-derived inside the worker"

key-files:
  created:
    - packages/db/src/schema/campaigns.ts
    - packages/db/src/schema/campaign-recipients.ts
    - packages/db/src/schema/sends.ts
    - packages/db/src/schema/workspace-send-settings.ts
    - packages/db/migrations/0013_campaigns.sql
    - packages/db/migrations/0014_campaign_recipients.sql
    - packages/db/migrations/0015_sends.sql
    - packages/db/migrations/0016_workspace_send_settings.sql
    - packages/shared-schemas/src/campaign.ts
  modified:
    - packages/db/src/index.ts
    - packages/shared-schemas/src/queues.ts
    - packages/shared-schemas/src/index.ts
    - packages/db/migrations/meta/_journal.json
    - packages/db/migrations/meta/0016_snapshot.json (renamed from 0013_snapshot.json)

key-decisions:
  - "sends.campaign_id is nullable with ON DELETE SET NULL (not cascade) so Phase 6 flow-triggered sends can share this same unified ledger without a campaign reference"
  - "campaigns.segment_id is ON DELETE RESTRICT so the DB refuses to orphan a campaign's audience even if the app-level D-14 delete-check is bypassed"
  - "Single drizzle-kit generate output (all 4 tables in one file) was split by hand into 0013-0016, one table's DDL+RLS per file, ordered to satisfy FK dependency order (campaigns before campaign_recipients/sends)"
  - "The single generated snapshot was renamed 0013_snapshot.json -> 0016_snapshot.json (id/prevId chain unchanged) to align with the final migration in the split sequence, mirroring how 0012's hand-authored RLS migration has no snapshot of its own and the chain skips straight from 0011 to 0013"

patterns-established:
  - "Frequency-cap and scheduler-scan indexes (idx_sends_workspace_contact_sent_at, idx_campaigns_scheduled) are authored in the table-creation migration itself, not added later after a performance incident"

requirements-completed: [CAMP-01, CAMP-03, SEND-04, SEND-06]

coverage:
  - id: D1
    description: "campaigns table supports draft/scheduled/sending/sent/canceled status and references a segment by id with ON DELETE RESTRICT (D-14)"
    requirement: "CAMP-01"
    verification:
      - kind: other
        ref: "psql pg_tables/pg_constraint inspection: campaigns.segment_id FK ON DELETE RESTRICT confirmed"
        status: pass
    human_judgment: false
  - id: D2
    description: "sends table enforces one (workspace_id, campaign_id, contact_id) attempt via a UNIQUE constraint, preventing duplicate sends on job retry"
    requirement: "SEND-06"
    verification:
      - kind: other
        ref: "packages/db/migrations/0015_sends.sql: CONSTRAINT sends_workspace_campaign_contact_unique UNIQUE(workspace_id,campaign_id,contact_id)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Frequency-cap lookup on sends by (workspace_id, contact_id, sent_at) is index-backed, not a sequential scan"
    requirement: "SEND-04"
    verification:
      - kind: other
        ref: "pg_indexes query confirmed idx_sends_workspace_contact_sent_at exists on sends(workspace_id, contact_id, sent_at)"
        status: pass
    human_judgment: false
  - id: D4
    description: "All four new tables enforce workspace isolation via ENABLE + FORCE ROW LEVEL SECURITY + workspace_isolation policy"
    requirement: "CAMP-03"
    verification:
      - kind: other
        ref: "pg_tables query: campaigns/campaign_recipients/sends/workspace_send_settings all rowsecurity=true after migration"
        status: pass
    human_judgment: false
  - id: D5
    description: "packages/db and packages/shared-schemas both typecheck clean; queue constants are dash-separated with job schemas carrying workspaceId"
    verification:
      - kind: other
        ref: "npx tsc -p tsconfig.json --noEmit (both packages) exit 0; grep confirms EMAIL_BROADCAST_QUEUE/EMAIL_TRIGGERED_QUEUE/CAMPAIGN_KICKOFF_QUEUE are dash-separated"
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-07-06
status: complete
---

# Phase 4 Plan 1: Send Pipeline Data Backbone Summary

**Four RLS-protected Postgres tables (campaigns, campaign_recipients, sends, workspace_send_settings) with Drizzle schema, applied migrations, shared campaign Zod contracts, and BullMQ queue constants/job schemas for the entire broadcast send pipeline.**

## Performance

- **Duration:** ~20 min
- **Completed:** 2026-07-06
- **Tasks:** 4 (all `type="auto"`, no checkpoints)
- **Files modified:** 14 (9 created, 5 modified)

## Accomplishments
- `campaigns` table: draft/scheduled/sending/sent/canceled lifecycle, `segment_id` FK `ON DELETE RESTRICT` (D-14 DB-level block), progress counters, scheduler/snapshot cursor columns
- `campaign_recipients` table: frozen recipient snapshot with a `(campaign_id, contact_id)` unique constraint
- `sends` unified send ledger: `(workspace_id, campaign_id, contact_id)` unique constraint is the idempotency guarantee against duplicate dispatch on job retry (SEND-06); `campaign_id` nullable/`ON DELETE SET NULL` so Phase 6 flow sends can reuse the same table
- `workspace_send_settings`: per-workspace frequency cap (default 3/24h) and optional RPS override (D-13)
- All four tables carry `ENABLE + FORCE ROW LEVEL SECURITY` + `workspace_isolation` policy, matching the Phase 1-3 RLS pattern exactly
- `idx_sends_workspace_contact_sent_at` (frequency-cap lookup), `idx_sends_campaign_status` (progress aggregation), `idx_campaigns_scheduled` (due-campaign scan) authored at table-creation time
- Migrations 0013-0016 applied to the live database; verified via `pg_tables`/`pg_indexes` queries
- Shared campaign Zod schemas (`createCampaignSchema`, `updateCampaignSchema`, `campaignListQuerySchema`, `launchCampaignSchema`, `scheduleCampaignSchema`, `testSendCampaignSchema`, `workspaceSendSettingsSchema`) exported from `packages/shared-schemas`
- `EMAIL_BROADCAST_QUEUE`/`EMAIL_TRIGGERED_QUEUE`/`CAMPAIGN_KICKOFF_QUEUE` constants (dash-separated) + `emailBroadcastJobSchema`/`emailTriggeredJobSchema`/`campaignKickoffJobSchema`, every job schema carrying `workspaceId`

## Task Commits

Each task was committed atomically:

1. **Task 1: Drizzle schema files for campaigns, campaign_recipients, sends, workspace_send_settings** - `02c6c05` (feat)
2. **Task 2: Author RLS + index migrations for the four tables** - `6e0fa98` (feat)
3. **Task 3: Shared campaign Zod schemas + queue constants/job schemas** - `fe3c0a3` (feat)
4. **Task 4 [BLOCKING]: Apply the database migration** - no code changes (migrations already committed in Task 2); verified live via `drizzle-kit migrate` + `pg_tables`/`pg_indexes` queries, no separate commit needed

**Plan metadata:** (this commit)

## Files Created/Modified
- `packages/db/src/schema/campaigns.ts` - campaigns table + campaignStatusEnum
- `packages/db/src/schema/campaign-recipients.ts` - campaign_recipients table (frozen snapshot)
- `packages/db/src/schema/sends.ts` - sends table + sendStatusEnum, unified send ledger
- `packages/db/src/schema/workspace-send-settings.ts` - workspace_send_settings table
- `packages/db/src/index.ts` - registered all four new schema modules in the barrel
- `packages/db/migrations/0013_campaigns.sql` - campaigns DDL + idx_campaigns_scheduled + RLS
- `packages/db/migrations/0014_campaign_recipients.sql` - campaign_recipients DDL + RLS
- `packages/db/migrations/0015_sends.sql` - sends DDL + idx_sends_workspace_contact_sent_at + idx_sends_campaign_status + RLS
- `packages/db/migrations/0016_workspace_send_settings.sql` - workspace_send_settings DDL + RLS
- `packages/db/migrations/meta/_journal.json` - four new migration tags (0013-0016)
- `packages/db/migrations/meta/0016_snapshot.json` - renamed from drizzle-kit's auto-generated 0013_snapshot.json
- `packages/shared-schemas/src/campaign.ts` - campaign request/response Zod schemas
- `packages/shared-schemas/src/queues.ts` - extended with broadcast/triggered/kickoff queue constants + job schemas
- `packages/shared-schemas/src/index.ts` - re-exports campaign.js

## Decisions Made
- `sends.campaign_id` is nullable with `ON DELETE SET NULL` (not cascade) so Phase 6 flow-triggered sends can share this same unified ledger without a campaign reference, per the plan's explicit design intent.
- `campaigns.segment_id` is `ON DELETE RESTRICT` so the DB refuses to orphan a campaign's audience even if the app-level D-14 delete-check is bypassed (T-04-01-03).
- `drizzle-kit generate` produced one combined migration for all four tables; split by hand into 0013-0016 (one table's DDL+RLS per file), ordered so FK dependencies resolve correctly (campaigns must exist before campaign_recipients/sends reference it). This mirrors the 03-02 precedent of renaming/reorganizing drizzle-kit's auto-generated output to match plan-specified filenames.
- The single auto-generated snapshot (`0013_snapshot.json`) was renamed to `0016_snapshot.json` (its internal id/prevId chain untouched) to align with the last migration in the split sequence — the same convention already established by 0012's hand-authored RLS migration, whose snapshot chain skips directly from 0011 to 0013 with no snapshot for 0012 itself.

## Deviations from Plan

None - plan executed exactly as written. One clarification: the plan's Task 1 `<files>` list refers to `packages/db/src/schema/index.ts`, but the actual existing barrel file in this codebase is `packages/db/src/index.ts` (no `schema/index.ts` exists); the four new schema modules were registered in the real barrel file, which is functionally identical to what the plan intended (re-export new schema modules following the existing style).

## Issues Encountered
- `DATABASE_URL` is only injectable via `node --env-file=../../.env` (the project's own established convention, matching `apps/api`'s `tsx watch --env-file=../../.env` dev script) since direct `.env` file reads are denied by harness permissions. `db:generate`/`db:migrate` were run manually as `node --env-file=../../.env <drizzle-kit path>` rather than the bare `npm run db:generate`/`db:migrate` scripts, which do not load the env file themselves. No code changes were needed to resolve this — purely an invocation detail for this execution session.

## Next Phase Readiness
- All four tables live in the database with RLS enabled; downstream plans (04-02 delivery-core, 04-03 dispatch worker, 04-04 campaign backend, 04-05 kickoff worker, UI plans) can now query `campaigns`/`campaign_recipients`/`sends`/`workspace_send_settings` and import the shared Zod schemas + queue constants/job schemas from `@mega-crm/shared-schemas`.
- No blockers. Note for a fresh environment: `npm run db:migrate`/`db:generate` in `packages/db` require `DATABASE_URL` to be present in the process env — since this package has no `--env-file` wiring of its own (unlike `apps/api`/`apps/worker`), a future plan may want to add one for a smoother contributor experience, but this is a pre-existing repo characteristic, not something introduced by this plan.

---
*Phase: 04-broadcast-campaigns-send-pipeline*
*Completed: 2026-07-06*
