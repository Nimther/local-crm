-- Phase 20 (TMPL-02, D-05, plan 20-01) -- version: the optimistic-
-- concurrency token for campaigns. Bumped by every write (draft PATCH,
-- launch, schedule, cancel) inside the SAME locked transaction that
-- performs the mutation, so exactly one increment happens per
-- user-initiated action. Application code outside a repository function
-- never writes it. Clients read it from the campaign GET response and
-- echo it back as `expectedVersion` on launch/schedule/test-send; a
-- mismatch inside the FOR UPDATE-locked read-check-write raises
-- CampaignStateError with code `version_conflict`.
--
-- No backfill: DEFAULT 1 means every existing campaign starts at 1.
ALTER TABLE "campaigns" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;

COMMENT ON COLUMN campaigns.version IS
  'TMPL-02/D-05: optimistic-lock token, bumped on every mutation inside the same locked transaction as the write, checked -- not merely bumped -- by the launch/schedule/test-send paths against the client-supplied expectedVersion.';
