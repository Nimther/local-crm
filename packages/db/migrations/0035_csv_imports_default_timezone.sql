-- 06-22: CONT-02 + FLOW-05 gap closure. Stores the per-import default IANA
-- timezone applied server-side to any imported row that does not resolve a
-- timezone from a mapped column (mirrors the existing nullable
-- `contacts.timezone` column added in 0029 -- validated at the app layer,
-- never a DB constraint). Absence means "no default chosen".
ALTER TABLE "csv_imports" ADD COLUMN "default_timezone" text;
