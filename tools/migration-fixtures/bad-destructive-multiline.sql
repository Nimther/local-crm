-- GSD 08-05 linter fixture — NOT a real migration, never applied to any database.
-- 08-REVIEW WR-02: the destructive statement below is wrapped across several
-- lines, so its two required keywords never share one physical line.
-- No marker precedes it, so this must still be flagged.

ALTER TABLE "campaigns"
  ADD COLUMN "mandatory_note" text
  NOT NULL;
