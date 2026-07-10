-- CR-02: unify flows.quiet_hours_mode on the canonical vocabulary
-- ("workspace_default" | "custom" | "disabled") shared by the API/UI
-- shared-schema (packages/shared-schemas/src/flow.ts) and the worker
-- (apps/worker/src/queues/flows). The column previously defaulted to the
-- legacy "inherit" value and the worker only recognized "inherit"/
-- "override"/"disabled" -- a flow saved with the real API/UI value
-- "custom" never matched the worker's "override" branch and silently fell
-- through to the workspace-default window (T-06-13-01).
--
-- Note: `drizzle-kit generate` produced a full-table-recreate diff here
-- (packages/db/migrations/meta/ has no snapshot for the hand-written
-- 0026-0033 migrations, so its stale 0025 baseline redundantly re-derived
-- every table those migrations already created live). This file is
-- hand-written instead, mirroring the same hand-written-migration
-- convention already used for 0026-0033 -- only the actual incremental
-- change is applied against the real database.
ALTER TABLE "flows" ALTER COLUMN quiet_hours_mode SET DEFAULT 'workspace_default';--> statement-breakpoint

-- Data migration: normalize any live rows still carrying a legacy value
-- (written under the old DB default, or via test/fixture rows) to the
-- canonical vocabulary. Real API-created rows already store the canonical
-- values ('workspace_default' | 'custom' | 'disabled') -- these UPDATEs are
-- idempotent and value-scoped, never widening a quiet-hours window
-- (T-06-13-02).
UPDATE "flows" SET quiet_hours_mode = 'workspace_default' WHERE quiet_hours_mode = 'inherit';--> statement-breakpoint
UPDATE "flows" SET quiet_hours_mode = 'custom' WHERE quiet_hours_mode = 'override';
