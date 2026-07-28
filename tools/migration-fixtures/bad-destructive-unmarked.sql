-- GSD 08-05 linter fixture — NOT a real migration, never applied to any database.
-- Two separate violations, on deliberately well-separated lines so the
-- line-number assertions are unambiguous.

ALTER TABLE "contacts" DROP COLUMN "legacy_external_id";

-- (padding so the two violations are not adjacent)

ALTER TABLE "contacts" ADD COLUMN "mandatory_tier" text NOT NULL;
