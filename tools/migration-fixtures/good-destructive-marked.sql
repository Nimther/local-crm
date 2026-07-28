-- GSD 08-05 linter fixture — NOT a real migration, never applied to any database.
-- The same two statements as bad-destructive-unmarked.sql, each preceded on the
-- IMMEDIATELY prior line by a reason-bearing marker.

-- destructive: legacy_external_id was backfilled into external_ref in 0031 and has been unread since
ALTER TABLE "contacts" DROP COLUMN "legacy_external_id";

-- destructive: contacts is empty in every environment this ships to, so the NOT NULL cannot block
ALTER TABLE "contacts" ADD COLUMN "mandatory_tier" text NOT NULL;
