-- GSD 08-05 linter fixture — NOT a real migration, never applied to any database.
-- 08-REVIEW CR-01: the trailing comment on the second line below carries a
-- semicolon of its own. That must not be read as the statement's true
-- terminator, or the required second keyword on the line after never joins
-- the same statement text and this evades detection. No marker precedes it,
-- so this must still be flagged.

ALTER TABLE "campaigns"
  ADD COLUMN "mandatory_note" text -- backfill later; see ticket 42
  NOT NULL;
