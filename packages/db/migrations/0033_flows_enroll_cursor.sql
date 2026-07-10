-- 06-08 (D-04): resumable-cursor state for flow-enroll-existing.worker.ts's
-- keyset-paginated batch enroll -- mirrors campaigns.snapshot_cursor
-- (0014_campaign_recipients.sql) exactly. Nullable; NULL means "no batch has
-- run yet for this flow's current enroll-existing pass".
ALTER TABLE "flows" ADD COLUMN "enroll_cursor" uuid;
