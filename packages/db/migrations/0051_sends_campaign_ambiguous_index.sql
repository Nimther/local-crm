-- Phase 11 (D-12, plan 11-08) -- index backing tryCompleteCampaign's new
-- ambiguous-row subquery: `SELECT count(*) FROM sends WHERE campaign_id =
-- $1 AND status IN ('reconciling', 'unknown')`. tryCompleteCampaign runs on
-- EVERY terminal write (every sent/failed record), so an unindexed subquery
-- here would become a per-send sequential scan over the whole `sends` table
-- the moment a campaign accumulates any real send volume.
--
-- A dedicated index, not a reuse of an existing one: `sends_status_queued_at_idx`
-- (0049) leads with `status`, not `campaign_id`; `sends_workspace_campaign_contact_unique`'s
-- leading column is `workspace_id`, not `campaign_id` either -- neither can
-- serve a campaign_id-only lookup efficiently.
--
-- References the enum literals 'reconciling'/'unknown' added in migrations
-- 0047/0048 -- separate, earlier deploys, so this satisfies the
-- enum-add-value-used-same-file linter rule (this file adds no enum value
-- of its own, only reads two already-committed ones).
CREATE INDEX sends_campaign_ambiguous_idx ON sends (campaign_id)
  WHERE status IN ('reconciling', 'unknown');

COMMENT ON INDEX sends_campaign_ambiguous_idx IS
  'Backs tryCompleteCampaign''s ambiguous-row subquery (Phase 11 D-12) -- a campaign whose last outstanding recipient is reconciling/unknown must still be able to complete without a per-send sequential scan.';
