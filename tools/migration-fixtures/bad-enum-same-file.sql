-- GSD 08-05 linter fixture — NOT a real migration, never applied to any database.
-- Violation: adds an enum value and then uses that same literal in the same file.
-- Postgres refuses to let a freshly-added enum value be used inside the
-- transaction that added it, and this repo runs each migration file as one
-- client.query(sql) call — so this shape fails at deploy time.
ALTER TYPE "send_status" ADD VALUE 'reconciling';

UPDATE "sends" SET "status" = 'reconciling' WHERE "status" = 'interrupted';
