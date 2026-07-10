-- 06-01: contact IANA timezone name (validated at the app layer, not the
-- DB) -- used by the flow engine's quiet-hours dispatch-time resolution
-- (D-08/D-09).
ALTER TABLE "contacts" ADD COLUMN "timezone" text;
